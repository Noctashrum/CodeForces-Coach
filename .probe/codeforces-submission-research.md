# Codeforces Submission-Record Acquisition — Research Report

**Scope:** how a local Windows Electron app (Node ≥ 18, zero runtime deps) can obtain a user's Codeforces contest submission record **including source code and timing data**, to power a post-contest review (赛后复盘) feature.

**Method note / limitation:** Findings are split into **VERIFIED** (I actually executed the request in this session and quote the response) and **UNVERIFIED / third-party** (from docs, libraries, or scrapers, not re-tested here). My shell/subprocess tooling died partway through this session (`subprocess-local: Windows Job runner exited with exit code 1`), which killed read-only `pwsh`, `glob`, and `grep`. Everything under VERIFIED was captured *before* that failure. I could not complete the final end-to-end DOM assertion — flagged explicitly in §3.

---

## (b) The headline answer: is source code available from the API?

## **NO.** The Codeforces API never returns source code.

**VERIFIED, by direct inspection.** I fetched `https://codeforces.com/api/user.status?handle=tourist&from=1&count=2` and received this exact submission object:

```json
{"id":390885111,"contestId":920,"creationTimeSeconds":1789534560,
 "relativeTimeSeconds":2147483647,
 "problem":{"contestId":920,"index":"F","name":"SUM and REPLACE","type":"PROGRAMMING",
            "rating":2000,"tags":["brute force","data structures","dsu","number theory"]},
 "author":{"contestId":920,"participantId":185403612,"members":[{"handle":"tourist"}],
           "participantType":"PRACTICE","ghost":false,"startTimeSeconds":1517582100},
 "programmingLanguage":"C++23 (GCC 14-64, msys2)","verdict":"OK","testset":"TESTS",
 "passedTestCount":78,"timeConsumedMillis":562,"memoryConsumedBytes":17100800}
```

There is **no `source`, `code`, `solution`, or `program` field anywhere in the object graph.** The complete key set is exactly the 13 fields above (plus `points` on `problem` where applicable). Corroborated by the third-party [Pipeworx `user_status` schema](https://pipeworx.io/docs/reference/codeforces/user_status/), whose full JSON Schema for the submission object lists the same 12–13 fields and no source field, and by the [official API docs](https://codeforces.com/apiHelp/objects) (blocked by Cloudflare for me; the object reference page is `/apiHelp/objects`).

**Consequence for the design:** the API gives you the *submission index* (ids, problem, verdict, timing, memory, language) but the **source code must come from the HTML website**, which means Cloudflare must be defeated. This is the architectural crux of the feature.

---

## (a) API endpoints and fields

Base: `https://codeforces.com/api/`. No auth needed for the endpoints below. **VERIFIED: the `/api/` path is not Cloudflare-challenged** — every API call in this session returned HTTP 200 with `cf-mitigated` empty, including from plain `Invoke-WebRequest` with **no User-Agent at all**.

| Endpoint | Exact URL | Required params | Optional params | What you get |
|---|---|---|---|---|
| `user.status` | `https://codeforces.com/api/user.status?handle={handle}&from=1&count=100` | `handle` | `from` (1-based, default 1), `count` (default 50, max 10000) | Submission list, newest first — **the core call for 赛后复盘** |
| `contest.status` | `https://codeforces.com/api/contest.status?contestId={id}&from=1&count=100` | `contestId` | `handle`, `from`, `count` | All submissions in a contest (any author) |
| `contest.standings` | `https://codeforces.com/api/contest.standings?contestId={id}&from=1&count=100` | `contestId` | `from`+`count`, `handles`, `room`, `showUnofficial`, `participantTypes`, `asManager` | Rank/score table. **VERIFIED: `contestId` alone returns HTTP 400** — you must supply a param set |
| `user.rating` | `https://codeforces.com/api/user.rating?handle={handle}` | `handle` | — | Rating-change history |
| `contest.list` | `https://codeforces.com/api/contest.list?gym=false` | — | `gym` (`false` = regular, `true` = gym) | Contest catalog with phase/timing |

### Exact field lists (VERIFIED from live responses)

**Submission object** (`user.status`, `contest.status`):
```
id, contestId, creationTimeSeconds, relativeTimeSeconds,
problem{ contestId, index, name, type, points?, rating?, tags[] },
author{ contestId, participantId, members[{handle}], participantType, ghost, startTimeSeconds },
programmingLanguage, verdict, testset, passedTestCount,
timeConsumedMillis, memoryConsumedBytes
```
> ⚠️ Correction to a common assumption: **`points` is not a submission field.** It appears on the nested `problem` object (VERIFIED: present as `"points":2500.0` on the contest-1401 submission, absent on the 920 one). Don't read `submission.points`.

**Timing data you get (this is what makes the API indispensable):**
- `creationTimeSeconds` — absolute Unix timestamp. VERIFIED: observed values like `1789534560`.
- `relativeTimeSeconds` — offset from contest start; `2147483647` (`INT32_MAX`) means *practice/out-of-contest*, not "very late". VERIFIED: every practice submission returned exactly `2147483647`.
- `timeConsumedMillis` / `memoryConsumedBytes` — per-test runtime/memory of the judged submission.

**Rating-change object** (`user.rating`) — VERIFIED:
```
contestId, contestName, handle, rank, ratingUpdateTimeSeconds, oldRating, newRating
```
**Contest object** (`contest.list`) — VERIFIED:
```
id, name, type, phase, frozen, durationSeconds, startTimeSeconds, relativeTimeSeconds
```

**VERIFIED live probes:** `user.status` → 200; `contest.status` (contestId=4) → 200; `user.rating` → 200 (51911 bytes); `contest.list` → 200 (409042 bytes); `contest.standings` without `from`/`count` → **400**.

---

## (2) Getting source code from the website

### URL shapes — VERIFIED behaviour

| URL | VERIFIED result |
|---|---|
| `https://codeforces.com/submissions/{handle}` | **HTTP 200**, title `Personal submissions - Codeforces`, 182622 bytes in real Chromium |
| `https://codeforces.com/contest/{id}/my` | **HTTP 200**, title `Status - Codeforces Beta Round 4 (Div. 2 Only)`, 84580 bytes |
| `https://codeforces.com/problemset/status/{id}/problem/{index}` | **HTTP 200**, title `Status - Codeforces`, 172319 bytes |
| `https://codeforces.com/contest/{id}/submission/{sid}` | **302 → `https://codeforces.com/` (homepage)** for the ids I tried |

⚠️ **Important caveat on the redirect finding.** Both `contest/{id}/submission/{sid}` and `problemset/submission/{id}/{sid}` redirected to the homepage for ids `100000` and `392102836` (contest 4). Contest 4 is "Codeforces Beta Round 4" from 2010; these are very likely **non-existent or purged** submission ids rather than a login wall — a 404 in Codeforces' idiom is a redirect to `/`. **I could not re-test with a definitively fresh submission id because my shell died.** Do not conclude from my data that submission pages require login. The three list pages above all worked *without login*, which is the load-bearing evidence that anonymous access to the submissions index works.

### DOM shape

**VERIFIED-equivalent** from a working scraper, [`viky08/Codeforces-Hacker/hack.py`](https://github.com/viky08/Codeforces-Hacker/blob/master/hack.py) — its source constants decode to:

```python
SUBMISSION_URL = 'http://codeforces.com/contest/{ContestId}/submission/{SubmissionId}'
SOURCE_CODE_BEGIN = 'prettyprint lang-'     # matched as bytes inside the page
# then: start = page.find('<pre class="prettyprint program-source" style="padding: 0.5em;">')
#       end   = page.find('</pre>', start)
```
It also finds per-row links via `soup.findAll('a', {'class': 'view-source'})` on the status page and verdict cells via `soup.findAll('span', {'class': 'verdict-accepted'})`. This is contemporaneous evidence for:
- the **status-page row selector `a.view-source`** (the link to each submission),
- the **source container `<pre class="prettyprint program-source" style="padding: 0.5em;">`**,
- the language marker class `prettyprint lang-{...}`,
- the **contest-scoped status URL** `http://codeforces.com/contest/{id}/status/{index}/page/{n}?order=BY_ARRIVED_DESC` (the `?order=` param, and it works on `/status/` pages).

**UNVERIFIED — the `id="program-source-text"` attribute.** I believe the modern page is `<pre id="program-source-text" class="prettyprint program-source" ...>` and I wrote the probe to assert exactly that, but **the assertion never ran on a real submission page** (my only `#program-source-text` checks returned `false`, on pages that were the homepage, and my "hasPre" list-page checks were a crude substring test for `program-source-text`, not an id lookup). Treat the `id` as **highly likely but not verified here**. The robust selector strategy is therefore: **`#program-source-text` first, fall back to `pre.program-source.prettyprint`** — the class-based form is the one with real third-party evidence.

### Rules / restrictions

- **Whose submissions can you view:** public submissions of any user are viewable without login — this is what `{handle}`-scoped and contest status pages are for. Third-party Codeforces discussion ([view someone's code](https://codeforces.com/blog/entry/923), [Source Code Viewing](https://codeforces.com/blog/entry/211)) frames source visibility as generally open for public contests. **I did not verify the logged-out source view end-to-end** (see caveat above) — verify this yourself with one fresh submission.
- **Running contest:** Codeforces hides/locks source during a running contest ("Why are Solutions for this contest hidden" — [blog/entry/86005](https://codeforces.com/blog/entry/86005)); expect `Source: N/A` or a hidden message until the hacking phase ends.
- **Gym contests:** private/gym submissions require coach mode or group membership — [View solutions in GYM contests](https://codeforces.com/blog/entry/15691), [Gym's submissions](https://codeforces.com/blog/entry/104086).
- **Known current breakage:** there are recent Codeforces reports of source showing **`Source: N/A` for all submissions** — [blog/entry/154919](https://codeforces.com/blog/entry/154919), [blog/entry/145305](https://codeforces.com/blog/entry/145305), [blog/entry/156513](https://codeforces.com/blog/entry/156513). This is a real, recent operational risk: even a correct scraper can get N/A. Design the UI to degrade gracefully.

### Cloudflare — VERIFIED behaviour matrix

| Target | Plain HTTP client result |
|---|---|
| `https://codeforces.com/contest/4/submission/100000` | **403, `cf-mitigated: challenge`, `server: cloudflare`** (same with a Chrome UA) |
| `https://codeforces.com/problemset` | 403 + `cf-mitigated: challenge` |
| `https://codeforces.com/submissions/tourist` | 403 + `cf-mitigated: challenge` |
| `https://codeforces.com/data/submitSource` | **403, `cf-mitigated:` empty** (non-challenge block) |
| `https://codeforces.com/` (root) | **200**, `server: cloudflare`, 179559 bytes |
| `https://codeforces.com/api/user.status...` | **200**, no challenge, **no User-Agent required** |
| `https://m1.codeforces.com/...` | **200 from nginx — but NOT the content**: a custom JS interstitial, *"Please wait. Your browser is being checked."* |
| `https://m2.codeforces.com/...` | 403 + `cf-mitigated: challenge` |
| `https://mirror.codeforces.com/...` | does not resolve |
| `https://cf-problemset.herokuapp.com/contest/4/A/` | connection timeout |

**Headless Chromium fails; non-headless succeeds. VERIFIED:**
- `msedge --headless=new --dump-dom https://codeforces.com/contest/4/submission/100000` → page title **`请稍候…`** (Cloudflare interstitial). Headless is detected.
- Launching Edge **non-headless** with `--remote-debugging-port=9333` and driving it over CDP: the interstitial (`请稍候…`) persisted ~13 s, then navigated to the real site and `document.title === "Codeforces"` with **209,128 bytes** of DOM. Subsequent `fetch()` calls from inside that page context returned **200** for `/submissions/tourist`, `/contest/4/my`, and `/problemset/status/4/problem/A`.

**This is the decisive result:** your embedded/real Chromium defeats Cloudflare; a plain Node HTTP client cannot. Note Cloudflare's non-challenge 403 on `/data/submitSource` — that path is not a viable bypass.

### Is there an unauthenticated, Cloudflare-free route to source code? — **No, not one I could verify.**

| Candidate | Verdict |
|---|---|
| `codeforces.com/data/submitSource` | **VERIFIED 403** (blocked, not challenged). Not a route. |
| `m1.codeforces.com` | **VERIFIED not Cloudflare-free** — it runs its own JS proof-of-work challenge (a SHA-1 `_0x`-obfuscated script that brute-forces a nonce until the digest starts with a target prefix, then sets a cookie and reloads). Real browser required; no free lunch. |
| `m2.codeforces.com` | **VERIFIED Cloudflare-challenged (403).** |
| `mirror.codeforces.com` | **VERIFIED does not resolve.** |
| `cf-problemset.herokuapp.com` | **VERIFIED connection timeout** (likely dead). |
| `codeforces.ml` | **VERIFIED does not resolve.** |
| Third-party CF API mirrors | Found one in search results — [`anonymous.rbtree.workers.dev/apiHelp/methods`](https://anonymous.rbtree.workers.dev/apiHelp/methods) (proxies the **docs**, Cloudflare-fronted itself). **UNVERIFIED** whether any mirror exposes source code; a JSON API mirror cannot, since the upstream API has no source field. |
| API + scraping combo | This is the **only** route that works — but "scraping" must go through real Chromium, not HTTP. |

**Bottom line:** there is no unauthenticated, Cloudflare-free route to source code. The API is Cloudflare-free but has no source; the HTML has source but is behind Cloudflare. **The embedded browser is not an optimization — it is the only viable transport.**

---

## (c) Recommended extraction recipe

**Two-phase: API for the index, Chromium DOM for the source. Never scrape the index — the API is free, exact, and unblocked.**

### Phase 1 — index via API (plain Node `fetch`, no deps, no Cloudflare)

```
GET https://codeforces.com/api/user.status?handle={handle}&from=1&count=10000
```
Page with `from += count` until fewer than `count` results return (cap `count` at 10000). Filter to the contest of interest with `contestId === {id}`. This yields for every submission: `id`, `problem.index`, `verdict`, `programmingLanguage`, `creationTimeSeconds`, `relativeTimeSeconds`, `timeConsumedMillis`, `memoryConsumedBytes`, `passedTestCount`. **All timing data lives here — you never need to scrape it.** Politeness: sleep ≥2 s between pages (see §(3)).

### Phase 2 — source via the embedded Chromium, one submission at a time

For each submission id from Phase 1 (only those with `verdict === "OK"` or a user-selected subset, to bound the work):

1. Navigate the embedded browser to `https://codeforces.com/contest/{contestId}/submission/{id}`.
   - If `contestId` is absent (problemset-only submission) use `https://codeforces.com/problemset/submission/{contestId}/{id}`.
   - **Detect the redirect-to-homepage case**: if `location.pathname === "/"` after load, the submission page does not exist/is not viewable — record `sourceUnavailable` and continue. (This is exactly the failure I saw; make it a first-class state, not an exception.)
2. Read the source from the **rendered DOM** (after Cloudflare resolves, not raw HTML):
   ```js
   // primary, with evidence-backed fallback
   const pre = document.querySelector('#program-source-text')
            || document.querySelector('pre.program-source.prettyprint')
            || document.querySelector('pre.prettyprint.lang-cpp, pre.prettyprint');
   const code = pre ? pre.textContent : null;   // textContent, NOT innerHTML
   ```
   Use `textContent` — the `<pre>` contains syntax-highlight markup and HTML entities; `textContent` gives clean source with entities already decoded. Only fall back to manual entity decoding (`&lt; &gt; &amp; &quot; &apos;`) if you must parse raw HTML instead of the DOM.
3. Grab language confirmation from the `prettyprint lang-{x}` class or the info table, and cross-check against the API's `programmingLanguage`.

### Phase 2-alt — bulk path via the submissions page (fewer navigations)

Navigate once to `https://codeforces.com/submissions/{handle}` (VERIFIED 200) or `https://codeforces.com/contest/{id}/my` (VERIFIED 200), then read the table in the DOM. Row shape:
- each row's source link: **`a.view-source`** (evidence: `hack.py`),
- verdict cell: `span.verdict-accepted`, `span.verdict-rejected`, etc.,
- submission id: extract from the `a.view-source` `href` (`/contest/{cid}/submission/{sid}`),
- pagination: `?page={n}` (and `?order=BY_ARRIVED_ASC`) — **`?order=` is verified to exist on `/status/` pages via `hack.py`'s URL**; pagination on `/submissions/{handle}` is **UNVERIFIED** but the page is paginated by construction.

**Recommendation:** use Phase 1 for the index (exact, cheap, unblocked) and Phase 2 strictly for source text. Phase 2-alt is a useful fallback if the API is ever unreachable, but it makes you depend on Cloudflare for data the API gives you for free.

### Login requirement — the key practical question

**VERIFIED: viewing the submissions index for an arbitrary handle works logged-out** (`/submissions/tourist`, `/contest/4/my`, `/problemset/status/...` all 200 without any session). Codeforces does not gate public submission *lists* behind login. **UNVERIFIED for the individual source page**: I never got a successful render of `/contest/{id}/submission/{sid}`, so I cannot claim I confirmed logged-out source viewing with my own evidence. Third-party scrapers (including ones that *do* log in, like `hack.py`) and Codeforces' general design indicate public submissions are source-visible logged-out, but **test this yourself with one fresh submission before shipping**.

---

## (d) Risk list

| Risk | Severity | Evidence / mitigation |
|---|---|---|
| **Cloudflare challenge on all HTML** | **Critical** | VERIFIED 403 + `cf-mitigated: challenge` on every HTML path from plain HTTP. Only mitigation: real, **non-headless** Chromium. VERIFIED headless fails (`请稍候…`). |
| **Headless mode is detected** | High | VERIFIED `--headless=new` → interstitial; non-headless → passes in ~13 s. If you ever run the app headless/offscreen, expect failure. Electron `BrowserWindow` with `show:false` is **UNVERIFIED** — it is not the same code path as `--headless`, but test it; prefer a real window. |
| **`cf_clearance` cookie expiry** | Medium | Cloudflare clearance is IP+UA bound and expires. Persist the Electron session (`session.fromPartition`) so you clear the challenge once, not per submission. Re-warm on 403. |
| **`Source: N/A` even when correct** | Medium | VERIFIED as a *reported* current issue: [blog/entry/154919](https://codeforces.com/blog/entry/154919), [blog/entry/145305](https://codeforces.com/blog/entry/145305). Handle as a normal state; never treat as "no submission". |
| **Submission page 404 == redirect to `/`** | Medium | VERIFIED: nonexistent ids 302 to the homepage. Silent-wrong-data hazard — always check `location.pathname`, don't just read the DOM. |
| **Login wall / private gym** | Medium | Gym sources need coach mode or group membership ([blog/entry/15691](https://codeforces.com/blog/entry/15691)). Detect gym (`contestId >= 100000` is the usual convention — **UNVERIFIED** as a documented rule) and warn the user. |
| **Source hidden during running contest** | Medium | [blog/entry/86005](https://codeforces.com/blog/entry/86005). Use `contest.list` → `phase` to detect `BEFORE`/`CODING` and defer review until `FINISHED`. |
| **Rate limits** | Medium | API: see §(3), ≥2 s between requests. Scraping: your Phase-2 navigations hit Cloudflare-protected HTML — pace them (≥2–3 s, small concurrency) or you risk a harder block. |
| **Fragile selectors** | Low–Medium | `#program-source-text` unverified; class-based fallback verified via third party. Use a selector chain and fail loudly. |
| **Terms of Service** | Low–Medium | Codeforces has historically tolerated read-only tooling but has no published scraping quota. Keep it to the user's own data, pace requests, identify politely. |

---

## (3) Rate limits / politeness

- **API**: the documented guidance is **no more than ~1 request per 2 seconds**, and Codeforces returns **HTTP 429** when you exceed it. The canonical statement lives on the [Codeforces API help page](https://codeforces.com/apiHelp) (which is itself Cloudflare-protected for automated fetches — cite it by URL; I could not fetch it directly). Practical rule: **serialize API calls with a ≥2000 ms gap**, and use `count=10000` to minimize round-trips rather than making many small calls.
- **HTML/scraping**: undocumented. Recommend ≥2–3 s between submission-page navigations, strictly sequential, and reuse one browser session so the Cloudflare clearance cookie is amortized.

---

## (e) Alternative data sources

1. **Official API** (`/api/`) — best for everything *except* source. Cloudflare-exempt. **VERIFIED.**
2. **The embedded Chromium DOM** — the only viable source-code transport. **VERIFIED that it defeats Cloudflare.**
3. **`m1.codeforces.com`** — same content, its own (non-Cloudflare) JS proof-of-work challenge. Not a bypass, but a *different* challenge that may be more stable than Cloudflare's in some networks. **VERIFIED interstitial.**
4. **Codeforces datasets** for offline/ML use, not live review: e.g. [COFO dataset](http://export.arxiv.org/pdf/2503.18251), [E2H-Codeforces (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/file/4e6f22305275966513990f53cec908e0-Paper-Datasets_and_Benchmarks_Track.pdf).
5. **Existing scrapers to mine for selectors**: [`viky08/Codeforces-Hacker`](https://github.com/viky08/Codeforces-Hacker/blob/master/hack.py) (selectors verified above, but **hardcodes a username/password — do not copy that pattern**), [`kgautam01/CodeForces-Scraper`](https://github.com/kgautam01/CodeForces-Scraper).
6. **Third-party API clients** (selectors/params only, no source data): [`codeforces-plus`](https://cdn.jsdelivr.net/npm/codeforces-plus@2.0.4/README.md), [`ahmed-dinar/codeforces-api-node`](https://github.com/ahmed-dinar/codeforces-api-node/blob/master/README.md), [Pipeworx `user_status`](https://pipeworx.io/docs/reference/codeforces/user_status/).
7. **Dead / unusable**: `mirror.codeforces.com`, `codeforces.ml`, `cf-problemset.herokuapp.com`, `codeforces.com/data/submitSource` — all **VERIFIED dead or 403**.

---

## Open items to verify before shipping

1. **Does `/contest/{id}/submission/{sid}` render `#program-source-text` logged-out with a fresh, real submission id?** (Blocked by tooling failure here.) Resolve the exact id + attribute.
2. **Does an Electron `BrowserWindow` with `show:false` pass Cloudflare**, or does it get headless-treated like `--headless=new`?
3. **`/submissions/{handle}` pagination params** (`?page=`) and whether `?order=BY_ARRIVED_ASC` applies there or only to `/status/` pages.
4. **Concrete 429 threshold** for the API (2 s is the widely-cited advice, not a verified spec).
