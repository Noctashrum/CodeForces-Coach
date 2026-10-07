/**
 * 消融实验的两个档位（L2 = cf-coach 本体，由主程序自己跑，不在本目录）。
 *
 *  L0 裸模型      ：一次调用，没有工具、没有循环、没有验证。题面进去，回答出来。
 *  L1 裸 agent    ：同一个模型接口 + 同一个工具循环（复用 lib/agentloop.js），
 *                   工具只有"写文件/读文件/编译运行/对拍"；提示词明确要求它对拍。
 *
 * 为什么 L1 复用主程序的 agentloop：**为了把"循环实现"这个混淆变量消掉**。
 * 三档的差别被压到两件事上——① 有没有工具与循环；② 有没有 cf-coach 的 harness
 * （题面整理 agent、正解/暴力/生成器三件套、判据归一化、证据门、图文文档）。
 * 这样 L2 - L1 才是"harness 的净贡献"，而不是"谁的循环写得好"。
 */
'use strict';

const path = require('path');
const agentloop = require('../../lib/agentloop');
const llm = require('../../lib/llm');
const env = require('./env');
const record = require('./record');
const { createL1Tools, runtimeHint } = require('./tools');
const runner = require('../../lib/runner');
const harness = require('../../lib/harness');

/** 三个档位共用的题面投喂格式（同一份文本、同一个问法） */
function userPrompt(problem, statement) {
  const title = [problem.contestId && problem.index ? problem.contestId + problem.index : problem.id,
    problem.name ? '· ' + problem.name : ''].join(' ').trim();
  return '题目：' + title + '\n\n' + '【题面】\n' + String(statement || '').trim()
    + '\n\n【要求】请给出解题思路，并在最后给出**一份完整、可直接编译运行的代码**（放在 ```cpp 或 ```python 代码块里）。';
}

const SYSTEM_L0 = [
  '你是一位算法竞赛选手。',
  '你只能凭自己的推理作答：没有任何工具、不能运行代码、不能对拍。',
  '请给出解题思路与最终代码，用中文说明。'
].join('\n');

/**
 * 「这一轮只输出一个代码块」硬要求 —— L0C 档（裸模 + 代码先行）追加在用户问法末尾。
 *
 * 与 .probe/probe-dilution.js 里的 CODE_ONLY **逐字相同**：报告里"同一份提示词 0/2 AC → 2/2 AC、
 * token −18%、花费 −18%"就是这个开关带来的，改一个字就不是同一个实验了。
 *
 * 为什么需要它：输出 token 上限（服务商默认 65,536）截断时保住的是回答的**头部**，
 * 所以"先讲思路再给代码"在难题上会稳定地一条代码都交不出来。
 */
const CODE_ONLY = '\n\n---\n【格式硬要求】这一轮**只输出一个代码块**（```python 或 ```cpp）。'
  + '不要写任何解释、思路、复杂度、前言或后记 —— 只有代码块。';

async function systemL1() {
  return [
    '你是一位算法竞赛选手。',
    '你可以使用工具：把代码写成文件、读文件、编译运行、以及对拍（stress_test）。',
    await runtimeHint(),
    '【硬要求】',
    '1. 你必须**自己**写一份暴力解（brute）与一份随机数据生成器（gen），用 stress_test 对拍，直到通过为止；',
    '   对拍发现不一致就修代码，然后重新对拍。不要跳过这一步。',
    '2. 最后把最终正解写入工作目录的 solution.py（或 solution.cpp，取决于本机可用运行时），',
    '   并在回答里给出这份最终代码（放在 ``` 代码块里）+ 思路 + 复杂度。',
    '3. 步数有限（每一步一次工具调用）。**先把能 AC 的正解写进 solution.py，再做额外的验证**：',
    '   宁可少写几个辅助脚本，也不要到最后一步还没落盘正解。',
    '不要输出与解题无关的内容。'
  ].join('\n');
}

/** 从运行目录里取模型最终落盘的正解（L1 用它；没有就回落到从正文抽代码块） */
function readSolutionFile(dir, preferLang) {
  const fs = require('fs');
  const names = preferLang === 'python'
    ? ['solution.py', 'sol.py', 'main.py', 'solution.cpp', 'sol.cpp', 'main.cpp']
    : ['solution.cpp', 'sol.cpp', 'main.cpp', 'solution.py', 'sol.py', 'main.py'];
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        return { lang: /\.py$/.test(n) ? 'python' : 'cpp', code: fs.readFileSync(p, 'utf8'), source: 'file:' + n };
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

// ── 单次调用的输出预算：三档必须一致，否则量的是"预算管理"不是"提示词" ──────────────
//
// 事实（2026-10-07，L0+ 在 2268A / 2267F2 / 2268F / 2268C / 2268D 上）：
// `answers/L0+-<题>.md` **0 字节**、`completionTokens=65536`、`finish_reason=length`、
// `request.maxTokens=null`。连起来就是一句话：**输出预算被"思考"吃满了，正文一个字符都没轮上**。
//
// 链条（都在源码里）：这三档原来传 `maxTokens: undefined` → `lib/llm.js:111` 把它算成 0 →
// `lib/llm.js:159` 请求体里**根本没有 max_tokens 字段**（不是"写死 65536"，是"没传、服务商默认接管"）
// → 推理模型的思考可以把默认上限整段吃光。
//
// 而 L2 那边不会这样：`lib/harness.js:980` 首轮就发 `CODE_ATTEMPT_MAX_TOKENS = 8192`，
// 撞顶后还有"落码抢救"（`lib/harness.js:1048-1072`：把上一轮**思考尾巴**喂回 + `reasoning_effort:'none'`
// + 抬到 `TRUNCATED_RETRY_MAX_TOKENS = 65536`）。所以 `L2 − L0+` 里混着"L2 多了一次抢救机会"——
// 那是编排给的**机会**，不是编排更会**解题**。要让对照实验成立，三档必须同样"先小上限、撞顶才抢救"。
//
// 于是这三个常量抄的是 L2 的数值：
const ATTEMPT_MAX_TOKENS = 8192;       // = lib/harness.js:980 CODE_ATTEMPT_MAX_TOKENS
const SALVAGE_MAX_TOKENS = 65536;      // = lib/harness.js:997 TRUNCATED_RETRY_MAX_TOKENS
const SALVAGE_TAIL_CHARS = 3000;       // = lib/harness.js:998 SALVAGE_TAIL_CHARS
const AGENT_STEP_MAX_TOKENS = 16384;   // = lib/harness.js:987 PROSE_ATTEMPT_MAX_TOKENS（L1 的通用角色）

/**
 * 一次调用；如果这次没交出可用的代码块（空白 **或** 撞长度上限被截断），就按 L2 的同款做法
 * 抢救一次：把上一次的思考尾巴喂回去 + 关思考 + 抬上限。
 *
 * 判据与 `lib/harness.js:1087` 的 `empty` 完全一致（`wantCode` 分支）：**正文里没有代码块**
 * 就算没交出来 —— 不论 finish_reason 是 length 还是 stop（只写思路不写代码同样是没交出来）。
 *
 * @returns {Promise<{res:object, usage:object, calls:number, salvaged:boolean, firstFinishReason:string|null}>}
 *   usage 是两次调用的**合计**（成本必须按合计算，否则抢救一次就把钱记漏了）。
 */
async function callWithBudget(o) {
  const call = (maxTokens, reasoningEffort, content) => llm.callModel({
    provider: o.target.provider,
    model: o.target.model,
    system: o.system,
    messages: [{ role: 'user', content }],
    maxTokens, reasoningEffort, stream: true
  });
  const addUsage = (a, b) => ({
    promptTokens: ((a && a.promptTokens) || 0) + ((b && b.promptTokens) || 0),
    completionTokens: ((a && a.completionTokens) || 0) + ((b && b.completionTokens) || 0)
  });
  const first = await call(o.maxTokens || ATTEMPT_MAX_TOKENS, undefined, o.user);
  const firstText = String((first && first.content) || '');
  const firstFinishReason = (first && first.finishReason) || null;
  const firstCode = record.extractFinalCode(agentloop.stripLeakMarkup(firstText));
  if (firstCode && firstCode.code) {
    return { res: first, usage: addUsage(first.usage, null), calls: 1, salvaged: false, firstFinishReason };
  }
  const tail = String((first && (first.reasoningTail || first.reasoning)) || '');
  const retryUser = (tail
    ? '【你上一步的思考（这一轮的输出被长度上限截断了，正文一个字都没写出来）】\n'
      + tail.slice(-SALVAGE_TAIL_CHARS) + '\n\n'
    : '')
    + o.user
    + '\n\n【系统重试】上一次没有交出完整正文（只见思考、没有代码块）。'
    + '不要再推理：直接输出一个完整可运行的代码块（读标准输入、写标准输出），代码之外一个字都不要写。';
  const second = await call(Math.max(o.maxTokens || 0, SALVAGE_MAX_TOKENS), 'none', retryUser);
  return {
    res: second, usage: addUsage(first.usage, second.usage), calls: 2, salvaged: true,
    firstFinishReason, firstTextChars: firstText.length, salvagePromptChars: retryUser.length
  };
}

/**
 * L0：一次调用，不提供任何工具。
 * ctx.codeOnly = true 时是 L0C 档（同一份题面 + 「只输出一个代码块」）—— 这两档的差别
 * 只有那一段格式要求，用来把"到底是不懂还是没交出来"分开。
 * @param {{problem:object, statement:string, target:object, params:object, run:object, name:string, codeOnly?:boolean}} ctx
 */
async function runL0(ctx) {
  const { problem, statement, target, params, run, name } = ctx;
  const codeOnly = !!ctx.codeOnly;
  const LEVEL = codeOnly ? 'L0C' : 'L0';
  const t0 = Date.now();
  const rec = {
    level: LEVEL, problem: problem.id, model: target.model, providerId: target.providerId,
    startedAt: new Date(t0).toISOString(), system: SYSTEM_L0, tools: [],
    codeOnly,
    statementSha: env.sha256(statement), statementFile: problem.statementFile || null,
    request: { stream: true, maxTokens: params.maxTokens || null, hasTools: false, codeOnly,
      budget: { attemptMaxTokens: ATTEMPT_MAX_TOKENS, salvageMaxTokens: SALVAGE_MAX_TOKENS } }
  };
  try {
    const out = await callWithBudget({
      target, system: SYSTEM_L0, maxTokens: params.maxTokens,
      user: userPrompt(problem, statement) + (codeOnly ? CODE_ONLY : '')
    });
    return finishSingleAnswer(rec, out.res, run, name, t0, out);
  } catch (e) {
    rec.ok = false;
    rec.error = (e && e.message) || String(e);
    rec.ms = Date.now() - t0;
    return run.add(rec);
  }
}

/**
 * 单次调用型档位（L0 / L0C / L0+）共用的记录收尾。
 *
 * 抽出来只有一个目的：**让 L0+ 与 L0 在记账上不可能漂移**。三个档位的差别必须只体现在
 * system / user 上，任何"取码口径、截断口径、成本口径"的差别都会污染对照实验。
 */
function finishSingleAnswer(rec, res, run, name, t0, info) {
  const text = String((res && res.content) || '');
  rec.ok = !!text.trim();
  rec.error = rec.ok ? null : '模型没有返回正文' + (res && res.finishReason ? '（finish_reason=' + res.finishReason + '）' : '');
  // usage 用**两次调用合计**（info.usage）：抢救过一次就把钱记漏，成本口径会失真
  rec.usage = (info && info.usage) || (res && res.usage) || null;
  rec.steps = 1;
  rec.calls = (info && info.calls) || 1;
  if (info && info.salvaged) {
    rec.salvaged = true;
    rec.firstFinishReason = info.firstFinishReason || null;
    if (info.firstTextChars != null) rec.firstTextChars = info.firstTextChars;
  }
  rec.toolsUsed = [];
  // 长度上限是"没跑完"，不是"答错"：记下来，判分/统计时不能把它算成能力证据
  rec.finishReason = (res && res.finishReason) || null;
  rec.truncated = /length|max_tokens/i.test(String(rec.finishReason || ''));
  if (agentloop.hasLeakMarkup(text)) rec.leakMarkup = true;
  const clean = agentloop.stripLeakMarkup(text);
  const code = record.extractFinalCode(clean);
  rec.code = code ? code.code : null;
  rec.codeLang = code ? code.lang : null;
  rec.codeSource = code ? (code.blockIndex >= 0 ? 'answer-block#' + code.blockIndex : 'answer-inline') : null;
  if (!code) {
    rec.ok = false;
    rec.codeMissing = true;
    rec.error = rec.truncated
      ? '回答里没有可用的代码块（输出撞到长度上限 finish_reason=length，正文被截断 —— 这不是答错）'
      : '回答里没有可用的代码块';
  }
  rec.answerFile = run.saveAnswer(name, clean);
  rec.transcriptFile = null;
  rec.ms = Date.now() - t0;
  return run.add(rec);
}

/**
 * L0+：「与 L2 题解 Agent **逐字相同**的提示词纪律与输入，但只有一次调用、没有工具」。
 *
 * ## 为什么必须有这一档（否则整个消融实验的判据是错的）
 *
 * `L2 − L0` 把两件完全不同的事混成了一个变量：
 *   ① cf-coach 的 **harness**：暴力解 + 生成器 + 对拍 + 错因仲裁 + 重写回路 + 讲解；
 *   ② **提示词纪律**：L2 的题解 Agent 是"只输出一个代码块、不准写思路"（`solutionSystem`），
 *      并且拿到机械抽取的 I/O 契约与官方样例 —— 而 L0 拿到的是"先讲思路再给代码"的裸问法。
 * 实测 2267F2 就是被①还是②决定的，光看 L2 vs L0 说不清。
 *
 * L0+ 用 `harness.solutionSystem(lang)`（与 L2 同一个函数、同一段文本）与
 * `harness.buildSolutionUser(...)`（题面 + `extractContract` 抽出的 I/O 契约 + 官方样例，
 * 与 L2 题解 Agent 同一段拼装），没有工具、没有重写、没有讲解。于是：
 *   · `L0+ − L0`  = 提示词纪律 + 契约/样例投喂的净贡献
 *   · `L2  − L0+` = harness 的净贡献 ← 这才是消融实验要回答的问题
 *
 * **输出预算与 L2 对齐**（见 `callWithBudget` 上方的长注释）：首轮上限与 L2 首轮相同，
 * 没交出代码块时允许**一次**与 L2 同款的抢救。这一条是 2026-10-07 补的：在这之前三档
 * 都是"不传 max_tokens"，服务商默认上限让思考吃光预算，五个 2600 分档的格子交了 0 字节
 * 白卷 —— 那量的是预算管理，不是提示词。抢救与否如实记在 `rec.salvaged / rec.calls`。
 *
 * 与 L0C 的区别：L0C 只多一句"只输出代码块"（同一个裸 system），
 * L0+ 换的是**整套题解 Agent 纪律与输入**。两者不是替代关系，L0C 是拆"没交出来 vs 不懂"的探针。
 *
 * @param {{problem:object, statement:string, target:object, params:object, run:object, name:string, lang?:string}} ctx
 */
async function runL0Plus(ctx) {
  const { problem, statement, target, params, run, name } = ctx;
  const LEVEL = 'L0+';
  const lang = ctx.lang === 'python' ? 'python' : 'cpp';
  const t0 = Date.now();
  const system = harness.solutionSystem(lang);
  const title = [problem.contestId && problem.index ? problem.contestId + problem.index : problem.id,
    problem.name || problem.title || ''].join(' ').trim();
  const user = harness.buildSolutionUser({
    statement,
    samples: problem.samples || [],
    conv: { title }
  }, harness.extractContract(statement));
  const rec = {
    level: LEVEL, problem: problem.id, model: target.model, providerId: target.providerId,
    startedAt: new Date(t0).toISOString(), system, tools: [], lang,
    statementSha: env.sha256(statement), statementFile: problem.statementFile || null,
    request: {
      stream: true, maxTokens: params.maxTokens || null, hasTools: false,
      systemFrom: 'harness.solutionSystem', userFrom: 'harness.buildSolutionUser',
      discipline: 'code-only', samples: (problem.samples || []).length,
      budget: { attemptMaxTokens: ATTEMPT_MAX_TOKENS, salvageMaxTokens: SALVAGE_MAX_TOKENS }
    }
  };
  try {
    const out = await callWithBudget({ target, system, user, maxTokens: params.maxTokens });
    return finishSingleAnswer(rec, out.res, run, name, t0, out);
  } catch (e) {
    rec.ok = false;
    rec.error = (e && e.message) || String(e);
    rec.ms = Date.now() - t0;
    return run.add(rec);
  }
}

/**
 * L1：同一个工具循环 + 通用工具面（写文件/运行/对拍）。
 */
async function runL1(ctx) {
  const { problem, statement, target, params, run, name, maxSteps, iterations } = ctx;
  const t0 = Date.now();
  const dir = run.sandboxDir(name);
  const tools = await createL1Tools({ dir, iterations });
  const system = await systemL1();
  const events = [];
  const rec = {
    level: 'L1', problem: problem.id, model: target.model, providerId: target.providerId,
    startedAt: new Date(t0).toISOString(), system,
    tools: tools.map((t) => t.name),
    statementSha: env.sha256(statement), statementFile: problem.statementFile || null,
    request: { stream: true, maxTokens: params.maxTokens || null, hasTools: true, maxSteps: maxSteps || 20,
      budget: { stepMaxTokens: params.maxTokens || AGENT_STEP_MAX_TOKENS, finalizeAttemptMaxTokens: ATTEMPT_MAX_TOKENS,
        finalizeSalvageMaxTokens: SALVAGE_MAX_TOKENS } }
  };
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  try {
    const res = await agentloop.runTurn({
      provider: target.provider,
      model: target.model,
      system,
      history: [],
      userText: userPrompt(problem, statement),
      tools,
      maxSteps: maxSteps || 20,
      maxTokens: params.maxTokens || AGENT_STEP_MAX_TOKENS,
      onUsage: (u) => {
        if (u && u.promptTokens != null) usage.promptTokens += u.promptTokens;
        if (u && u.completionTokens != null) usage.completionTokens += u.completionTokens;
        usage.calls++;
      },
      onToolStart: (call) => events.push({ t: Date.now() - t0, kind: 'toolStart', name: call && call.name }),
      onToolEnd: (call, ok, out, ms) => events.push({
        t: Date.now() - t0, kind: 'toolEnd', name: call && call.name, ok: !!ok, ms,
        args: clipArgs(call && call.args), result: clipText(out, 1500)
      }),
      onReasoning: () => {}
    });
    const text = String(res.text || '');
    rec.steps = res.steps;
    rec.calls = usage.calls || (res.usage && res.usage.calls) || null;
    rec.toolsUsed = res.toolsUsed || [];
    rec.usage = { promptTokens: usage.promptTokens || (res.usage && res.usage.promptTokens) || 0,
      completionTokens: usage.completionTokens || (res.usage && res.usage.completionTokens) || 0,
      calls: rec.calls, estimated: !!(res.usage && res.usage.estimated) };
    const rt = await runner.availableRuntimes();
    const fromFile = readSolutionFile(dir, rt.python ? 'python' : 'cpp');
    const clean = agentloop.stripLeakMarkup(text);
    const fromText = record.extractFinalCode(clean);
    // 公平的收尾机会：L1 的硬要求是"把正解写进 solution.py"，而 agentloop 自带的收尾
    // 只要求"最终回答"。步数用尽的跑法常把最后一步花在调工具上（实测 2268A：第 20 步
    // 还在写 check.cpp，整跑从没写过 solution.py），于是既没落盘文件、正文也没有代码块。
    // 这里再给**一次**不要工具、只要代码的调用，并把这次调用如实记进 rec.finalize。
    let finalClean = null;
    let finalFile = null;
    if (!fromFile && !fromText) {
      const fin = await lastChanceCode({
        provider: target.provider, model: target.model, system, problem, statement, maxTokens: params.maxTokens
      });
      usage.promptTokens += fin.usage.promptTokens;
      usage.completionTokens += fin.usage.completionTokens;
      usage.calls += (fin.calls || 1);
      finalClean = fin.text;
      finalFile = run.saveAnswer(name + '-final', fin.text);
      rec.finalize = { calls: fin.calls || 1, chars: fin.text.length, code: !!record.extractFinalCode(fin.text),
        salvaged: !!fin.salvaged,
        promptTokens: fin.usage.promptTokens, completionTokens: fin.usage.completionTokens };
    }
    const fromFinal = finalClean ? record.extractFinalCode(finalClean) : null;
    if (fromFile) {
      rec.code = fromFile.code; rec.codeLang = fromFile.lang; rec.codeSource = fromFile.source;
    } else if (fromText) {
      rec.code = fromText.code; rec.codeLang = fromText.lang; rec.codeSource = 'answer';
    } else if (fromFinal) {
      rec.code = fromFinal.code; rec.codeLang = fromFinal.lang; rec.codeSource = 'answer-final';
    } else {
      rec.code = null; rec.codeLang = null; rec.codeSource = null;
    }
    rec.ok = !!rec.code;
    rec.error = rec.ok ? null : '既没有落盘的正解文件，回答里也没有代码块（收尾那次"只要代码"的调用也没给出代码块）';
    if (finalFile) rec.finalAnswerFile = finalFile;
    rec.calls = usage.calls || rec.calls;
    rec.usage = { promptTokens: usage.promptTokens || (res.usage && res.usage.promptTokens) || 0,
      completionTokens: usage.completionTokens || (res.usage && res.usage.completionTokens) || 0,
      calls: rec.calls, estimated: !!(res.usage && res.usage.estimated) };
    rec.answerFile = run.saveAnswer(name, clean);
    rec.transcriptFile = run.saveTranscript(name, events);
    rec.ms = Date.now() - t0;
    return run.add(rec);
  } catch (e) {
    rec.ok = false;
    rec.error = (e && e.message) || String(e);
    rec.usage = usage;
    rec.ms = Date.now() - t0;
    rec.transcriptFile = run.saveTranscript(name, events);
    return run.add(rec);
  }
}

/**
 * 收尾调用：不给工具、不给历史，只要最终正解代码。
 *
 * 与 agentloop 自带的收尾不同：那里带着整段工具历史（模型会继续"调工具"），
 * 这里只重发题面 + 一句明确指令，让模型有机会把答案**写下来**。
 * 返回的 usage 必须计入该档位成本——多花的这一次 token 是真实的。
 */
async function lastChanceCode(o) {
  const prompt = userPrompt(o.problem, o.statement)
    + '\n\n---\n【收尾·系统要求】不要再调用任何工具（现在也没有工具可用，你前面的工具过程已经结束）。'
    + '请直接输出**最终正解**的完整代码，放在一个代码块里（```python 或 ```cpp，与你的解法语言一致）：'
    + '代码要能直接编译/运行，读标准输入、写标准输出。除了这个代码块，不要再输出任何别的内容。';
  // 与 L0/L0C/L0+ 同一套预算纪律（首轮小上限 + 没交出代码则抢救一次）：收尾调用同样是
  // "一次裸调用"，不能在这一步比别的档位多吃预算，否则三档的差距又变成预算差距。
  const out = await callWithBudget({
    target: { provider: o.provider, model: o.model }, system: o.system, user: prompt, maxTokens: o.maxTokens
  });
  const text = agentloop.stripLeakMarkup(String((out.res && out.res.content) || ''));
  return {
    text,
    salvaged: !!out.salvaged,
    calls: out.calls || 1,
    usage: {
      promptTokens: (out.usage && out.usage.promptTokens) || 0,
      completionTokens: (out.usage && out.usage.completionTokens) || 0
    }
  };
}

function clipText(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function clipArgs(args) {
  const t = String(args == null ? '' : args);
  return t.length > 500 ? t.slice(0, 500) + '…' : t;
}

module.exports = { SYSTEM_L0, CODE_ONLY, systemL1, userPrompt, runL0, runL0Plus, runL1, readSolutionFile };
