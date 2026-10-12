/**
 * L2 档 = cf-coach 本体（无头跑）。
 *
 * 为什么要无头跑主程序，而不是"人在界面里点一遍"：
 *  ① 消融要的是**同一条链**（同样的 harness、同样的提示词、同样的判据）在几十道题上的结果，
 *     界面点击既不可复现也不可 diff；这里的 runPipeline 就是主程序自己调用的那个函数。
 *  ② 记录必须能自证：题面 sha、每个角色 Agent 的调用次数、验证报告（含覆盖范围）、最终交付的代码。
 *
 * 关键隔离：工作区根目录被指到 <实验目录>/l2-data/workspace，**绝不碰用户真实 data/**。
 *
 * 口径说明（写进记录，评审要看）：
 *  · L2 的"题面"和 L0/L1 用的是**同一份文本、同一个 sha**（信息预算对齐）；
 *  · L2 的最终代码取自**工作区里交付的文件**（= 人从界面上拿到的那个版本），不是过程产物；
 *  · `assertedVerified` = 链自己声称"已验证"（verification.status === 'ok'）。
 *    这个字段与判分结果对照，就能算出**假自信率**（声称已验证但差分判 WA 的比例）——
 *    这正是"验证链到底有没有用"最硬的指标。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('../../lib/harness');
const workspace = require('../../lib/workspace');
const llm = require('../../lib/llm');
const agentloop = require('../../lib/agentloop');
const env = require('./env');
const record = require('./record');
const ruler = require('./ruler');
const cffetch = require('./cffetch');

/** 系统提示词 → 角色（callAgent 一般会直接给 role，这里只作为兜底） */
const ROLE_MARKERS = [
  [/【题解 Agent】/, 'solution'],
  [/【暴力 Agent】/, 'brute'],
  [/【数据生成 Agent】/, 'gen'],
  [/【手算锚点 Agent】/, 'witness'],
  [/【讲解 Agent】/, 'explainer'],
  [/【讲解提纲 Agent】/, 'plan'],
  [/【路由判断器】/, 'router'],
  [/【做法评估 Agent】/, 'assess'],
  [/【错因仲裁 Agent】/, 'adjudicate']
];

function roleOf(system) {
  const s = String(system || '');
  for (const pair of ROLE_MARKERS) if (pair[0].test(s)) return pair[1];
  return 'other';
}

/**
 * 解题臂（用户口径 m25200，2026-10-10 凌晨）：**只有题解 Agent 与暴力解 Agent 是"真正解题"的**，
 * 所以 ¥/AC 只该记这两个角色的钱。讲解提纲 / 讲解正文 / 手算锚点 / 数据生成器 / 错因仲裁 / checker
 * 买的是**别的交付物**（讲解、尺子、验证），把它们均摊进 ¥/AC 等于让"讲解贵"去顶替"解题贵" ——
 * 而实测差距恰恰在解题上（没解出来的五格里，讲解线占 30%–55% 花费）。
 * 记录里同时留 total（全链）与 cost（解题臂），口径写在数据里而不是写在文档里。
 */
const SOLVE_ROLES = ['solution', 'brute'];

function solveArmCost(costByRole) {
  const cbr = costByRole || {};
  const roles = SOLVE_ROLES.filter((r) => typeof cbr[r] === 'number');
  let cost = 0;
  roles.forEach((r) => { cost += cbr[r]; });
  let total = 0;
  Object.keys(cbr).forEach((r) => { if (typeof cbr[r] === 'number') total += cbr[r]; });
  return { cost, roles, total, share: total > 0 ? cost / total : null };
}

/** 逐角色算钱（同一张价目表）→ `{costByRole, solveArm}`；单价未知的角色记 null，宁可在表里写 n/a 也不编数字 */
function priceRoles(cfg, target, tokByRole) {
  const costByRole = {};
  Object.keys(tokByRole || {}).forEach((r) => {
    const c = record.costOf(cfg, target.providerId, target.model, tokByRole[r]);
    costByRole[r] = c && typeof c.amount === 'number' ? c.amount : null;
  });
  return { costByRole, solveArm: solveArmCost(costByRole) };
}

let wsRoot = null;

/**
 * 工作区根目录指向**本轮实验**的独立子目录（幂等）。
 *
 * 为什么必须按轮次隔离（P0-③，2026-10 消融报告）：工作区原来在一次实验里跨轮共享，
 * 于是"上一轮遗留的 sol.py"会被下一轮当成自己的产物读走 —— 2268A 的失败轮因此被记成
 * "有代码、验证通过"，交付的却是 4 小时前那一轮的文档与代码，人工复核时根本分不出来。
 * 现在每轮从空工作区开始：本轮跑成什么样，记录里就是什么样（同一批次内所有题共享一个根，
 * 但每题一个会话目录，互不干扰）。
 */
function prepareWorkspace(outDir, roundId) {
  const safe = String(roundId == null || roundId === '' ? 'default' : roundId).replace(/[^A-Za-z0-9_.-]/g, '');
  const root = path.join(outDir, 'l2-data', safe);
  if (wsRoot !== root) {
    workspace.setRoot(root);
    wsRoot = root;
  }
  return root;
}

/** 造一个"会话对象"：有题号就用 cf-<contestId><index> 作共享键（与真实产品一致） */
function convFor(problem) {
  const hasCf = !!(problem.contestId && problem.index);
  return {
    id: hasCf ? ('cf-' + problem.contestId + String(problem.index).toUpperCase())
      : ('ab-' + String(problem.id || 'x').replace(/[^a-zA-Z0-9_-]/g, '')),
    cfProblem: hasCf ? { contestId: problem.contestId, index: problem.index, title: problem.name || '' } : null,
    title: problem.name || problem.id,
    problemMeta: { rating: problem.rating || null }
  };
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 应用侧题面缓存的候选目录（谁有这道题的 JSON 就用谁）。
 *
 * 为什么是"候选目录列表"而不是一个目录：缓存可能在两个地方 —— 打包版 exe 的数据目录
 * （`env.dataDir()`，人用界面取题时写进去的）与仓库开发目录（`data/cf-problems`，本机
 * 取题/测试时写进去的）。两边都可能有一半，硬编码一个必然漏。
 */
function cacheDirs() {
  const out = [];
  try {
    const d = cffetch.appCacheDir();
    if (d) out.push(d);
  } catch (e) { /* 没有应用数据目录也没关系，下面还有仓库目录 */ }
  out.push(path.join(__dirname, '..', '..', 'data', 'cf-problems'));
  return out;
}

function pickCacheDir(id) {
  const dirs = cacheDirs();
  for (const d of dirs) {
    try {
      if (fs.existsSync(path.join(d, id + '.json'))) return d;
    } catch (e) { /* 读不到的目录直接跳过 */ }
  }
  return dirs[0] || null;
}

/**
 * 官方时限 —— 性能闸（批次③语言闸）唯一的合法判据。
 *
 * 为什么实验台要自己解析（2026-10-10 通宵实测踩到）：harness 解析时限只认 CF 题面里
 * "time limit per test: N seconds" 那一整句，而题库里的题面是**纯正文**（没有 CF 头），
 * 于是性能闸记 `perf-gate-skipped`（原文"题面里没解析出官方时限"）—— 语言闸在实验台里
 * **永远不会触发**：A1 实验里 2250C 就这么白跑了一格（lang=python、iters=60、status=ok）。
 *
 * 权威顺序与离线尺子**完全一致**（limits.json 覆盖 → 题库字段 → 应用侧题面缓存 → 默认值），
 * 且**解析不出来就不传**：宁可不做性能闸，也绝不拿自己编的时限当判据（这条纪律写在
 * harness 的 perf-gate-skipped 分支里，实验台不许松动）。
 */
function resolveTimeLimit(problem, outDir) {
  let overrides = {};
  try {
    overrides = JSON.parse(fs.readFileSync(path.join(outDir, 'limits.json'), 'utf8')) || {};
  } catch (e) { overrides = {}; }
  let lim = null;
  try {
    lim = ruler.resolveLimits(problem, { overrides, cacheDir: pickCacheDir(problem.id) });
  } catch (e) { lim = null; }
  if (!lim || !(lim.timeLimitMs > 0) || lim.source === 'default') {
    return { timeLimitMs: 0, source: (lim && lim.source) || 'none' };
  }
  return { timeLimitMs: Number(lim.timeLimitMs), source: lim.source, memoryLimitMb: lim.memoryLimitMb || null };
}

/**
 * 跑一次 L2。
 * @param {{problem:object, statement:string, target:object, params:object, run:object, name:string,
 *          lang?:string, rich?:boolean, iterations?:number, maxStressMs?:number, depth?:string}} ctx
 */
async function runL2(ctx) {
  const { problem, statement, target, params, run, name } = ctx;
  const t0 = Date.now();
  const roundId = (run && run.id) ? String(run.id) : 'default';
  prepareWorkspace(run.outDir, roundId);
  const conv = convFor(problem);
  const key = workspace.keyFor(conv);
  const lang = ctx.lang === 'cpp' ? 'cpp' : 'python';
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const byRole = {};
  const tokByRole = {};   // 逐角色 token：让"钱花在哪个 Agent 上"可自证（¥/AC 只记解题臂，见 solveArmCost）
  const events = [];
  // 官方时限：解析得到才交给 harness（性能闸/语言闸的判据），解析不到就 0 = 不做性能闸。
  const tl = resolveTimeLimit(problem, run.outDir);
  const rec = {
    level: 'L2', problem: problem.id, model: target.model, providerId: target.providerId,
    startedAt: new Date(t0).toISOString(),
    system: 'cf-coach harness.runPipeline（题解/暴力/生成器/对拍/仲裁/讲解 内部多 Agent 链）',
    tools: ['harness.runPipeline'],
    statementSha: env.sha256(statement), statementFile: problem.statementFile || null,
    request: {
      stream: true, hasTools: false, pipeline: 'cf-coach/runPipeline',
      intent: 'full', rich: !!ctx.rich, lang, wsKey: key,
      perTier: ctx.iterations || 30, maxStressMs: ctx.maxStressMs || 90000, depth: ctx.depth || 'L3',
      docEffort: ctx.docEffort || '',   // '' = 默认（讲解带思考）；'none' = 实验臂"关思考写文档"
      codeEffort: ctx.codeEffort || '',  // '' = 默认（代码角色带思考）；'none' = 实验臂"关思考直接出码"
      explainUnsolved: ctx.explainUnsolved || '',  // '' / 'short' = 没解出来就**不写讲解**（默认口径）；'rich' = 旧行为（照写，A/B 用）
      timeLimitMs: tl.timeLimitMs || 0,  // 0 = 没有官方时限（性能闸会跳过，不编时限）
      timeLimitSource: tl.source          // override / problem / cache / none —— 记录里要能自证
    }
  };

  const callAgent = async (o) => {
    const role = (o && o.role) || roleOf(o && o.system);
    byRole[role] = (byRole[role] || 0) + 1;
    const label = (o && o.label) || role;
    const at = Date.now() - t0;
    events.push({ t: at, kind: 'agentStart', role, label });
    try {
      const res = await llm.callModel({
        provider: target.provider,
        model: target.model,
        system: o.system,
        messages: [{ role: 'user', content: o.user }],
        // 输出上限：harness 现在会给代码类角色显式请求上限（首轮 32,768、截断后的"落码抢救" 65,536），
        // 但 `--max-tokens N` 是消融实验声明的"信息预算"，是**硬天花板** —— 设了它，L0/L1/L2 都不得超过它，
        // 否则跨档对比就不是同一个预算了。没设（默认，文档里的标准跑法）时完全按 harness 的请求走。
        maxTokens: (params.maxTokens && (o && o.maxTokens))
          ? Math.min(o.maxTokens, params.maxTokens)
          : ((o && o.maxTokens) || params.maxTokens || undefined),
        // reasoningEffort：harness 的"落码抢救"要靠它把关思考的请求传到服务商（内容为 'none'）。
        // 不转发这里，抢救就只是换了个问法，钱照烧（见 .probe/probe-sol-unblock.js）。
        reasoningEffort: (o && o.reasoningEffort) || undefined,
        stream: (o && o.stream) !== false,
        signal: o && o.signal,
        onUsage: (u) => {
          if (u && u.promptTokens != null) { usage.promptTokens += u.promptTokens; usage.calls++; }
          if (u && u.completionTokens != null) usage.completionTokens += u.completionTokens;
          const tr = tokByRole[role] || (tokByRole[role] = { promptTokens: 0, completionTokens: 0, calls: 0 });
          if (u && u.promptTokens != null) { tr.promptTokens += u.promptTokens; tr.calls++; }
          if (u && u.completionTokens != null) tr.completionTokens += u.completionTokens;
          if (typeof o.onUsage === 'function') o.onUsage(u);
        },
        onMeta: typeof o.onMeta === 'function' ? o.onMeta : undefined
      });
      events.push({ t: Date.now() - t0, kind: 'agentEnd', role, label, ms: Date.now() - t0 - at, out: clip(res.content, 300) });
      return String(res.content || '');
    } catch (e) {
      events.push({ t: Date.now() - t0, kind: 'agentError', role, label, ms: Date.now() - t0 - at, error: clip((e && e.message) || e, 300) });
      throw e;
    }
  };

  try {
    const res = await harness.runPipeline({
      callAgent,
      workspace,
      wsKey: key,
      conv,
      lang,
      rating: problem.rating || null,
      statement,
      samples: problem.samples || [],
      intent: 'full',
      level: ctx.depth || 'L3',
      rich: !!ctx.rich,
      richTheme: 'dark',
      docEffort: ctx.docEffort === 'none' ? 'none' : '',
      codeEffort: ctx.codeEffort === 'none' ? 'none' : '',
      explainUnsolved: ctx.explainUnsolved || '',
      perTier: ctx.iterations || 30,
      maxStressMs: ctx.maxStressMs || 90000,
      // 复用已有一版题解（`{sol, brute, gen}`）：GUI 的"重新对拍"走的就是这条快通道。
      // 实验台也用它做**受控实验**：同一份慢代码喂进去，只让"性能优化提问"这一个变量变化
      // （.probe/probe-perf-reuse.js 的 F3' 取证）。不传 = 与从前逐字相同。
      reuse: ctx.reuse || undefined,
      // 性能闸（=批次③语言闸）的判据：0 会被 harness 当成"没有官方时限"，闸门照旧跳过。
      timeLimitMs: tl.timeLimitMs || 0,
      log: () => {},
      emit: (ev) => {
        if (!ev || !ev.type) return;
        if (ev.type === 'tool' && Array.isArray(ev.calls)) {
          ev.calls.forEach((c) => events.push({ t: Date.now() - t0, kind: 'phaseStart', name: c.name, args: clip(c.args, 300) }));
        } else if (ev.type === 'toolResult' && Array.isArray(ev.results)) {
          ev.results.forEach((r2) => events.push({ t: Date.now() - t0, kind: 'phaseEnd', name: r2.name, ok: r2.ok !== false, summary: clip(r2.summary, 300) }));
        }
      }
    });

    const v = res.verification || null;
    // 交付物 = 工作区里那份题解（可能被 P0 回退过）；没有才回落到链内存里的代码，最后才是讲解正文
    // 批次③：交付前语言闸可能把题解换成了另一种语言 → 以 pipeline 返回的 solLang 为准去找文件，
    // 否则会在"换成 C++"的格子上读到空（或把 C++ 代码按 Python 记进记录里）。
    const finalLang = res.solLang || lang;
    const fromWs = workspace.readSolFile ? workspace.readSolFile(key, finalLang) : null;
    let code = null;
    if (fromWs && fromWs.code && fromWs.code.trim()) {
      code = { code: fromWs.code, lang: fromWs.lang || finalLang, source: 'workspace:' + (fromWs.name || workspace.solName(finalLang)) };
    } else if (res.solCode && res.solCode.trim()) code = { code: res.solCode, lang: finalLang, source: 'pipeline:solCode' };
    else {
      const c = record.extractFinalCode(String(res.explainerText || ''));
      if (c) code = { code: c.code, lang: c.lang, source: 'explainer' };
    }

    rec.code = code ? code.code : null;
    rec.codeLang = code ? code.lang : null;
    rec.codeSource = code ? code.source : null;
    rec.ok = !!rec.code;
    rec.error = rec.ok ? null : ('验证链没有产出题解代码（status=' + (res.status || '?') + '）');
    rec.usage = {
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      calls: usage.calls, estimated: false
    };
    rec.calls = usage.calls;
    rec.steps = usage.calls;
    rec.roles = byRole;
    rec.usageByRole = tokByRole;
    // 逐角色算钱（同一张价目表）⇒ ¥/AC 可以只按"解题臂"记账（用户口径 m25200）
    const priced = priceRoles(ctx.cfg, target, tokByRole);
    rec.costByRole = priced.costByRole;
    rec.solveArm = priced.solveArm;
    rec.toolsUsed = Object.keys(byRole);
    rec.verification = v;
    rec.verificationStatus = v ? v.status : null;
    // P0-⑤（2026-10-09）：**"链声称已验证"必须与"验证范围完整"是同一件事**。
    //   原来只看 status==='ok'，于是库里出现 `assert=true` 而 `scope=false` 的假自信格子
    //   （2241B/2247B/1978D/1978E/2252F）。现在优先读 harness 新给的 claimVerified；
    //   老记录（没有该字段）回落到 status==='ok'，保持历史可比。
    rec.assertedVerified = v ? (v.claimVerified != null ? v.claimVerified === true : v.status === 'ok') : false;
    // 同一条纪律用在"验证范围"上：**harness 没报 scopeComplete 时不许当作 true**。
    // 原写法是 `v.scopeComplete !== false` —— 缺字段就成了 true（2026-10-10 实测：2247F 因反打表
    // 在早期出口返回，verification 里根本没有 scopeComplete，记录却写着 scope=Y，
    // 而那一格的真实结局是"题解被拒、一个字符都没交付"）。缺字段时与 assertedVerified 同口径回落。
    rec.scopeComplete = v ? (v.scopeComplete != null ? v.scopeComplete === true : v.status === 'ok') : false;
    rec.delivered = v ? (v.delivered || null) : null;
    rec.solRollback = v ? !!v.solRollback : false;
    rec.stressTruncated = v ? (v.stressTruncated || '') : '';
    rec.scopeNote = v ? (v.scopeNote || '') : '';
    rec.iterationsRun = v ? (v.iterations || 0) : 0;
    rec.trajectory = (res.trajectory || []).slice(-40).map((x) => ({ kind: x.kind, note: clip(x.note, 300) }));
    rec.minimalCase = res.minimalCase || null;
    rec.notes = res.notes || [];
    rec.richFallback = res.richFallback || null;
    rec.workspace = { key, dir: workspace.convDir(key), files: (workspace.listFiles(key) || []).map((f) => f.name) };
    rec.roundId = roundId;   // 这一条属于哪一轮（工作区/文档都按它隔离）
    const answerText = String(res.explainerText || '');
    if (agentloop.hasLeakMarkup(answerText)) rec.leakMarkup = true;
    rec.answerFile = run.saveAnswer(name, agentloop.stripLeakMarkup(answerText));
    if (res.richDoc) {
      const docsDir = record.ensureDir(path.join(run.outDir, 'docs'));
      // 文档名带上轮次号：否则失败轮没有文档时，界面上/交付包里挂着的还是上一轮那份同名旧文档
      // （2026-10 消融报告里 2268A 就是这样把 4 小时前的产物当成本轮结果的）。
      rec.docFile = path.join(docsDir, name + '-' + roundId + '.html');
      fs.writeFileSync(rec.docFile, res.richDoc, 'utf8');
      rec.richDocBytes = Buffer.byteLength(res.richDoc, 'utf8');
    }
    rec.transcriptFile = run.saveTranscript(name, events);
    rec.ms = Date.now() - t0;
    return run.add(rec);
  } catch (e) {
    rec.ok = false;
    rec.error = (e && e.message) || String(e);
    rec.usage = { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, calls: usage.calls, estimated: false };
    rec.calls = usage.calls;
    rec.roles = byRole;
    rec.usageByRole = tokByRole;
    const pricedW = priceRoles(ctx.cfg, target, tokByRole);   // 半路失败也留账：钱已经花掉了
    rec.costByRole = pricedW.costByRole;
    rec.solveArm = pricedW.solveArm;
    rec.toolsUsed = Object.keys(byRole);
    rec.ms = Date.now() - t0;
    rec.transcriptFile = run.saveTranscript(name, events);
    return run.add(rec);
  }
}

module.exports = { runL2, prepareWorkspace, convFor, roleOf, resolveTimeLimit, pickCacheDir, solveArmCost, SOLVE_ROLES };
