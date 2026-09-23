# CF Coach — a local-first Codeforces coach that verifies before it teaches

**[English](README.md) · [中文](README.zh-CN.md)**

CF Coach is a desktop app (Electron + a zero-dependency Node server) that turns one Codeforces problem into a
complete, **machine-verified** lesson. Instead of asking a model to "explain this problem", it first writes a
solution, a brute force and a data generator, **runs them against each other on your own machine**, and only then
writes the explanation — with diagrams, an interactive demo, and an honest report of how far the verification got.

Everything (conversations, code, workspaces, learner profile) stays in a local `data/` folder. The only network
traffic is to the model API you configure (plus Codeforces itself when you import a problem).

```
contract → solution ∥ brute force ∥ generator (three isolated agents, in parallel)
         → sample calibration → mechanical anti-cheat → randomized stress tests across size tiers
         → on mismatch: locate the guilty side, rewrite only that side, re-run
         → explanation: outline first, then a rich HTML document (figures + interactive demo), structure-checked
```

---

## Why it is different

| Ordinary "AI explains a problem" | CF Coach |
| --- | --- |
| The model's answer is taken on faith | The solution must agree with an independently written brute force on randomized data |
| One model, one context | Four isolated agents (solution / brute force / generator / explainer) that cannot see each other's code |
| "Sample passed" = done | Samples only calibrate the ruler; correctness is argued by stress testing, and gaps are reported honestly |
| Silent failures | Every round ends with a verdict: `ok`, `unverified`, `no-bruler`, `samples-failed`, `budget` — and the UI shows it |
| Chat log | Structured lesson + problem library + learner profile + per-round token/cost accounting |

---

## Features

- **Import any problem** — fetch a Codeforces problem by ID/URL, or paste a statement (pasted statements are
  normalized by a dedicated agent and mechanically checked).
- **Real verification harness** — compile & run locally (C++23 / Python 3 / Node), sample calibration,
  anti-hardcoding scans, behavioral probes, laddered stress tests (n = 8 / 20 / 50 / 200), delta-debugged
  minimal counterexamples.
- **Rich lessons** — a self-contained HTML document rendered in a sandboxed iframe: chapters, SVG diagrams,
  interactive demos (token sweep / bar growth / step slider / highlight roam), quizzes, glossary.
- **Learner profile** — a macro-level card (strengths / weaknesses / what to focus on) that is only updated from
  *your own* evidence (your code, your questions, difficulty gaps), with a 0-token evidence gate and a
  hallucination guard.
- **Cost accounting** — real `usage` from your provider, cache-hit aware pricing, per-message total, per-agent
  breakdown, and a trace of every single model call (role, duration, tokens, model name).
- **Honest degradation by design** — when verification cannot converge, the coach says so and explains what it
  tried, instead of pretending the answer is verified.
- **Local-first** — portable folder, local files, no telemetry, no accounts, no uploads other than your model API.

---

## Quick start

```bash
npm install       # installs Electron (~100 MB, one time)
npm run app       # launch the desktop app
```

Or use the portable build produced by `npm run pack` (`dist/CFCoach-win32-x64/CFCoach.exe`, data lives in `data/`
next to the executable — copy the folder to move everything).

**Requirements:** Node ≥ 18. To run the full verification locally you also want `g++` (C++23) and `python3`;
the app tells you honestly when a runtime is missing.

### First run

1. **Settings → Model services**: add any OpenAI-compatible or Anthropic-compatible endpoint
   (DeepSeek, Kimi, GLM, Qwen, OpenAI, Claude, a local gateway, …). Optionally give individual agent roles
   their own model (e.g. a stronger model for *solution*, a cheap one for *generator*).
2. **Settings → General**: enter your Codeforces handle (used for lesson depth and the learner profile) and pick
   the default explanation language.
3. Click **Ask a problem**, then import by ID (`1800C`), by URL, or paste the statement.

---

## How a round works

| Step | What happens | Who does it |
| --- | --- | --- |
| ① Contract | Input / output / guarantees are extracted mechanically from the statement — the single source of truth | Orchestrator (0 tokens) |
| ② Three artifacts | Solution, brute force and generator are written **in parallel**, each in an isolated context | Three agents |
| ③ Sample calibration | The brute force must pass the official samples before it may act as the ruler; with ≤1 sample, hand-computed anchors cross-check it | Orchestrator + witness agent |
| ④ Mechanical anti-cheat | Hardcoded-answer scan, degenerate-output probe, generator health check, constant-output check | Orchestrator (0 tokens) |
| ⑤ Laddered stress test | Randomized comparison across size tiers; on mismatch, adjudicate *which side* is wrong and rewrite only that side | Orchestrator |
| ⑥ Minimal counterexample | Delta debugging shrinks the failing input to something a human can read | Orchestrator (0 tokens) |
| ⑦ Explanation | Outline first, then a rich HTML document; structure and code-fidelity are machine-checked | Explainer agent |

### Isolation between agents

| Role | Can see | Cannot see |
| --- | --- | --- |
| **Solution** | statement + I/O contract + official samples | brute force, generator, stress results |
| **Brute force** | statement **with the sample section stripped** + I/O contract | official sample answers, solution, generator |
| **Generator** | only the *input* part of the contract | problem semantics, output format, any code |
| **Explainer** | statement + verified solution + iteration trace + minimal counterexample + your profile | brute force code |
| **Outline** | statement + contract + samples + verified solution + verification report | brute force code |
| **Statement normalizer** | your pasted raw text | any code |
| **Witness (hand anchors)** | statement + I/O contract | any code (independent reasoning) |
| **Router / idea check / adjudicator** | judge-only, one line of JSON | — |

The brute force never sees the official samples, because a ruler that can peek at the answers stops being a ruler.
It is calibrated from the outside: the orchestrator compares its **output format** against the samples.

### Rules that keep the ruler honest

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
  and other digit strings would silently break).
- **Cross-variable constraints are respected.** If the statement contains sum/product constraints
  (`a_i + a_j ≤ 10^9`, `Σn ≤ 2·10^5`, …), any "shrink the values" advice is dropped automatically.
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

## Explanations

**Rich document by default** for *full explanation* and *code review*; *hints* and *statement reading* stay short
text (they only give direction, so the document format is overkill).

- The document is a self-contained HTML fragment wrapped with the built-in design system and rendered in a
  **sandboxed iframe** (scripts allowed, no same-origin, CSP forbids every external request).
- Validation is mechanical: tag/class whitelist, no scripts/styles/external URLs/inline handlers, tag pairing,
  diagram count (an `<svg>` with a sane `viewBox`), SVG text inside the viewBox. Failures get one targeted repair
  attempt, then a **mechanical rescue** (sanitize + auto-close + LaTeX→text) so a fixable document is not thrown
  away — only a document with no usable diagram at all falls back to Markdown.
- The message body only ever carries a short lead-in; the document itself is streamed live into the Agent
  workbench while it is being written.
- If the model writes LaTeX (`$x$`, `\le`, `\lfloor`, …) the sanitizer translates it into readable text or the
  design system's formula component, because the document has no math renderer.

---

## Cost accounting

Every message carries `💸 N calls · ≈ ¥X`; the side panel shows this round's cost plus a per-agent breakdown, and
the decision trace lists every model call with duration, token counts and model name.

- Tokens come from the provider's `usage`; when a provider does not report usage they are estimated from
  characters and marked as such.
- **Cache hits are priced correctly**: providers such as DeepSeek bill cached input at a fraction of the normal
  price. The app reads `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and prices them separately. When a
  provider reports neither, the estimate is labelled *"cache discount not included — the real bill is usually lower"*.
- Prices: your per-model override (`providerId::model`) wins, then the built-in reference table; if neither
  exists the app reports tokens only and says "unit price not configured" instead of inventing a number.
- `max_tokens` is left unset by default (provider default). Reasoning models spend their budget on thinking first,
  so a too-small cap produces an empty answer; the app therefore also retries once without any cap when a reply is
  cut off with nothing visible.

---

## Privacy and local data

```
data/
├── config.json             # settings: model services & keys, CF handle, appearance, prices
├── conversations/          # one JSON per conversation
├── archive/                # archived conversations
├── workspace/<key>/        # verification workspace: sol / brute / gen / meta.json (trace, verdict, counterexample)
│   └── cache/              # verified artifacts cached per problem (reused across conversations)
├── cf-problems/<id>.json   # statements + samples fetched successfully (usable offline afterwards)
├── cf-fetch.log            # Codeforces fetch log (which window mode succeeded, cache hits)
├── profile-card.json       # learner profile (macro level)
├── profile-log.jsonl       # profile update audit (applied / rejected, and why)
└── window-state.json       # desktop window position
```

- No telemetry, no accounts, no analytics. The only outbound traffic is your configured model API and
  codeforces.com when you import a problem.
- Generated code runs in a restricted sandbox for Python/Node (own temp dir, network off by default).
  **C++ cannot be sandboxed that way** — only timeouts and process-tree cleanup apply, so use models you trust.
- The rich document runs in a sandboxed iframe with a CSP that blocks all external requests.

### Fetching from Codeforces

Codeforces is behind Cloudflare, so a plain HTTP request can meet `403 + cf-mitigated: challenge`. The app tries,
in order: plain HTTP (desktop layout only, mobile pages are rejected) → an embedded Chromium window (hidden first,
then a **visible but off-screen** window, because Cloudflare challenges often refuse hidden windows) → the local
per-problem cache → the cached official samples of the current conversation → and finally tells you to paste the
statement, which always works and needs no network. `data/cf-fetch.log` records which step succeeded.

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
lib/harness.js       orchestrator: contract, calibration, anti-cheat, stress testing, adjudication, explanation gates
lib/runner.js        local runner: compile (C++23) / run / timeouts / process-tree kill / comparison / delta debugging
lib/cf.js            Codeforces client: statement parsing ($$$ → LaTeX), samples, metadata, user, rating history
lib/statement.js     pasted-statement format detection, mechanical sample extraction, normalizer agent
lib/anticheat.js     anti-hardcoding scans, degenerate output, generator health, cross-variable constraint detection
lib/richdoc.js       rich document validation / sanitizing / wrapping (sandboxed iframe + CSP)
lib/explaindoc.js    Markdown lesson structure & code-fidelity validation
lib/profile.js       learner profile evidence gate and hallucination guard
lib/pricing.js       token accounting and cost estimation (cache-hit aware)
lib/workspace.js     workspace files, per-problem verified-artifact cache
lib/sandbox.js       Python/Node sandbox guards
electron/            desktop shell: window, tray, menu, smoke self-test, CF fetch browser channel
public/              build-free frontend (app.js, md.js renderer, rich/ design system, vendored libs)
scripts/             mock LLM/CF servers, unit & end-to-end tests, probes, packaging, icons
.probe/              developer probes (concurrency timing, document rendering/leaks, round auditing)
```

---

## Development and tests

```bash
npm test                  # end-to-end: boots mock services with an isolated data dir, ~215 checks
npm run test:units        # unit suites: anticheat / explaindoc / statement+profile / pricing / parallel / harness
npm run test:harness      # orchestrator unit tests (contract slicing, sample isolation, workspace, rich docs)
npm run test:runner       # local runner unit tests (compile / compare / timeout / C++23)
npm run test:parallel     # parallel generation, cancellation, budget guards, generator-data invariants
npm run test:agentruns    # agent workbench event attribution under concurrency
node scripts/run-smoke.js # desktop smoke test (hidden window; --packaged to test the built app)
npm run mock              # mock LLM endpoint on :3999
node scripts/mock-cf.js   # mock Codeforces on :3998
node .probe/probe-health.js   # health table for the most recent rounds (calls, cost, leaks, verdicts)
npm run pack              # build the portable folder dist/CFCoach-win32-x64 (keeps data/ next to the exe)
```

All tests use isolated `.test-data/` directories, so your real data is never touched.
Frontend dependencies (marked, highlight.js, KaTeX) are vendored under `public/vendor/` — no CDN requests.

---

## FAQ

- **The fetch was blocked / 403?** Use the embedded browser path automatically, configure a local proxy, or paste
  the statement — pasting always works and goes through exactly the same pipeline.
- **Why did the answer say "I could not verify this"?** Verification is a promise, not decoration: if stress
  testing does not converge within the budget, the coach says so, and lists what it tried.
- **Why is a round expensive/slow sometimes?** Reasoning models can spend 5 minutes per call. Budgets cap a round
  at 40 calls / 20 minutes; giving roles their own models (cheap generator, strong solution) is the biggest lever.
- **Nothing was generated?** You still get a mechanical summary (where it stopped, what ran, what to try), plus the
  decision trace — a round never ends with an empty message.
- **Where is my data?** In `data/` next to the app. Delete the folder to reset everything.

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
  code-only prompt and a larger output cap, and degrades honestly if that fails too.

---

## License

MIT — see [LICENSE](LICENSE).
