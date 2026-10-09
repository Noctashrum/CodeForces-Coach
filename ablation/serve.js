#!/usr/bin/env node
/**
 * 人工消融测试台（零依赖 Node HTTP，本机 127.0.0.1）。
 *
 * 它要回答的问题只有一个（用户口径）：
 *   **同一道题，cf-coach（L2）做的会不会"不如"裸模型（L0）？**
 *   只要不差于 L0（打平或更好），这个项目至少不帮倒忙。
 *
 * 所以这个台子做三件事：
 *   ① 攒题：粘贴题面（官方样例自动解析）+ 贴一份**外部 AC 题解当 oracle**（⛔ 不许用 L2 自己产的）
 *   ② 一键跑：同一题同一题面，跑 L0（一次调用）与 L2（cf-coach 无头跑，含验证链与图文文档）
 *   ③ 判分 + 人工判定：样例 / 与 oracle 差分（AC|WA）+ 链有没有"假自信"；人再并排读两份答案，
 *      记 coach 更好 / 打平 / L0 更好 / 两个都不行 —— 这才是"讲解质量"的轴
 *
 * 用法：
 *   node ablation/serve.js                                  # 用 data/config.json 里的服务商
 *   node ablation/serve.js --port 4311 --root ablation/out/ui --iterations 60
 *   node ablation/serve.js --base-url http://127.0.0.1:3996/v1 --api-key mock --model mock-gpt-4   # 假模型自测
 *
 * 安全：只监听 127.0.0.1；不做任何外网请求（除了你自己配置的模型服务商）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const env = require('./lib/env');
const record = require('./lib/record');
const levels = require('./lib/levels');
const l2 = require('./lib/l2');
const uistore = require('./lib/uistore');
const cffetch = require('./lib/cffetch');
const mkgen = require('./lib/mkgen');
const ladder = require('./lib/ladder');
const runlog = require('./lib/runlog');
const judgeLib = require('./judge');
const workspace = require('../lib/workspace');
const agentloop = require('../lib/agentloop');
const llm = require('../lib/llm');
const diagbundle = require('../lib/diagbundle');

// 项目根（注意与下面的 ROOT 区分：那个是跑分数据目录 store root）
const PROJECT_ROOT = path.join(__dirname, '..');
const APP_VERSION = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version; } catch { return null; }
})();

function usage() {
  console.log([
    '人工消融测试台：node ablation/serve.js [选项]',
    '',
    '  --port N             端口（默认 4311，只监听 127.0.0.1）',
    '  --root DIR           数据目录（默认 ablation/out/ui）',
    '  --model NAME         模型名（默认取 data/config.json 的默认服务商）',
    '  --provider-id ID     服务商 id',
    '  --base-url URL       直接指定服务商地址（测试用，如本地 mock）+ --api-key KEY',
    '  --max-tokens N       单次输出上限（0/缺省 = 不发这个字段）',
    '  --iterations N       默认对拍组数（默认 60）',
    '  --reps N             同一 (题×档) 跑几遍（默认 1；界面上的"重复次数"同义）',
    '  --conc N             并发跑几道题（默认 4；同一道题的多档/多遍永远串行）',
    '  --plan full|sweep|ladder|fill  重复方案：full=每格都跑 reps 遍（默认）/ sweep=先各跑 1 遍 / ladder=只补阶梯缝附近 / fill=补齐（已有足够记录就跳过，只跑缺的格）',
    '  --call-timeout-min N 单次模型调用超时分钟数（默认 12；难题建议 32 —— 实测 12 分钟会砍掉 r2300+）',
    '  --max-steps N        L1 工具循环上限（默认 20）',
    '  --lang python|cpp    L2 交题解的语言（默认 python）',
    '  --depth L1|L2|L3     L2 讲解深度（默认 L3）',
    '  --no-rich            不生成图文文档（默认生成，人工要读它）',
    '  --open               启动后打印地址（默认就打印）'
  ].join('\n'));
}

const args = env.parseArgs(process.argv.slice(2));
if (args.help || args.h) { usage(); process.exit(0); }

const PORT = env.num(args.port, 4311);
const ROOT = args.root ? path.resolve(String(args.root)) : path.join(__dirname, 'out', 'ui');
const store = uistore.init(ROOT);
const cfg = env.loadAppConfig();
const targets = env.resolveTargets(args);
const params = env.resolveParams(args);
// 模型配置与题面缓存必须来自同一个应用数据目录（用户跑的是打包版 exe，配置就在 dist/.../data/）
const APP_DATA = env.dataDir();
const DEFAULTS = {
  iterations: env.num(args.iterations, 60),
  maxSteps: env.num(args.maxSteps, 20),
  lang: args.lang === 'cpp' ? 'cpp' : 'python',
  depth: args.depth ? String(args.depth).toUpperCase() : 'L3',
  rich: args.rich === false || args.noRich ? false : env.bool(args.rich, true),
  maxStressMs: env.num(args.maxStressMs, 90000),
  // 同一 (题×档) 跑几遍：单次调用的方差很大（实测同一题同一档 1/3 概率交不出代码），
  // 只跑一遍的"通过/不通过"当不了证据。
  reps: env.num(args.reps, 1),
  // 并发跑几道题：单条 L2 记录中位 681s，串行跑 30 题 ≈ 35 小时（实测推演），三台机器也跑不完。
  // 只改调度、不改模型能看到的东西 —— 同题仍然串行（见 startRun 里的题级锁）。
  conc: env.num(args.conc, 4),
  // 单次模型调用超时（分钟）。默认 12 是 lib/llm.js 的历史默认值，但实测难题上
  // 单次思考 681–716s、余量只有 0.6%，所以要能在界面上直接调大。
  callTimeoutMin: env.num(args.callTimeoutMin, 12)
};

/**
 * 可跑的档位：
 *  L0  裸模型（一次调用，无工具）           —— "厂商宣称的 rating 上限"就是这一档
 *  L0C 裸模型 + 只输出一个代码块            —— 唯一差别是那段格式要求，用来分开"不懂"和"没交出来"
 *  L0+ 裸模型 + L2 题解 Agent 的完整提示词纪律与输入（契约 + 官方样例），仍是一次调用、无工具
 *                                          —— 判据 `L2 > L0+` 的对照组：L2 − L0+ 才是 harness 的净贡献
 *  L1  裸 agent（工具循环 + 通用工具面）
 *  L2  cf-coach 本体
 */
const LEVELS = ['L0', 'L0C', 'L0+', 'L1', 'L2'];
const LEVEL_HINT = { L0: '裸模型', L0C: '裸模型·只给代码块', 'L0+': '裸模型·L2 提示词与输入', L1: '裸 agent', L2: 'cf-coach' };

/* ---------------- 运行日志落盘 ----------------
 * 测试是在**别人的机器**上跑的：屏幕上滚过去的东西必须留一份在数据目录里，
 * 否则"我这边跑出来不对"这句话连个现场都没有（诊断包也带不走已经滚掉的屏幕）。
 * 日志文件跟着跑分数据目录走 —— 那个目录本来就是"这次测试的全部证据"。
 */
const RUNLOG = runlog.start(path.join(store.dir, 'server.log'), {
  banner: '工作台启动 v' + (APP_VERSION || '?') + ' 端口 ' + PORT + ' 数据目录 ' + store.dir
});

/** 诊断包文件名带上机器名：一台机器一个包，收回来不用猜是谁的。 */
function diagFileName(now) {
  const host = String(os.hostname() || '').replace(/[^\w.-]+/g, '-').slice(0, 24);
  return diagbundle.defaultFileName(now).replace(/^cfcoach-diag-/, 'cfcoach-diag-' + (host ? host + '-' : ''));
}

/** 运行日志的尾部（诊断包用；文件本身可能已经几 MB，只带尾巴）。 */
function logTail(maxChars) {
  try {
    const text = fs.readFileSync(RUNLOG.file, 'utf8');
    if (text.length <= maxChars) return text;
    return '…（只保留最后 ' + Math.round(maxChars / 1000) + 'k 字符；完整文件在数据目录的 server.log）\n'
      + text.slice(-maxChars);
  } catch (e) {
    return '（读不到运行日志：' + ((e && e.message) || e) + '）';
  }
}

/** 跑分明细（逐条，含 rep/撞顶/中止 —— 这些字段决定"失败"可不可信）。 */
function runDetailLines() {
  return store.records().map((r, i) => {
    const u = r.usage || {};
    const out = u.completionTokens != null ? u.completionTokens : u.completion_tokens;
    return (i + 1) + '. ' + (r.startedAt || '') + ' ' + r.level + '/' + r.problem
      + (r.rep ? ' #' + r.rep : '')
      + ' ok=' + (r.ok !== false)
      + ' code=' + (r.code ? (r.codeLang || '?') : '无')
      + (r.codeSource ? '(' + r.codeSource + ')' : '')
      + (r.codeOnly ? ' codeOnly=1' : '')
      + ' ms=' + (r.ms || 0)
      + ' out=' + (typeof out === 'number' ? out : '?')
      + ' cost=' + (r.cost && typeof r.cost.amount === 'number' ? r.cost.amount : '未计费')
      + (r.finishReason ? ' finish=' + r.finishReason : '')
      + (r.truncated ? ' 撞长度上限' : '')
      + (r.verificationStatus ? ' verify=' + r.verificationStatus : '')
      + (r.error ? ' error=' + String(r.error).replace(/\n/g, ' ') : '');
  }).join('\n');
}

/** 阶梯（服务端算好；界面与诊断包都用这一份，规则不会走样）。 */
function ladderOf() {
  return ladder.compute({
    problems: store.list(), runs: store.records(), verdicts: store.verdicts(),
    levels: LEVELS, levelHint: LEVEL_HINT
  });
}

/** 阶梯式重复：只有"已知最高 AC"与"首次可信失败"之间那道缝附近的题值得多跑几遍。 */
function ladderBoundary(problems, wanted) {
  const out = new Set();
  const ratings = [...new Set(problems.map((p) => Number(p.rating)).filter((r) => Number.isFinite(r)))].sort((a, b) => a - b);
  const neighbour = (r) => {
    const below = ratings.filter((x) => x < r).pop();
    const above = ratings.filter((x) => x > r)[0];
    return [below, above].filter((x) => x != null);
  };
  for (const lv of ladderOf().levels) {
    if (wanted.indexOf(lv.level) < 0) continue;
    const lo = lv.acMax ? Number(lv.acMax.rating) : NaN;
    const hi = lv.failMin ? Number(lv.failMin.rating) : NaN;
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) continue;
    const L = Number.isFinite(lo) ? lo : -Infinity;
    const H = Number.isFinite(hi) ? hi : Infinity;
    const want = new Set();
    ratings.forEach((r) => { if (r >= L && r <= H) want.add(r); });
    // 缝外紧邻的那一档也算：跨档结论常常只差一个样本
    if (Number.isFinite(lo)) neighbour(lo).forEach((r) => want.add(r));
    if (Number.isFinite(hi)) neighbour(hi).forEach((r) => want.add(r));
    problems.forEach((p) => { if (want.has(Number(p.rating))) out.add(p.id); });
  }
  return out;
}

/* ---------------- 事件流（SSE）：跑分与判分的实时进度 ---------------- */
const clients = new Set();
const ring = [];
function emit(ev) {
  const e = Object.assign({ at: Date.now() }, ev);
  ring.push(e);
  if (ring.length > 600) ring.shift();
  const line = 'data: ' + JSON.stringify(e) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch { /* 断了就算了 */ } }
}
// 事件面板与终端日志是同一份叙事：屏幕上滚掉的"跳过了哪几道 / 并发几个 / 为什么这么调度"，
// 事后只能从 server.log（界面上的诊断包）里找回来 —— 所以顺手也写一份到终端，runlog 会带时间戳落盘。
function logEvent(text) { emit({ type: 'log', text: String(text) }); console.log(text); }

/* ---------------- 跑分 ---------------- */
let job = null;

function fitRec(rec, target, problem, t0) {
  rec.cost = record.costOf(cfg, target.providerId, target.model, rec.usage);
  rec.statementSha = problem.statementSha;
  rec.statementFile = problem.statementFile;
  if (agentloop.hasLeakMarkup(rec.code || '')) rec.codeLeakMarkup = true;
  rec.requestFingerprint = {
    model: target.model, providerId: target.providerId, baseUrl: target.provider.baseUrl,
    stream: true, maxTokens: params.maxTokens || null,
    toolNames: rec.tools && rec.tools.length ? rec.tools : [],
    leakMarkupInAnswer: !!rec.leakMarkup
  };
  if (!rec.ms) rec.ms = Date.now() - t0;
  return rec;
}

function rewriteRecords(run) {
  // 工作台的 run.records 里已经装了 store 的全部历史（下面 `store.records().forEach(...)` 那段），
  // 所以只能整体重写；用 finalize() 会把历史写两遍（见 lib/record.js 的 rewriteAll 注释）
  run.rewriteAll();
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

async function startRun(o) {
  if (job && job.running) throw new Error('已经有一个跑分任务在跑（先等它结束或点取消）');
  const ids = Array.isArray(o.ids) && o.ids.length ? o.ids : store.problems.map((p) => p.id);
  const wanted = (Array.isArray(o.levels) && o.levels.length ? o.levels : ['L0', 'L2']).map((s) => String(s).toUpperCase());
  for (const l of wanted) if (LEVELS.indexOf(l) < 0) throw new Error('未知档位：' + l + '（可跑：' + LEVELS.join('/') + '）');
  const opts = Object.assign({}, DEFAULTS, {
    iterations: o.iterations != null && o.iterations !== '' ? Number(o.iterations) : DEFAULTS.iterations,
    lang: o.lang ? (String(o.lang) === 'cpp' ? 'cpp' : 'python') : DEFAULTS.lang,
    depth: o.depth ? String(o.depth).toUpperCase() : DEFAULTS.depth,
    rich: o.rich != null ? !!o.rich : DEFAULTS.rich,
    reps: clampInt(o.reps != null && o.reps !== '' ? o.reps : DEFAULTS.reps, 1, 20, 1),
    conc: clampInt(o.conc != null && o.conc !== '' ? o.conc : DEFAULTS.conc, 1, 8, DEFAULTS.conc),
    callTimeoutMin: clampInt(o.callTimeoutMin != null && o.callTimeoutMin !== '' ? o.callTimeoutMin : DEFAULTS.callTimeoutMin, 1, 180, 12)
  });
  // 单次调用超时是 lib/llm.js 的进程级默认值：L0/L1/L2 三条路都从这里生效
  llm.setDefaultCallTimeoutMs(opts.callTimeoutMin * 60 * 1000);
  const all = store.runtimeAll(ids).filter((p) => p.statement && p.statement.trim());
  if (!all.length) throw new Error('没有可跑的题：先在界面上加题（题面必须有）');
  // 判不了的题（多解没 checker / 尺子贴错题）：默认跳过。实测 2267B + 2268F 两道就烧掉 91 分钟 / ¥10.6，
  // 而且永远给不出可用结论 —— 那不是"数据点少一个"，是纯损失。
  const skipped = all.filter((p) => p.skip === true);
  const problems = o.includeSkipped === true ? all : all.filter((p) => p.skip !== true);
  if (skipped.length && o.includeSkipped !== true) {
    logEvent('跳过 ' + skipped.length + ' 道标记为"判不了"的题（连它们一起跑就勾上选项）：' + skipped.map((p) => p.id).join(', '));
  }
  if (!problems.length) throw new Error('选中的题都被标成"判不了"了（题表里取消勾选，或勾上"连判不了的题一起跑"）');

  // 重复方案：full = 每格都跑 N 遍（原行为）；sweep = 全池先各跑 1 遍；ladder = 只有阶梯缝附近的题跑 N 遍；
  // fill = **补齐**：同一 (题×档) 已有足够多"同模型同参数"的记录就跳过，只补差额。
  // 为什么要有 fill：跑过几轮之后，无脑重跑等于把钱花在已经结算的格子上 —— 那台机器实测有一个整轮
  // （R2，两格）就是在重跑上一轮已经跑过的格子。判分是零成本的单独一步，和"要不要重跑"无关。
  const plan = o.plan === 'sweep' ? 'sweep' : (o.plan === 'ladder' ? 'ladder' : (o.plan === 'fill' ? 'fill' : 'full'));
  const boundary = plan === 'ladder' ? ladderBoundary(problems, wanted) : null;
  const target = targets[0];
  const repsOf = (p) => {
    if (plan === 'sweep') return 1;
    if (plan === 'ladder') return boundary.has(p.id) ? opts.reps : 1;
    return opts.reps;                    // full 与 fill 都是"每格目标 reps 条"
  };
  if (plan === 'ladder') logEvent('阶梯式重复：缝附近的 ' + boundary.size + ' 道跑 ' + opts.reps + ' 遍，其余各 1 遍');

  // 已有记录计数（补齐模式用）。只认"同模型、同服务商、同 maxTokens"的记录。
  // 注意指纹里**没有提示词版本** —— 改过提示词或改过判据口径，请选 full（全部重跑）或换一个跑分目录，
  // 否则新旧口径会混进同一张表（既有的教训：换问法前后的数据不能混表）。
  const fpOf = (r) => [r && r.model, r && r.providerId, (r && r.requestFingerprint && r.requestFingerprint.maxTokens) || null].join('|');
  const wantFp = fpOf({ model: target.model, providerId: target.providerId, requestFingerprint: { maxTokens: params.maxTokens || null } });
  const haveOf = new Map();
  if (plan === 'fill') {
    for (const r of store.records()) {
      if (fpOf(r) !== wantFp) continue;
      const k = String(r.level || '').toUpperCase() + '|' + String(r.problem);
      haveOf.set(k, (haveOf.get(k) || 0) + 1);
    }
  }

  const jobs = [];
  let skippedCells = 0;
  for (const p of problems) for (const lv of wanted) {
    const n = repsOf(p);
    const have = haveOf.get(lv + '|' + p.id) || 0;
    const need = plan === 'fill' ? Math.max(0, n - have) : n;
    if (plan === 'fill' && need === 0) { skippedCells++; continue; }
    for (let rep = 1; rep <= need; rep++) {
      const label = n > 1 ? have + rep : null;      // 补齐时编号接着已有的往下排（#2、#3…）
      jobs.push({ problem: p, level: lv, rep: label, name: lv + '-' + p.id + (label ? '#' + label : '') });
    }
  }
  if (plan === 'fill') {
    logEvent('补齐模式：' + skippedCells + ' 个 (题×档) 已经够了（同模型同参数已有 ' + opts.reps + ' 条）→ 跳过；本次补 ' + jobs.length + ' 条'
      + (jobs.length ? '' : '。没有要补的格子，这次不起跑 —— 判分是单独一步，零成本。'));
    if (!jobs.length) return { skipped: true, reason: 'fill', skippedCells, total: 0 };
  }
  const run = record.openRun(store.dir);
  store.records().forEach((r) => run.records.push(r));   // 保住历史（最后整体重写 records.jsonl）
  job = { running: true, cancelled: false, startedAt: Date.now(), done: 0, total: jobs.length, current: null, active: [], opts };
  emit({ type: 'runStart', total: jobs.length, levels: wanted, problems: problems.map((p) => p.id), model: target.providerId + '::' + target.model, opts });
  logEvent('用 ' + target.providerId + '::' + target.model + ' 跑 ' + jobs.length + ' 个 (题×档'
    + (opts.reps > 1 ? '×' + opts.reps + ' 遍' : '') + ')，并发 ' + Math.max(1, Math.min(opts.conc, jobs.length))
    + '（**同一道题永远串行**：同题的工作区是共享的，并行会互相清目录）；单次调用超时 ' + opts.callTimeoutMin + ' 分钟');

  /** 跑一条 (题×档×遍)：不含锁，锁在外面。 */
  async function runJobOnce(j) {
    const ctx = { problem: j.problem, statement: j.problem.statement, target, params, run, name: j.name, maxSteps: opts.maxSteps, iterations: opts.iterations };
    if (j.level === 'L0' || j.level === 'L0C') return levels.runL0(Object.assign({}, ctx, { codeOnly: j.level === 'L0C' }));
    // L0+ 与 L2 用**同一种语言**，否则"提示词纪律"这个变量里会混进"语言不同"
    if (j.level === 'L0+') return levels.runL0Plus(Object.assign({}, ctx, { lang: opts.lang }));
    if (j.level === 'L1') return levels.runL1(ctx);
    // 每次都要干净的工作区：否则链会走"上次已对拍通过"的快通道 —— 测出来的就不是模型，而是缓存
    try { workspace.removeWorkspace(workspace.keyFor(l2.convFor(j.problem))); } catch { /* 没有就算了 */ }
    return l2.runL2(Object.assign({}, ctx, { lang: opts.lang, rich: !!opts.rich, depth: opts.depth, maxStressMs: opts.maxStressMs }));
  }

  async function runJob(j) {
    if (job.cancelled) return;
    const t0 = Date.now();
    let rec;
    try {
      // 题级锁：同题排队、异题并行。键加了前缀 —— 锁键与 L2 内部自己用的工作区锁同名会互相等待（死锁）。
      // jobStart 在**拿到锁之后**才发：同题的两个 job 被两个 worker 同时拿走时，后一个是在排队、
      // 还没开始跑，界面不该把它显示成"正在跑"，job.active 也不该把它算进并发。
      rec = await workspace.withKeyLock('abq:' + String(j.problem.id), async () => {
        job.active.push(j.name);
        job.current = j.name;
        emit({ type: 'jobStart', name: j.name, level: j.level, problem: j.problem.id, done: job.done, total: job.total });
        try {
          return await runJobOnce(j);
        } finally {
          job.active = job.active.filter((n) => n !== j.name);
          if (job.current === j.name) job.current = job.active.length ? job.active[0] : null;
        }
      });
    } catch (e) {
      rec = { level: j.level, problem: j.problem.id, model: target.model, ok: false, error: String((e && e.message) || e), usage: null, ms: Date.now() - t0 };
      run.add(rec);
    }
    if (j.rep) rec.rep = j.rep;
    fitRec(rec, target, j.problem, t0);
    job.done++;
    emit({
      type: 'jobDone', name: j.name, level: j.level, problem: j.problem.id, rep: j.rep || null,
      ok: rec.ok !== false, ms: Date.now() - t0, usage: rec.usage || null, cost: rec.cost || null,
      codeSource: rec.codeSource || null, error: rec.error || null,
      truncated: rec.truncated === true, finishReason: rec.finishReason || null,
      verification: rec.level === 'L2' ? {
        status: rec.verificationStatus || null, assertedVerified: rec.assertedVerified === true,
        scopeComplete: rec.scopeComplete === true, delivered: rec.delivered || null, scopeNote: rec.scopeNote || null,
        docFile: rec.docFile ? path.basename(rec.docFile) : null
      } : null
    });
    rewriteRecords(run);   // 每题都落盘：中途崩了也不丢
  }

  // 并发池：N 个 worker 抢同一个队列（不是 Promise.all(jobs.map(...)) —— 那会把几百个任务一次性全发出去）
  let cursor = 0;
  const width = Math.max(1, Math.min(opts.conc, jobs.length));
  const workers = [];
  for (let w = 0; w < width; w++) {
    workers.push((async () => {
      for (;;) {
        if (job.cancelled) return;
        const j = jobs[cursor++];
        if (!j) return;
        await runJob(j);
      }
    })());
  }
  await Promise.all(workers);
  rewriteRecords(run);
  const cancelled = job.cancelled;
  const done = job.done;
  job.running = false;
  const summary = run.writeSummary({ source: 'serve', problems: problems.map((p) => p.id), levels: wanted });
  emit({ type: 'runEnd', cancelled, done, total: jobs.length, summary });
  return summary;
}

/* ---------------- 判分 ---------------- */
async function runJudge(o) {
  if (job && job.running) throw new Error('跑分任务还在跑，等它结束再判分');
  const iterations = o && o.iterations != null && o.iterations !== '' ? Number(o.iterations) : DEFAULTS.iterations;
  const problems = store.runtimeAll();
  if (!problems.length) throw new Error('题库是空的');
  const noOracle = problems.filter((p) => !p.oracle);
  const noGen = problems.filter((p) => p.oracle && !p.gen);
  if (noOracle.length) logEvent('⚠️ 这些题缺 oracle（差分对拍跑不了，只能判样例，记 no-oracle）：' + noOracle.map((p) => p.id).join(', '));
  if (noGen.length) logEvent('⚠️ 这些题有 oracle 但缺数据生成器（差分对拍跑不了，记 no-gen）：点「补生成器」可以自动写：' + noGen.map((p) => p.id).join(', '));
  emit({ type: 'judgeStart', iterations, problems: problems.length });
  const r = await judgeLib.judgeAll(
    { outDir: store.dir, problems, records: store.latestRecords(), iterations, human: store.human() },
    {
      log: logEvent,
      onVerdict: (v, i, total) => emit({ type: 'verdict', verdict: v, done: i + 1, total })
    }
  );
  emit({ type: 'judgeEnd', compare: r.cmp, byLevel: r.byLevel, verdicts: r.verdicts.length });
  return r;
}

/* ---------------- 攒题：从 CF 取题 + 自动写生成器 ---------------- */

/** 写生成器是"一次模型调用"，不许两件同时跑（也不许和跑分抢模型） */
let genBusy = false;

/**
 * 把一份 CF 结构（现场抓的和应用缓存里的形状完全一样）入库。
 *
 * 已有的 oracle / 生成器**原样保留**：save() 在没给 oracleCode/genCode 时会沿用旧文件，
 * 所以"先贴 oracle，再重新取一次题面"不会把用户贴的代码弄丢。
 */
function saveProblemInto(cfProblem, sourceLabel) {
  const incoming = cffetch.toStoreProblem(cfProblem);
  const prev = store.get(incoming.id) || {};
  const saved = store.save({
    id: incoming.id, title: incoming.title, rating: incoming.rating, url: incoming.url,
    source: 'cf',
    note: prev.note || incoming.note,     // 用户自己写的备注别被 CF 的 tags 顶掉
    statement: incoming.statement,
    samples: incoming.samples
  });
  (cfProblem.warnings || []).forEach((w) => logEvent('⚠️ 取题告警：' + w));
  logEvent('已入库（' + sourceLabel + '）：' + saved.id + ' ' + saved.title + '（题面 ' + String(saved.statement || '').length
    + ' 字，样例 ' + (saved.samples || []).length + ' 组'
    + (saved.oracle ? '，oracle 已有' : '，还缺 oracle（贴你自己的 AC 题解）') + '）');
  return saved;
}

function savedSummary(saved, ms) {
  return {
    ok: true, id: saved.id, title: saved.title, rating: saved.rating,
    samples: (saved.samples || []).length, statementLen: String(saved.statement || '').length,
    hasOracle: !!saved.oracle, hasGen: !!saved.gen, ms: ms || 0
  };
}

/**
 * 复用应用自己的取题通道（electron/main.js 的 CHATBOX_CF_API_TEST + CHATBOX_CF_JSON）把题扒进题库。
 */
async function cfFetchInto(ref) {
  if (job && job.running) return { ok: false, error: '跑分任务在跑，等它结束再取题' };
  logEvent('取题：' + String(ref || '') + '（借应用内嵌浏览器过 CF 反爬，实测 20–60 秒）');
  const r = await cffetch.fetchProblem(String(ref || ''), { log: logEvent });
  if (!r.ok) {
    logEvent('取题失败：' + r.error);
    const ids = cffetch.listAppCache();
    if (ids.length) logEvent('（应用自己抓过的题可以直接导入，不用再交一次挑战：' + ids.join(', ') + '）');
    return { ok: false, error: r.error, logTail: r.logTail || '', appCacheIds: ids };
  }
  return savedSummary(saveProblemInto(r.problem, '现场取题'), r.ms);
}

/**
 * 从应用自己的**题面缓存**导入（<DATA_DIR>/cf-problems/<题号>.json）。
 *
 * 为什么值得单独一条路：CF 的反爬是概率性的，现场抓题经常整轮被抓；而用户在应用里
 * 点开过某道题，题面就已经落盘了。导入走的是**纯本地文件读**，没有网络、没有挑战。
 */
function importFromCache(ref) {
  const ids = cffetch.listAppCache();
  const cached = cffetch.readAppCache(String(ref == null ? '' : ref));
  if (!cached) {
    return {
      ok: false, ids,
      error: '应用缓存里没有「' + String(ref == null ? '' : ref).trim() + '」（目录 ' + cffetch.appCacheDir() + '）'
        + (ids.length
          ? '；现有：' + ids.join(', ')
          : '；缓存还是空的 —— 先在应用里正常打开一次这道题（题面抓成功后会自动落盘），或改用「从 CF 取题」')
    };
  }
  logEvent('从应用缓存导入：' + String(ref || ''));
  return savedSummary(saveProblemInto(cached, '应用缓存'), 0);
}

/** 给一道题写生成器：一次模型调用 + 机械体检（见 ablation/lib/mkgen.js） */
async function makeGenFor(id) {
  const p = store.get(String(id || '').trim());
  if (!p) return { ok: false, error: '没有这道题：' + id };
  const oracleCode = readCode(p.oracle);
  if (!oracleCode.trim()) return { ok: false, error: '这题还没有 oracle：先贴一份你自己的 AC 题解（生成器要照它的输入格式写）' };
  const target = targets[0];
  if (!target) return { ok: false, error: '没有可用模型（用 --base-url/--model 或配 data/config.json）' };
  logEvent('写生成器：' + p.id + '（一次模型调用 + 跑代码体检）');
  const r = await mkgen.makeGen({
    problem: p, statement: p.statement,
    oracle: { lang: p.oracleLang, code: oracleCode },
    samples: p.samples || [],
    target, params
  });
  if (!r.ok) {
    const broken = !!(r.gate && r.gate.status === 'oracle-broken');
    logEvent((broken ? 'oracle 有问题（不是生成器的锅）：' : '生成器体检没过：') + p.id + '：' + r.error);
    return { ok: false, error: r.error, oracleBroken: broken, usage: r.usage || null, calls: r.calls || 1, ms: r.ms || 0 };
  }
  const savedGen = store.save({ id: p.id, genLang: r.lang, genCode: r.code });
  ((savedGen && savedGen.langFix) || []).forEach((f) => logEvent('（' + p.id + ' 的生成器语言按代码内容从 ' + f.from + ' 改成 ' + f.to + '）'));
  ((r.gate && r.gate.warnings) || []).forEach((w) => logEvent('⚠️ ' + p.id + '：' + w));
  logEvent('生成器已写入：' + p.id + '（' + (r.lang === 'cpp' ? 'C++' : 'Python') + '，体检通过'
    + (((r.gate && r.gate.warnings) || []).length ? '，有 ' + r.gate.warnings.length + ' 条提醒' : '') + '）');
  return { ok: true, id: p.id, lang: r.lang, code: r.code, gate: r.gate, usage: r.usage || null, calls: r.calls || 1, ms: r.ms || 0 };
}

/** 批量补生成器：默认只补"有 oracle 但没生成器"的题 */
async function makeGensFor(ids, onlyMissing) {
  const all = (Array.isArray(ids) && ids.length) ? ids.map(String) : store.problems.map((p) => p.id);
  const todo = onlyMissing === false ? all : all.filter((id) => {
    const p = store.get(id);
    return p && !(p.gen && p.gen.file);
  });
  if (!todo.length) {
    logEvent('没有需要补生成器的题（要么都有生成器了，要么题库是空的）');
    return { ok: true, results: [] };
  }
  logEvent('补生成器：' + todo.length + ' 题（' + todo.join(', ') + '），一题一次模型调用');
  const results = [];
  for (const id of todo) {
    const r = await makeGenFor(id);
    results.push({ id, ok: !!r.ok, error: r.error || null, warnings: (r.gate && r.gate.warnings) || [] });
    emit({ type: 'genDone', id, ok: !!r.ok, done: results.length, total: todo.length });
  }
  logEvent('补生成器完成：' + results.filter((x) => x.ok).length + '/' + results.length + ' 成功');
  return { ok: true, results };
}

/* ---------------- HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj == null ? null : obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'content-type': (type || 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) { reject(new Error('请求体太大')); req.destroy(); } });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 读 oracle/gen 的代码。顺手剥掉历史上可能带进来的 ``` 围栏（存盘时也会剥，这里兜住老文件）。 */
function readCode(f) {
  try { return uistore.stripFence(f && f.file && fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : ''); } catch { return ''; }
}

function stateOf() {
  return {
    root: store.dir,
    defaults: DEFAULTS,
    targets: targets.map((t) => ({ providerId: t.providerId, model: t.model })),
    running: !!(job && job.running),
    genBusy,
    // 应用自己抓过的题面缓存（纯本地文件，导入不必再过 CF 反爬）—— 界面上列出来一键导入
    appCache: { dir: cffetch.appCacheDir(), ids: cffetch.listAppCache() },
    // 模型配置与题面缓存来自哪个应用数据目录（界面上要能一眼看到，省得"配置在哪"变成猜谜）
    appDataDir: APP_DATA,
    job: job ? { running: job.running, cancelled: job.cancelled, startedAt: job.startedAt, done: job.done, total: job.total, current: job.current, conc: (job.opts && job.opts.conc) || 1, active: job.active || [], opts: job.opts } : null,
    problems: store.list().map((p) => ({
      id: p.id, title: p.title, rating: p.rating, url: p.url, note: p.note, source: p.source,
      skip: p.skip === true,
      statement: p.statement, samples: p.samples || [], statementSha: p.statementSha,
      oracleLang: p.oracleLang, genLang: p.genLang,
      oracleCode: readCode(p.oracle), genCode: readCode(p.gen),
      hasOracle: !!(p.oracle && p.oracle.file), hasGen: !!(p.gen && p.gen.file)
    })),
    records: store.latestRecords().map((r) => ({
      level: r.level, problem: r.problem, model: r.model, ok: r.ok !== false, error: r.error || null,
      ms: r.ms || 0, usage: r.usage || null, cost: r.cost || null, code: r.code || null, codeLang: r.codeLang || null,
      codeSource: r.codeSource || null, answerFile: r.answerFile || null, answerName: r.answerFile ? path.basename(r.answerFile) : null, docFile: r.docFile ? path.basename(r.docFile) : null,
      verificationStatus: r.verificationStatus || null, assertedVerified: r.assertedVerified === true,
      scopeComplete: r.scopeComplete === true, delivered: r.delivered || null, scopeNote: r.scopeNote || null,
      trajectory: (r.trajectory || []).slice(-12), notes: r.notes || [], startedAt: r.startedAt || null
    })),
    levels: LEVELS,
    levelHint: LEVEL_HINT,
    // 这台机器是谁：测试会在不同机器上跑，收包的人第一眼要知道是哪台
    host: os.hostname(),
    logFile: RUNLOG.file,
    diagName: diagFileName(),
    // rating 阶梯：规则在 ablation/lib/ladder.js，只有那一份实现（界面只渲染）
    ladder: ladderOf(),
    // 全部跑分记录（不是一个 (题×档) 只留最新那条）："rating 上限"和"跑 N 遍成功几次"都必须看全部，
    // 否则 latest 口径会把"3 遍里只有 1 遍交得出代码"抹成"交出来了"。只给统计需要的字段，不带代码正文。
    runs: store.records().map((r) => ({
      level: r.level, problem: r.problem, rep: r.rep || null, ok: r.ok !== false,
      hasCode: !!(r.code && String(r.code).trim()), codeLang: r.codeLang || null,
      codeSource: r.codeSource || null, error: r.error || null,
      finishReason: r.finishReason || null, truncated: r.truncated === true,
      usage: r.usage || null, cost: r.cost || null, ms: r.ms || 0,
      verificationStatus: r.verificationStatus || null, startedAt: r.startedAt || null
    })),
    verdicts: store.verdicts(),
    compare: store.compare(),
    human: store.human(),
    events: ring.slice(-120)
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
      return sendText(res, 200, html, 'text/html');
    }
    if (req.method === 'GET' && p.startsWith('/ui/')) {
      const rel = p.slice(4).replace(/\.\./g, '');
      const file = path.join(__dirname, 'ui', rel);
      if (!file.startsWith(path.join(__dirname, 'ui'))) return sendText(res, 403, 'no');
      if (!fs.existsSync(file)) return sendText(res, 404, 'not found');
      const type = /\.css$/.test(file) ? 'text/css' : (/\.js$/.test(file) ? 'text/javascript' : 'text/plain');
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), type);
    }
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, stateOf());
    if (req.method === 'GET' && p.startsWith('/api/doc/')) {
      const name = path.basename(decodeURIComponent(p.slice('/api/doc/'.length)));
      const file = path.join(store.dirs.docs, name);
      if (!fs.existsSync(file)) return sendText(res, 404, '这套记录没有图文文档（跑的时候勾了"生成图文文档"吗？）', 'text/plain');
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), 'text/html');
    }
    if (req.method === 'GET' && p.startsWith('/api/answer/')) {
      const name = path.basename(decodeURIComponent(p.slice('/api/answer/'.length)));
      const file = path.join(store.dirs.answers, name);
      if (!fs.existsSync(file)) return sendText(res, 404, '没有这份回答', 'text/plain');
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), 'text/plain');
    }
    if (req.method === 'GET' && p === '/api/diag/export') {
      // 跑分这台机器上"到底发生了什么"的证据包：和应用的诊断包共用 lib/diagbundle.js，
      // 额外把 ablation/out/ui 的跑分记录（summary/records/verdicts/transcript/sandbox）带上。
      const b = diagbundle.collect({
        dataDir: env.dataDir(),
        rootDir: PROJECT_ROOT,
        ablationOut: store.dir,
        appVersion: APP_VERSION,
        electronVersion: process.versions.electron || null,
        chromeVersion: process.versions.chrome || null,
        packed: /app\.asar/.test(String(process.resourcesPath || '')),
        extra: [{
          name: '测试台状态（题库 / 判分台账 / 内存里的运行状态）',
          text: JSON.stringify({
            dir: store.dir, host: os.hostname(), defaults: DEFAULTS, targets: (stateOf().targets || []),
            problems: store.list().map((x) => ({ id: x.id, title: x.title, rating: x.rating || null, hasOracle: !!x.oracle, hasGen: !!x.gen, samples: (x.samples || []).length })),
            records: store.latestRecords().length, runs: store.records().length, verdicts: store.verdicts().length,
            running: !!(stateOf().job && stateOf().job.running), genBusy: !!stateOf().genBusy,
            runningOpts: (stateOf().job && stateOf().job.opts) || null
          }, null, 2)
        }, {
          name: 'rating 阶梯（这一档的 rating 上限在哪）',
          text: (function () {
            const L = ladderOf();
            const lines = [L.note, '', L.evidence, '', '机器：' + os.hostname() + '，数据目录：' + store.dir, ''];
            for (const lv of L.levels) {
              lines.push('【' + lv.level + '】' + (lv.hint ? lv.hint + ' — ' : '') + lv.verdict);
              lines.push('  跑 ' + lv.stats.n + ' 次（有代码 ' + lv.stats.withCode + '）'
                + '，AC ' + lv.counts.ac + '，可信失败 ' + lv.counts.fail
                + '，中止/撞顶 ' + lv.counts.unfinished + '，不可判 ' + lv.counts.undecidable
                + '，没交出来 ' + lv.counts.nocode + '，未跑 ' + lv.counts.none
                + '；输出 ' + lv.stats.out + ' tok，花费 ' + (lv.stats.priced ? lv.stats.cost.toFixed(4) : '未计费'));
              lines.push('  按 rating：' + lv.cells.filter((c) => c.kind !== 'none')
                .map((c) => 'r' + (c.rating || '?') + ' ' + c.id + '=' + c.kind).join('  '));
              lines.push('');
            }
            lines.push('（同 rating 明细）');
            for (const r of L.rows) {
              lines.push('  r' + (r.rating || '?') + ' ' + r.id + '  ' + Object.keys(r.cells).map((k) => k + '=' + r.cells[k].kind).join('  '));
            }
            lines.push('', '原始 JSON（界面按它渲染）：', JSON.stringify(L, null, 2));
            return lines.join('\n');
          })()
        }, {
          name: '跑分明细（逐条：重复次数 / 撞长度上限 / 中止 / 超时文案）',
          text: '全部 ' + store.records().length + ' 条记录（不含代码正文）。\n'
            + '读法：error 里出现"超时"的那条是**没跑完**，不是答错；撞长度上限同理。\n\n'
            + runDetailLines()
        }, {
          name: '工作台运行日志（server.log，本次终端输出）',
          text: '文件：' + RUNLOG.file + '\n' + RUNLOG.note() + '\n\n' + logTail(180000)
        }]
      });
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="' + diagFileName() + '"'
      });
      return res.end(b.text);
    }
    if (req.method === 'GET' && p === '/api/export') {
      return sendJson(res, 200, {
        exportedAt: new Date().toISOString(), root: store.dir, defaults: DEFAULTS,
        problems: store.list(), records: store.latestRecords(), verdicts: store.verdicts(),
        compare: store.compare(), human: store.human()
      });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      ring.slice(-60).forEach((e) => { try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch { /* ignore */ } });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && p === '/api/problems') {
      const body = await readBody(req);
      const saved = store.save(body.problem || body);
      (saved.langFix || []).forEach((f) => logEvent('（' + saved.id + ' 的 ' + f.which + ' 语言按代码内容从 ' + f.from + ' 改成 ' + f.to + '）'));
      return sendJson(res, 200, {
        ok: true,
        problem: {
          id: saved.id, title: saved.title, hasOracle: !!saved.oracle, hasGen: !!saved.gen,
          samples: (saved.samples || []).length,
          oracleLang: saved.oracleLang, genLang: saved.genLang, langFix: saved.langFix || []
        }
      });
    }
    if (req.method === 'POST' && p === '/api/problems/delete') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: store.remove(String(body.id || '')) });
    }
    if (req.method === 'POST' && p === '/api/run') {
      const body = await readBody(req);
      if (job && job.running) return sendJson(res, 409, { error: '已有跑分任务在跑' });
      // 不 await：立刻返回，进度走 SSE
      startRun(body).catch((e) => { if (job) job.running = false; emit({ type: 'error', error: String((e && e.message) || e) }); logEvent('跑分失败：' + ((e && e.message) || e)); });
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/cancel') {
      if (job && job.running) { job.cancelled = true; logEvent('收到取消：当前这道跑完就停'); return sendJson(res, 200, { ok: true, cancelling: true }); }
      return sendJson(res, 200, { ok: true, running: false });
    }
    if (req.method === 'POST' && p === '/api/judge') {
      const body = await readBody(req);
      if (job && job.running) return sendJson(res, 409, { error: '跑分任务还在跑' });
      runJudge(body).catch((e) => emit({ type: 'error', error: String((e && e.message) || e) }));
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/human') {
      const body = await readBody(req);
      const e = store.saveHuman({ problem: String(body.problem || ''), choice: String(body.choice || ''), note: String(body.note || ''), tags: body.tags || undefined, level: String(body.level || 'L2') });
      return sendJson(res, 200, { ok: true, entry: e });
    }
    if (req.method === 'POST' && p === '/api/cf-fetch') {
      const body = await readBody(req);
      // 取题本身要 20–60 秒：等它（前端有转圈 + SSE 日志），不要让它变成"后台静默任务"
      return sendJson(res, 200, await cfFetchInto(body.ref != null ? body.ref : body.id));
    }
    if (req.method === 'POST' && p === '/api/import-cache') {
      const body = await readBody(req);
      // 纯本地文件读，秒回：不用过 CF 反爬
      return sendJson(res, 200, importFromCache(body.ref != null ? body.ref : body.id));
    }
    if (req.method === 'POST' && p === '/api/make-gen') {
      const body = await readBody(req);
      if (genBusy) return sendJson(res, 409, { error: '正在写生成器，等它结束' });
      genBusy = true;
      try { return sendJson(res, 200, await makeGenFor(body.id)); }
      finally { genBusy = false; }
    }
    if (req.method === 'POST' && p === '/api/make-gens') {
      const body = await readBody(req);
      if (genBusy) return sendJson(res, 409, { error: '正在写生成器，等它结束' });
      genBusy = true;
      // 不 await：一题一次模型调用，10 题可能好几分钟 —— 进度走 SSE（与跑分同一个套路）
      makeGensFor(body.ids, body.onlyMissing !== false)
        .catch((e) => { const m = String((e && e.message) || e); logEvent('补生成器失败：' + m); emit({ type: 'error', error: m }); })
        .finally(() => { genBusy = false; emit({ type: 'gensEnd' }); });
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/clear') {
      const body = await readBody(req);
      if (body.records) store.clearHistory();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'no route ' + req.method + ' ' + p });
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('人工消融测试台：http://127.0.0.1:' + PORT + '/');
  console.log('数据目录：' + store.dir);
  console.log('运行日志：' + RUNLOG.note() + '（界面上的"诊断包"会把它一起打包）');
  console.log('模型：' + targets.map((t) => t.providerId + '::' + t.model).join('  ') + '（对拍组数默认 ' + DEFAULTS.iterations + '，L2 语言 ' + DEFAULTS.lang + '，图文文档 ' + (DEFAULTS.rich ? '开' : '关') + '）');
  const cacheIds = cffetch.listAppCache();
  console.log('应用数据目录：' + APP_DATA + '（这里出模型配置；题面缓存 ' + (cacheIds.length ? cacheIds.join(', ') : '空') + '）');
  console.log('题库：' + store.problems.length + ' 题' + (store.problems.length ? ('（' + store.problems.map((p) => p.id).join(', ') + '）') : '（先在界面上加题）'));
  if (store.repairs.length) {
    console.log('已自动修好 ' + store.repairs.length + ' 处 oracle/生成器：');
    store.repairs.forEach((r) => console.log('  ' + r.id + ' ' + r.which
      + (r.fence ? '：去掉了整块粘贴带进来的 Markdown 围栏' : '')
      + (r.from !== r.to ? (r.fence ? '；' : '') + '语言 ' + r.from + ' → ' + r.to + '（按代码内容判断）' : '')));
  }
});
