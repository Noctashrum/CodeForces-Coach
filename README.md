# CF Coach — a local-first Codeforces coach that verifies before it teaches

**[English](README.md) · [中文](README.zh-CN.md)**

CF Coach is a Windows-first desktop app (Electron + a zero-runtime-dependency Node server — no npm packages at
runtime) that turns one Codeforces problem into a complete, **machine-verified** lesson. Instead of taking a
model's word for it, it writes a solution, a brute force and a generator, **runs them against each other on your
machine**, and only then explains — with diagrams and an honest report of how far the verification got.
Everything stays in a local data directory (`%APPDATA%\codeforces-coach`, or a repo-local `data/` in development),
and the only network traffic is to the model API you configure (plus Codeforces itself when you import a problem).

```
contract → solution ∥ brute force ∥ generator (three isolated agents, in parallel)
         → sample calibration → mechanical anti-cheat → randomized stress tests across size tiers
         → on mismatch: locate the guilty side, rewrite only that side, re-run → explanation: outline first, then
           a rich HTML document (figures + interactive demo), structure-checked
```

---

## Why it is different

| Ordinary "AI explains a problem" | CF Coach |
| --- | --- |
| The model's answer is taken on faith | The solution must agree with an independently written brute force on randomized data |
| One model, one context | Three isolated agents (solution / brute force / generator) that never see each other's code — plus an explainer that works only from the verified artifacts |
| "Sample passed" = done | Samples only calibrate the ruler; correctness is argued by stress testing, and gaps are reported honestly |
| Silent failures | Every round ends with a verdict: `ok`, `unverified`, `no-bruler`, `samples-failed`, `budget` — and the UI shows it |
| Chat log | Structured lesson + problem library + learner profile + per-round token/cost accounting |

---

## Features

- **Import any problem** — fetch a problem by ID/URL, or paste a statement (normalizer agent + mechanical check).
- **Real verification harness** — compile & run locally (C++23 / Python 3 / Node), sample calibration,
  anti-hardcoding scans, behavioral probes, laddered stress tests (n = 8 / 20 / 50 / 200), delta-debugged
  minimal counterexamples. A verified conclusion is cached per problem and reused across conversations; a
  repeated `cf_verify` for the same problem in one turn reuses it instead of re-running the chain.
- **Rich lessons** — a self-contained HTML document rendered in a sandboxed iframe: chapters, SVG diagrams,
  interactive demos (token sweep / bar growth / step slider / highlight roam), quizzes, glossary.
- **Learner profile** — a macro-level card (strengths / weaknesses / what to focus on) updated only from *your*
  evidence (your code, your questions, difficulty gaps), with a 0-token evidence gate and a hallucination guard.
- **Cost accounting** — real `usage` from your provider, cache-hit aware pricing, per-message total, per-agent
  breakdown, and a trace of every model call (role, duration, tokens, model name).
- **Honest degradation by design** — when verification cannot converge, the coach says so and explains what it
  tried, instead of pretending the answer is verified.
- **Conversations stay organised** — folders (create / rename / delete; deleting a folder never deletes
  conversations — its members return to Unsorted), pinning, and multi-select batch actions (select all visible,
  archive / unarchive, delete, move to a folder, pin / unpin).
- **Local-first** — portable folder, local files, no telemetry, no accounts, no uploads other than your model API.

---

## Quick start

```bash
npm install       # installs Electron (~100 MB, one time)
npm run app       # launch the desktop app
```

Or use the portable build from `npm run pack` (`dist/CFCoach-win32-x64/CFCoach.exe`; data lives next to the exe).

**Requirements:** Node ≥ 18; for local verification also `g++` (C++23) and `python3` — the app reports missing runtimes honestly.

### First run

1. **Settings → Model services**: add any OpenAI-compatible or Anthropic-compatible endpoint
   (DeepSeek, Kimi, GLM, Qwen, OpenAI, Claude, a local gateway, …). Optionally give individual agent roles
   their own model (e.g. a stronger model for *solution*, a cheap one for *generator*).
2. **Settings → General**: enter your Codeforces handle (used for lesson depth and the learner profile) and pick
   the default explanation language.
3. Click **Ask a problem**, then import by ID (`1800C`), by URL, or paste the statement.

---

## How a round works

| Step | What happens | Who |
| --- | --- | --- |
| ① Contract | I/O and guarantees extracted mechanically from the statement — the single source of truth | Orchestrator (0 tokens) |
| ② Three artifacts | Solution, brute force and generator written **in parallel**, each in an isolated context | Three agents |
| ③ Sample calibration | The brute force must pass the official samples before it may act as the ruler; with ≤1 sample, hand-computed anchors cross-check it | Orchestrator + witness |
| ④ Mechanical anti-cheat | Hardcoded-answer scan, degenerate-output probe, generator health check, constant-output check | Orchestrator (0 tokens) |
| ⑤ Stress test + counterexample | Randomized comparison across size tiers; on mismatch, adjudicate *which side* is wrong and rewrite only that side; delta debugging shrinks the failing input to something a human can read | Orchestrator (0 tokens) |
| ⑥ Explanation | Outline first, then a rich HTML document; structure and code-fidelity machine-checked | Explainer agent |

### Isolation between agents

| Role | Can see | Cannot see |
| --- | --- | --- |
| **Solution** | statement + I/O contract + official samples | brute force, generator, stress results |
| **Brute force** | statement **with the sample section stripped** + I/O contract | official sample answers, solution, generator |
| **Generator** | only the *input* part of the contract | problem semantics, output format, any code |
| **Explainer / outline** | statement + verified solution + iteration trace + minimal counterexample + your profile | brute force code |
| **Normalizer / witness / router** | your pasted raw text, or the statement + contract for hand-computed anchors; the router is judge-only (one line of JSON) | any code |

The brute force never sees the official samples, because a ruler that can peek at the answers stops being a ruler.
It is calibrated from the outside: the orchestrator compares its **output format** against the samples.

### Rules that keep the ruler honest

- **Nobody is called wrong over a formatting difference.** Every comparison normalises first: outputs are compared
  as token streams (line breaks and spacing are layout, not answer), strings are compared case-insensitively, and
  numbers within `max(1e-6, |expected| * 1e-6)` count as equal. What is left is classified — layout, case, precision
  or a real difference — so a trailing space can never masquerade as a wrong answer.
- **The ruler is allowed to be slow.** The reference solution and the generator are killed at 5 s; the brute-force
  ruler gets 20 s. A state-space brute force is slow by design, and one shared limit used to fail the ruler before
  it could answer.
- **Rewrite only the guilty side.** When stress testing disagrees, the adjudicator decides whether the solution,
  the ruler or the generator is at fault — and only that one is rewritten.
- **Evidence beats opinions.** The orchestrator mechanically checks whether the *solution* passes the official
  samples. If the solution passes them while the ruler is uncalibrated or too slow on large values,
  the solution is **not** rewritten on the ruler's word; the round ends as `unverified` instead.
- **A ruler that only times out is not a wrong ruler.** If the brute force fails the official samples purely by
  TLE (state-space brute forces explode on `10^9` values), it is still used for small-value randomized testing,
  and the report says exactly that.
- **Generator data is never modified.** The orchestrator passes a size cap and a value cap as `argv[1]`/`argv[2]`
  and reports violations back to the generator — it never rewrites the data itself (binary strings, index fields
  and other digit strings would silently break). Cross-variable sum/product constraints (`a_i + a_j ≤ 10^9`,
  `Σn ≤ 2·10^5`, …) are respected: any "shrink the values" advice is dropped automatically.
- **Counterexamples from a discredited ruler are discarded** and never shown to the explainer.

### Budgets (the cost ceiling of one round)

| Limit | Value |
| --- | --- |
| Model calls per round | 40 |
| Wall clock per round | 20 minutes |
| Solution rewrites | ≤ 3 (independent of ruler regenerations) |
| Brute-force calibration attempts | ≤ 3 |
| Empty/truncated reply retries | 1 per call, 3 per round |
| Same counterexample twice | stop rewriting, degrade honestly |

Measured on real rounds (DeepSeek-class reasoning model, ~2000-rated problems):

| Round | Calls | Output tokens | Wall clock | Cost |
| --- | --- | --- | --- | --- |
| Clean run | 7 | ~115 K | ~6 min | ≈ ¥0.9 |
| With one ruler rewrite | 9 | ~320 K | ~7 min | ≈ ¥2.4 |

---

## The coach is a skill-driven Codeforces assistant

The coach inside a conversation is not a hard-coded prompt: it is an assistant that **loads skills on demand and
reaches for tools by itself**. Only the skill catalog (name + one-line description) sits in context permanently;
the full workflow is read in when needed. Follow up with "why did this WA?", "look at my contest review" or "is
this boundary correct?" and it decides itself whether to fetch the statement, run the pipeline, or pull submissions.

| Skill | What it does |
| --- | --- |
| `cf-explain` | Teach a problem (full verification pipeline by default) |
| `cf-debug` | Review code you wrote — or assess an approach you propose before you write it |
| `cf-verify` | The machine-checked verdict, no lecture |
| `cf-fetch` | Just pull the statement and official samples from Codeforces |
| `cf-review` | **Post-contest review** (below) |
| `cf-doc` | Produce the figure-annotated explanation document |

These six are the whole catalogue: `skills/<name>/SKILL.md` — Markdown with YAML frontmatter. Add your own
workflow by creating a directory and writing a `SKILL.md`; no code changes needed
(`disable-model-invocation: true` keeps it out of the catalog unless you name it explicitly).

The verification chain is what the tool layer actually runs:

```
skill → cf_workspace (reuse the cached run, or start fresh) → statement normalisation
      → a solution plus an independent brute-force ruler → generator + stress testing
      → the official samples through cf_run → cf_doc assembles the illustrated document
```

Tools: `skill`, `skill_read`, `cf_fetch`, `cf_contract`, `cf_verify`, `cf_run`, `cf_workspace`, `cf_doc`,
`cf_submissions`, `cf_source`. **Nothing already in the material is fetched twice** — assembled material is
tagged "already here, do not fetch again", and a pasted statement is registered mechanically *before* the model
runs (text + samples), so the prompt forbids re-fetching; `cf_verify` / `cf_contract` / `cf_doc` read it directly.

### The delivery format is automatic too (no mode to pick first)

The intent menu next to the composer defaults to **🤖 Auto** and offers five options: **Auto** (default,
recommended), **Full explanation**, **Hint**, **Statement reading**, **Code review** — post-contest review has its
own page (below). Under Auto the coach reads what your message is asking for and picks the skill itself, so pasting
a statement, or giving just a problem ID, defaults to a full explanation instead of asking you which mode you want.

Pick one of the options explicitly if you want fixed behaviour (it is stored on the conversation and applies to
every following turn). In auto mode the **actual choice is recorded** (back-filled from the skill the model read),
so profile evidence and stats reflect what really happened.

---

## Post-contest review: real submissions, diagnosed

The review page pulls **every submission** you made in a contest (by handle + contest id) with its real verdict,
timing and language, summarizes it mechanically (attempts per problem, verdict sequence, time stuck, where the
penalty went), and loads two kinds of ground truth into a fresh conversation — diagnosed question by question:

1. **Official editorials** where Codeforces has them; where it does not, the material says so and the coach solves
   the problem itself and verifies it — it never invents an editorial;
2. **Your source code** — up to three snapshots per problem: **first submission / last failing submission / first
   accepted submission**, each labelled with its verdict. Seeing only the last one hides the "what was wrong → how
   it got fixed" story.

Loading is streamed and reported per problem (`editorial ready | source 3/3`), and anything that timed out is
labelled honestly instead of being silently dropped.

Two entry points:

- **🧠 Start AI review** — opens a new conversation with the material and **starts the coach talking by itself**
  (no prompting needed);
- **💬 Put into the composer** — drops the material straight into the input box so you can edit it and add your own.

> Submission source pages require a Codeforces login. Click **🔑 Log in to Codeforces** on the review page once; the
> session is persisted in the app's own partition and later fetches reuse it. When a fetch fails the app states the
> real reason (not logged in / source hidden during a running contest / `Source: N/A`) and never passes the
> homepage HTML off as code. Source code is only fetched for your own submissions.

---

## Organising conversations: folders + multi-select

Once you have a few dozen conversations, the sidebar gives you two tools.

**Folders**

- Create one with the 📁 button; file a conversation with the folder button on the row, or *Move to…* for several;
- Folder headers collapse (state is remembered locally), rename, and delete;
- **Deleting a folder never deletes conversations** — its members simply move back to Unsorted;
- Order: pinned → folders → unfiled (unfiled is still grouped by today / yesterday / last 7 days).

**Multi-select**

- The ✓ button toggles selection mode: clicking a row selects it instead of opening it; a bulk bar appears below;
- *Select all* selects the conversations **currently visible** (respecting the search box and the active tab),
  never ones you cannot see;
- Batch archive / unarchive / delete / move-to-folder / pin / unpin; selection mode exits when a batch finishes;
- Partial failures are reported honestly (how many failed and why), never as a bare "done".

State lives in `data/folders.json` plus a `folder` field on each conversation file — plain local files; delete to reset.

Deleting a conversation also deletes its verification cache: workspaces are shared per problem across
conversations, so the delete dialog explains that the problem's solution / brute force / stress-test cache goes
with it. If another conversation still uses that workspace, the cache is kept and the UI says which conversations
are sharing it — and a **🔄 re-run the verification** button in the problem panel clears the cache on demand
(`POST /api/workspace/purge`), so the next question about that problem starts the chain from scratch.

---

## Asking several problems at once (parallel rounds)

**Yes, that works.** Every conversation owns its own generation stream (the Agent bench on the right is per
conversation) and the server imposes no global "one round at a time" limit: ask 1800C in conversation A, switch to
conversation B and ask 2264D, and both rounds really run at the same time, each with its own workspace, its own
stop button and its own cost line.

Only two things queue up, and only because they are a single shared resource — this is not throttling:

| Shared resource | What happens | What you see |
| --- | --- | --- |
| The embedded browser window used to fetch statements (there is exactly one, it is what gets past Cloudflare) | Fetches are queued: one at a time, a failure never blocks the ones behind it | Log line `抓取排队中（前面还有 N 个抓取）`; statements still arrive normally |
| The workspace of **one specific problem** (`workspace/cf-<id><index>`, shared across conversations) | Per-problem lock: the verification chain of one problem is serial | The second conversation either waits and then **reuses** the first one's stress-test conclusion, or runs after it — never writing the same files concurrently |

**Different problems are different locks**, so parallelism is not reduced. And the second question about the same
problem normally hits the cached verdict anyway (see "Deleting a conversation also deletes its verification cache").

---

## Explanations

**Rich document by default** for a *full explanation* and *code review*; *hints* and *statement reading* stay
short text — only a "just a hint" request skips the document, because the document format is overkill for
direction only.

- The document is a self-contained HTML fragment carrying its own bundled stylesheet and script (dark/light theme
  aware, so it never renders as black-on-black), wrapped with the built-in design system and rendered in a
  **sandboxed iframe** the moment it arrives — the chat does not wait for the turn to end.
- Validation is mechanical: tag/class whitelist, no scripts/styles/external URLs/inline handlers, tag pairing,
  **diagram count (at least one `<svg>` with a sane `viewBox`)**, SVG text inside the viewBox. Failures get one
  targeted repair attempt, then a **mechanical rescue** (sanitize + auto-close + LaTeX→text) so a fixable document
  is not thrown away — only a document with no usable diagram at all falls back to Markdown.
- **A diagram is a hard delivery requirement, and it must be a real vector graphic.** The prompt spells out what
  earns a figure (how an algorithm's state evolves step by step, the shape of a data structure or a geometric
  configuration, how a construction is laid out, what a counterexample/boundary case looks like) and what does not
  (pure derivations, boilerplate, re-typing the sample array, an empty "read → loop → print" shell), and a table
  drawn as SVG does not count as a diagram. The test is one sentence: **if deleting the figure would not make the
  lesson harder to follow, do not draw it.** So "at least one" is a floor, not a quota — no filler diagrams.
- The message body only ever carries a short lead-in; the document is streamed live into the Agent workbench while
  it is being written. LaTeX (`$x$`, `\le`, `\lfloor`, …) is translated by the sanitizer into readable text or the
  design system's formula component, because the document has no math renderer.

---

## Cost accounting

Every message carries `💸 N calls · ≈ ¥X`; the side panel shows this round's cost plus a per-agent breakdown, and
the decision trace lists every model call with duration, token counts and model name. Tokens come from the
provider's `usage`, or are estimated from characters (and marked as such) when a provider does not report it.

- **Cache hits are priced correctly**: providers such as DeepSeek bill cached input at a fraction of the normal
  price. The app reads `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and prices them separately. When a
  provider reports neither, the estimate is labelled *"cache discount not included — the real bill is usually lower"*.
- Prices: your per-model override (`providerId::model`) wins, then the built-in reference table; if neither
  exists the app reports tokens only and says "unit price not configured" instead of inventing a number.
- `max_tokens` is unset by default (provider default): reasoning models spend their budget on thinking first, so a
  too-small cap yields an empty answer. When a reply is cut off by the cap, the app **changes the ask** — a
  "give the result first" note in the coach loop, a code-only prompt in the verification pipeline — instead of
  resending it, and specifically **never** resends it with the cap removed:
  dropping the cap only raises the budget to the provider's 65,536 while the root cause is the ask itself, and
  measured, one such resend burned ~65k extra output tokens and recovered almost no answer text.

---

## Privacy and local data

Conversations, workspaces (the per-problem solution / ruler / stress artifacts), the learner profile, folders and
provider settings — including any API key — live in a local data directory under `%APPDATA%\codeforces-coach`
(a repo-local `data/` in development). Both are `.gitignore`d and never committed: the repo holds source and skills.

```
data/
├── config.json             # settings: model services & keys, CF handle, appearance, prices
├── conversations/          # one JSON per conversation; archive/ holds archived ones
├── workspace/<key>/        # verification workspace: sol / brute / gen / meta.json (trace, verdict, counterexample)
│   └── cache/              # verified artifacts cached per problem (reused across conversations)
├── cf-problems/<id>.json   # statements + samples fetched successfully (usable offline afterwards)
├── cf-fetch.log            # Codeforces fetch log (which window mode succeeded, cache hits)
├── profile-card.json       # learner profile (macro level); profile-log.jsonl audits updates (applied / why not)
└── window-state.json       # desktop window position
```

- No telemetry, no accounts, no analytics. The app talks to exactly two kinds of endpoints: Codeforces
  (statements, metadata, your own submissions) and the model provider you configured yourself.
- Generated code runs in a restricted sandbox for Python/Node (own temp dir, network off by default).
  **C++ cannot be sandboxed that way** — only timeouts and process-tree cleanup apply, so use models you trust.
- The rich document runs in a sandboxed iframe with a CSP that blocks all external requests.

### When something breaks on someone else's machine

Everything above stays on that machine — which is exactly why debugging it remotely used to be guesswork.
**Settings → Data & storage → Diagnostics bundle** writes one plain-text `.txt` with the environment (app /
Electron / Chromium version, data dirs), the model config, the app and fetch logs, the statement-cache ledger,
every workspace's verification verdict, the tail of the last few conversations, and the ablation records
including the **per-step tool trace** of each run. API keys, cookies, e-mails and OS usernames are masked, and
no full statement or full solution text is included, so the file can be sent as-is. If the UI will not even
start, the same file comes from the command line: `node scripts/diag.js --out diag.txt`
(full details: [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md)).

### Fetching from Codeforces

Codeforces' plain HTML pages are behind Cloudflare, so a plain HTTP request can meet `403 + cf-mitigated:
challenge`; the official `/api/*` endpoints are not. The app tries, in order: plain HTTP (desktop layout only,
mobile pages rejected) → an embedded **real non-headless Chromium window** that passes the challenge (one
persistent partition, hidden first, then a **visible but off-screen** window, because Cloudflare challenges often
refuse hidden windows) → the local per-problem cache → the cached samples of the current conversation → and finally
paste-the-statement, which always works. `data/cf-fetch.log` records which step succeeded; source code needs a login.

Correct URLs matter. The canonical problem URL is `https://codeforces.com/contest/<id>/problem/<index>` (gym:
`/gym/<id>/problem/<index>`); `/problemset/problem/<id>/<index>` only works once the problem is in the problemset
index, so it is a fallback candidate, not the primary address. The problem list for a contest comes from the
authoritative `contest.standings` endpoint, which also answers anonymously when called without extra parameters —
and a negative answer ("no such problem", "no such contest") is only given when an authoritative source says so,
never inferred from a blocked or failed fetch.

When a fetch fails, the app opens a dialog that names the reason — no such problem / blocked by anti-bot / fetch
failed — and offers two buttons: open the problem in the browser, or paste the statement yourself.

---

## Configuration highlights

| Setting | What it does |
| --- | --- |
| Multiple model services | Any OpenAI-compatible or Anthropic-compatible endpoint, with test-connection and model-list fetch |
| Per-role models | 7 roles can each use a different `provider::model` (solution / brute / generator / explainer / outline / normalizer / witness) |
| Prices | `providerId::model` unit prices (input, output, optional cached-input) for accurate cost estimates |
| Output cap | Optional `max_tokens`; empty = provider default (recommended) |
| Sandbox | Python/Node sandbox on/off, network access on/off |
| Codeforces | Handle, optional local proxy (`http://127.0.0.1:7890`), clear the app's embedded CF session |
| Appearance | Themes, accent colors, custom background image, fonts, radius, reading width, code theme, animations |

---

## Project layout

```
server.js            zero-dependency Node server: REST + SSE proxy + orchestrator entry + profile + classification
lib/cf.js            Codeforces client: statement parsing ($$$ → LaTeX), samples, metadata, user, rating history
lib/tools.js         tool definitions and implementations (cf_fetch / cf_contract / cf_verify / cf_run / cf_workspace / cf_source / cf_doc …)
lib/harness.js       orchestrator: contract, calibration, anti-cheat, stress testing, adjudication, explanation gates
lib/runner.js        local runner: compile (C++23) / run / timeouts / process-tree kill / comparison / delta debugging
lib/workspace.js     workspace files, per-problem verified-artifact cache
lib/statement.js     pasted-statement format detection, mechanical sample extraction, normalizer agent
lib/richdoc.js       rich document validation / sanitizing / wrapping (sandboxed iframe + CSP)
lib/anticheat.js     anti-hardcoding scans, degenerate output, generator health, cross-variable constraints; lib/explaindoc.js  lesson structure checks
lib/profile.js       learner profile evidence gate + hallucination guard; lib/pricing.js  token accounting / cost estimation
lib/skills.js        skill discovery and loading (frontmatter, catalog/body split, on-demand bodies)
lib/cfreview.js      post-contest review: submission aggregation, editorial fetch + per-problem slicing, source code
lib/llm.js           provider calls (OpenAI- / Anthropic-compatible); lib/agentloop.js  the conversational tool loop
lib/sandbox.js       Python/Node sandbox guards
lib/diagbundle.js    diagnostics bundle: environment / logs / cache ledger / verdicts / per-step tool trace, masked
skills/              skill library: one SKILL.md per directory (cf-explain / cf-fetch / cf-debug / cf-verify / cf-doc / cf-review)
public/              build-free frontend: index.html, styles.css, js/app.js + js/md.js, rich/ (document stylesheet + script), vendor/
scripts/             mock LLM/CF servers, unit & end-to-end tests, probes, packaging, icons, diagnostics CLI
electron/            desktop shell: window, tray, menu, smoke self-test, CF fetch browser channel
.probe/              developer probes (concurrency timing, document rendering/leaks, round auditing)
```

---

## Development and tests

```bash
npm test                  # end-to-end: boots mock services with an isolated data dir, 259 checks
npm run test:units        # 12 unit suites (anticheat / explaindoc / statement / loopguard / pricing / parallel / agentruns / skills / diagbundle / harness / runner / ablation)
npm run test:harness      # orchestrator unit tests (contract slicing, sample isolation, workspace, rich docs)
npm run test:runner       # runner unit tests (compile / compare / timeout / C++23); also test:parallel | test:agentruns
node scripts/run-smoke.js # desktop smoke test (hidden window; prints SMOKE_OVERALL PASS)
node scripts/run-smoke.js --packaged   # same, driving the packaged app's real UI (set CHATBOX_SMOKE_TIMEOUT=240000)
npm run mock              # mock LLM endpoint on :3999
npm run mock-cf           # mock Codeforces on :3998
npm run pack              # build the portable folder dist/CFCoach-win32-x64 (keeps data/ next to the exe)
npm run check:pack        # pre/post-pack self-check: packaged output matches the sources file by file (36 files)
npm run test:skills       # 82 skill checks (skill system + tool layer, no network)
npm run test:diagbundle   # diagnostics-bundle tests (nothing sensitive survives, sections, truncation, CLI)
npm run diag              # write a diagnostics bundle: node scripts/diag.js --out diag.txt
npm run test:ablation     # ablation self-test (local fake model, zero tokens: L0 / L0C / L0+ / L1 / L2, judging, paired compare)
npm run probe:ablation    # ablation probes: run / judge / import-l2 / selftest, all zero-token
npm run probe:ui          # end-to-end probe of the manual ablation workbench (zero tokens)
npm run probe:cf          # live: fetch one real problem through the app's own CF fetch channel
npm run ablation:serve    # manual workbench UI on http://127.0.0.1:4311 (fetch from CF → paste only your oracle → auto-write the generator → run L0/L0+/L2)
node scripts/probe-review-session.js <handle> <contestId>   # live: assemble review material (editorials + sources)
node scripts/probe-review-bundle.js  <handle> <contestId>   # live: the bundle that goes into the composer
node scripts/probe-source-live.js    <contestId> <submissionId…>   # live: submission source fetching
```

Pushing and releasing (three commands, a pre-push checklist, common errors): see [docs/PUSHING.md](docs/PUSHING.md).
Debugging a machine you cannot reach (how to package the whole crime scene into one masked text file): see [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md).

**Ablation study (AC or nothing)**: `ablation/` runs the same problems through five arms — L0 (bare model, one call,
no tools), L0C (L0 plus "output one code block and nothing else"), L0+ (L0 **plus the exact prompt discipline and
inputs the L2 solution agent gets** — the mechanically extracted I/O contract and the official samples, still one
call, no tools), L1 (bare agent loop + generic tools) and L2 (cf-coach itself). Judging reproduces what Codeforces
actually accepts: the official samples, differential testing against an **external accepted submission**, and the
**maximum input size at the real time limit**. Protocol, judging discipline (the oracle must never come from
cf-coach's own output), cost estimates and a results template: see [ablation/README.md](ablation/README.md).

The bar is read on **two lines — preserving solvability and teaching** — not as one-sentence "`L2 > L0+`":

- **Preserving solvability**: if the bare model cannot solve a problem, us failing it too is normal and is not a loss.
  What actually matters is that **we lose none of the problems L0 (or L0C) does get accepted**; extra money should be
  spent on cells where "the model could solve it but our interface, budget or protocol dropped it".
- **Teaching**: verification, minimum counterexamples, review and walkthroughs are a separate line — not priced in AC,
  but with their own bar (claims reproducible against the official samples and differential testing, scope stated
  honestly, and no fake "verified").
- **No over-claiming**: beating the model's ceiling with orchestration is a fantasy. When the chain judges a problem
  unsolvable it must **degrade honestly** (state the scope, deliver the first correct version) and book the saved cost,
  instead of re-running forever.
- Still reported: paired win/tie/loss with an exact McNemar p-value, per-arm tokens and cost (and ¥ per AC), and the
  **false-confidence rate** (the chain claimed "verified" while an external oracle says WA). `L2 > L0+` is one of the
  numbers (the harness's net gain with prompts and budget held identical), but **it is not the bar by itself** — part of
  that gain comes from problems L0 could not solve, and by the rule above that only counts as a bonus.

The books on the **8 problems that L0 or L0C ever got accepted** (the "preserving solvability" reading):

| Arm | Those 8 | Spend | ¥/AC |
| --- | --- | --- | --- |
| L0 | 7/8 | ¥0.585 | **¥0.084** |
| L0C | 5/8 | ¥0.471 | ¥0.094 |
| L0+ | 4/8 | ¥0.504 | ¥0.126 |
| L1 | **8/8** | ¥3.599 | ¥0.450 |
| L2 | 7/8 | ¥8.251 | ¥1.179 |

The one miss (2267B) is a "cannot judge" on the ruler itself, which the judging side should carry. L1 spends ¥3.60 for
8/8 while L2 spends ¥8.25 for 7/8: **the extra ¥4.65 bought no AC at all on the solving axis** — the teaching line has
to earn it back, or it is just cost.

**What the ruler found (October 2026)** — five defects were letting non-solutions look like AC: `<=` bounds parsed as
`<`, multi-answer problems compared literally, statements with `t` but no `n`, single-draw random generators, and an
oracle that overflowed the stack at maximum size (MinGW gives C++ 1–2 MB where Codeforces gives 256 MB). After fixing
all five and re-judging every record, every "cheaper" arm still scored **zero** AC.

The first pass then compared arms whose **per-call output budget was not the same**: the one-call arms passed no
`max_tokens` at all (provider default 65536, **shared by the thinking tokens and the answer**), while L2's solution
agent uses an 8192 first attempt plus a truncation salvage. A probe that varies only that budget
(`.probe/why-truncated.js`) shows why it matters: on one 1200-rated problem the same prompt with no cap burns
**149,004 thinking characters** for a 642-character code block, with an 8192 cap it returns **nothing at all**
(`finish_reason=length`), and with the cap plus thinking disabled it returns the code in **1.5s for ¥0.0034 — 117×
cheaper**. Five of L0+'s fifteen cells were white pages caused by that, not by its prompt.

After giving every one-call arm the *same* budget rules as the product (`ablation/lib/levels.js`
`callWithBudget()`: 8192 attempt → salvage at 65536 with `reasoning_effort:'none'` + the previous thinking tail)
and re-running all 68 leaf-arm records (**68/68 produced code, zero white pages, ¥15.07**), the AC axis reads
differently than it first did:

- **L0+ vs L2 = 5 both AC / 0 only L0+ / 7 only L2 / 5 both failed → net +7 AC, exact McNemar p = 0.016.**
  With prompts *and* per-call budget held identical, the harness (tools, loop, verification, feedback-driven
  retries) does buy solving power — the earlier "+2, not significant" was an artifact of the mismatched budget.
- **Prompt discipline alone still buys nothing**: L0C and L0+ each score 5 of 17 against the bare model's 7.
- **Part of the gain is just "having a loop and tools"**: L1 (generic tools, no harness) scores 10; L1 vs L2 is
  +2 (p = 0.625).
- **Variance is large**: L0+ on one problem produced a 1,756-character accepted solution in one run and a
  **142,708-character code block** (sample WA) in another — same problem, model, prompt and budget.
- Cost per representative cell: L0 ¥0.21/AC, L0C ¥0.26, L0+ ¥0.52, L1 ¥0.97, **L2 ¥1.80/AC**.

The salvage mechanism: **defaults stay unchanged, but the isolating run points at "thinking off + feeding the thinking
tail back".** The earlier L2 comparison was confounded (its baseline ran the old discipline: no first-attempt cap plus
an ordinary retry that still thought), so it was redone varying only *how the rescue happens* — both arms at an 8192
first attempt: **default 0/3** (all three `sample-WA`, handing back **70k–90k-character python monsters** that were
still delivered as the model's first version) versus **`CFCOACH_SALVAGE_NO_TAIL=1` 1/3** (2268A ★CF-AC at 624
characters, 166ms against a 2000ms limit; the other two are correct-but-slow Python TLEs at the largest scale), for
¥3.23 vs ¥3.44. One discordant pair proves nothing, so **defaults are untouched** and this needs 8–10 cells to settle;
both switches (`CFCOACH_SALVAGE_MAX_TOKENS` / `CFCOACH_SALVAGE_NO_TAIL`) stay. A bigger bill worth fixing
(`.probe/l2-cost-attribution.js`): **45.5% of L2's spend (¥13.71 across 26 calls) went into calls that hit the length
cap and returned nothing at all** — 21 of those 26 are the solve agent's first answer and its immediate retry; the
teaching line is 24.6% (that one *is* the deliverable). That is what the next step, a **stop-loss budget** that stops on
"no new information" rather than on a time cap, is for. Method, numbers and limits:
[docs/cf-ac-ruler-2026-10.md](docs/cf-ac-ruler-2026-10.md) §3.6 / §7.

`npm run ablation:serve` opens a one-page workbench for the manual pass: type a problem id and hit "fetch from CF" (it reuses the app's own fetch channel, so the statement,
samples, title and rating come in automatically) — **you only paste your own accepted solution as the oracle** — then
"auto-write generator" has the model write the random generator and mechanically checks it right away; run
L0/L0+/L2 side by side, read the L2 rich document next to the raw L0 answer, and record a human verdict per problem.
Live fetching is occasionally blocked by CF's anti-bot challenge (it is probabilistic): click again, it usually goes
through. If it keeps failing, hit "**import app cache**" — that reads the statement the app itself already fetched and
cached under `data/cf-problems/`, purely from local disk (no network, no challenge).

When working on the **coach tool loop** (`lib/agentloop.js` / `lib/tools.js` / `scripts/mock-llm.js`),
two probes under `.probe/` save a lot of time:

```bash
node .probe/dump-coach-events.js  "CF 1800C 讲解一下" mock-gpt-4      # dump one real event stream (tools / agents / doc)
node .probe/probe-e2e-cases.js    debug|badrich|hint|doc|soft|rethink # reproduce one e2e case in isolation
node .probe/probe-no-runtime.js                                        # reproduce "a machine with no compilers" (boots its own mocks)
```

`probe-no-runtime.js` uses the diagnostic switch `CFCOACH_FAKE_RUNTIMES=none|python|cpp,js`, which overrides the
runtime probe — the only way to exercise the "no compiler installed" path on a dev box that has g++ and Python.
That path is a first-class degradation, so it needs a guard too.

Both (the first two) need a running dev server (`PORT=3210 CF_BASE=http://127.0.0.1:3998 CHATBOX_DATA_DIR=… node server.js`) plus a
mock upstream (`node scripts/mock-llm.js`; `MOCK_DEBUG=1` prints what it received). All tests use isolated
`.test-data/` directories, so your real data is never touched; frontend deps (marked, highlight.js, KaTeX) are
vendored under `public/vendor/` — no CDN requests.

---

## FAQ

- **The fetch was blocked / 403?** The embedded browser path is used automatically; you can also configure a local
  proxy, or paste the statement — pasting always works and goes through exactly the same pipeline.
- **Why did the answer say "I could not verify this"?** Verification is a promise, not decoration: if stress
  testing does not converge within the budget, the coach says so, and lists what it tried.
- **My machine has no g++ / Python — is that fatal?** No, but the delivery degrades honestly on purpose:
  - the app probes the local runtimes on every turn (30 s cache); the tool descriptions and the system prompt
    state exactly what *this* machine can run;
  - Python only → the verification chain **switches to Python** and says so in its conclusion;
  - nothing at all → `cf_verify` returns `NO-RUNTIME` immediately (and tells the model not to retry), and the
    explanation is delivered by **pure reasoning**: the first sentence states that nothing was executed, while
    the reasoning, correctness argument, complexity and the illustrated document are still produced.
    Install Python 3 (or g++) and it is picked up within 30 seconds — no restart.
- **I saw a blob of angle brackets / `DSML` in an answer?** That is the upstream model **leaking its internal
  tool-call markup into the message body** (not an encoding problem, not something you did). It is blocked in
  three layers: ① the final step no longer drops the tool declarations (`tool_choice: none` + an explicit
  instruction instead — omitting them is what triggered the leak); ② markup in the body is first **recovered**
  into real tool calls, otherwise stripped — it is never shown as an explanation, and if nothing is left the app
  says so honestly and asks again; ③ opening an old conversation repairs already-saved markup and writes it back.
- **Why is a round expensive/slow sometimes?** Reasoning models can spend 5 minutes per call. Budgets cap a round
  at 40 calls / 20 minutes; giving roles their own models (cheap generator, strong solution) is the biggest lever.
- **Nothing was generated?** You still get a mechanical summary (where it stopped, what ran, what to try), plus the
  decision trace — a round never ends with an empty message.
- **Where is my data?** Under `%APPDATA%\codeforces-coach` (a repo-local `data/` in development). Delete it to reset everything.

---

## Known limitations

- The pipeline removes *implementation* correlation (a wrong brute force, an off-by-one, an overflow) but not
  *problem-statement* correlation: several agents share the same reading of the statement, so an ambiguous
  statement can be misread consistently by all of them. The official samples are the only anchor outside the models.
- Official samples prove output format, not correctness; that is why they are always combined with mechanical
  checks and stress testing.
- Interactive problems are not supported (they need live I/O).
- C++ code cannot be sandboxed; generated code really runs on your machine.
- Truncated model output remains a real failure mode for long reasoning models — the app retries with a
  different ask (a code-only prompt) and, importantly, **never** by removing the output cap; it degrades
  honestly if that fails too.

---

## License

MIT — see [LICENSE](LICENSE).
