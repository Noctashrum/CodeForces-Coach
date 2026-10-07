'use strict';

/**
 * CF-AC 尺子（评测工具，只给 ablation 用，不进产品包）
 *
 * 为什么必须有它：旧的判分（ablation/judge.js）只做两件事 —— 官方样例，以及与外部 AC 提交
 * 在"生成器默认规模"上的随机对拍。两者都不足以判定"这题在 Codeforces 上能过"：
 *   ① store 里的 23 个生成器**一个都不读 argv**（judge 走 runner.stressTest，而 stressTest
 *      调用生成器时**不传参数**）→ 对拍几乎都在 n≤8 上发生；
 *   ② 时限一律用 runner.RUN_TIMEOUT_MS = 5000，与题目真实时限（CF 题面 1–4 秒）无关。
 * 后果：一个在 n≤8 上正确的暴力解会被判成 AC —— 尺子坏了，所有结论跟着坏。
 *
 * CF-AC 的定义（三条同时成立）：
 *   ① 官方样例全过；
 *   ② 与外部 AC 提交（oracle，纪律：绝不能是 cf-coach 自己产出的）在**多档规模**上随机对拍一致；
 *   ③ 在题面**最大规模**、按题目**真实时限**跑得动（超时/慢 → 不算 AC）。
 *
 * 尺子自己也要能被审：每个数字都带 source（override / cache / parsed / default），
 * 生成器的来历（harness 跑分时产出的 tier-aware 版本 / 本次新写 / store 里的老版本）
 * 与规模校验结果一并记进 verdict，任何人可以复核"这次判分到底是在什么规模、什么时限下做的"。
 */

const fs = require('fs');
const path = require('path');
const runner = require('../../lib/runner');
const statementLib = require('../../lib/statement');

const DEFAULT_TIME_LIMIT_MS = 2000;
const DEFAULT_MAX_SCALE = 200000;
const DEFAULT_MAX_VALUE = 1000000000;
/** 正确性对拍用的规模档：小 → 中 → 大（但都远小于题面上限，只用来抓逻辑错） */
const DIFF_TIERS = [30, 200, 2000];
/** 最大规模那一跑，若在真实时限内超时，再用这个宽松上限重跑一次，用来区分"刚超一点"与"差了数量级" */
const DEFAULT_GENEROUS_MS = 20000;
const DEFAULT_GEN_TIMEOUT_MS = 30000;
/**
 * 生成器要试几次才算"真的到了最大规模"。
 * 生成器是随机的：像 2241B 那样 `t = random.randint(1, 10^4)`，一次调用完全可能只吐出百来组
 * 玩具数据 —— 单次就断言"生成器太弱"会误杀；反过来，试出来的规模不够就是真的不够（如实记 gen-weak）。
 */
const MAX_SCALE_TRIES = 4;
/**
 * 最大规模那一关：oracle（外部 AC 提交）自己的预算，以及它跑不完时重画数据的次数。
 * 为什么要有这两个数：oracle 是人类/别的模型写的正解，而我们的生成器是**随机**的，可能撞出
 * "题面允许、但比 CF 真实数据更狠"的用例。此时 oracle 超时说明**这份输入不适合当尺子**，
 * 不是候选的错 —— 所以换一份随机输入重试；全部失败才如实记"这一格不可判"。
 * （只有 oracle 跑完拿到标准答案，才谈得上"候选在真实时限内跑不跑得动"。）
 */
const DEFAULT_ORACLE_MS = 60000;
const DEFAULT_ORACLE_TRIES = 3;

/* ------------------------------------------------------------------ 解析 */

/** "2 seconds" / "1 second" / "1500 ms" / "2 s" → 毫秒 */
function parseTimeLimitMs(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase();
  const ms = s.match(/(\d+(?:\.\d+)?)\s*(?:ms|毫秒|millisecond)/);
  if (ms) return Math.round(Number(ms[1]));
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|second|秒)/);
  if (sec) return Math.round(Number(sec[1]) * 1000);
  const bare = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (bare) return Math.round(Number(bare[1]) * 1000); // CF 的 JSON 里偶尔只给数字，单位是秒
  return null;
}

/** "256 megabytes" / "512 MB" → 兆字节 */
function parseMemoryMb(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase();
  const mb = s.match(/(\d+(?:\.\d+)?)\s*(?:mb|megabyte|兆)/);
  if (mb) return Math.round(Number(mb[1]));
  const gb = s.match(/(\d+(?:\.\d+)?)\s*(?:gb|gigabyte)/);
  if (gb) return Math.round(Number(gb[1]) * 1024);
  const bare = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (bare) return Math.round(Number(bare[1]));
  return null;
}

/**
 * 题面里的数字表达式 → 数值。
 * 覆盖 `2\cdot10^5`、`2·10^5`、`10^5`、`2^{18}`、`10^{9}`、普通整数。
 */
function parseNumExpr(expr) {
  if (expr == null) return null;
  let t = String(expr).trim();
  t = t.replace(/\\(?:cdot|times)/g, '*').replace(/[·×]/g, '*').replace(/\s+/g, '');
  if (!t) return null;
  let m = t.match(/^(\d+(?:\.\d+)?)\*10\^\{?(\d+)\}?$/);
  if (m) return Math.round(Number(m[1]) * Math.pow(10, Number(m[2])));
  m = t.match(/^10\^\{?(\d+)\}?$/);
  if (m) return Math.round(Math.pow(10, Number(m[1])));
  m = t.match(/^(\d+(?:\.\d+)?)\^\{?(\d+)\}?$/);
  if (m) return Math.round(Math.pow(Number(m[1]), Number(m[2])));
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Math.round(Number(m[1]));
  return null;
}

/** 把题面里的 LaTeX 记号压成好扫的纯文本（只用于正则扫描，不改原题面） */
function flattenStatement(statement) {
  return String(statement || '')
    .replace(/\\\(|\\\)|\\\[|\\\]/g, ' ')
    .replace(/\\(?:cdot|times)/g, '*')
    .replace(/\\le\b|\\leq\b|\\leqslant\b/g, '<=')
    .replace(/\\ge\b|\\geq\b|\\geqslant\b/g, '>=')
    .replace(/\\lt\b|\\leq\b|\\textless\b/g, '<')
    .replace(/\\gt\b|\\textgreater\b/g, '>')
    .replace(/[{}$]/g, '')
    .replace(/[·×]/g, '*')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

const NUM_TOKEN = '(\\d+(?:\\s*\\*\\s*10\\s*\\^\\s*\\{?\\d+\\}?)?(?:\\s*\\^\\s*\\{?\\d+\\}?)?|10\\s*\\^\\s*\\{?\\d+\\}?)';

/**
 * 从题面文本里尽力解析"最大规模"与"值域上限"。
 * 只做**保守**估计：解析不到就返回 null，交给覆盖表/默认值（宁可用少了，也别用多了判错）。
 */
function scanStatement(statement) {
  const text = flattenStatement(statement);
  const notes = [];
  let maxSum = null;
  let maxN = null;
  let maxV = null;

  // ① 总额保证： "It is guaranteed that the sum of n over all test cases does not exceed 2*10^5"
  const sumRe = new RegExp(
    'sum of (?:all )?(?:the )?(n|q|m|k|len|length|values)[^.]{0,120}?(?:does not exceed|not exceed|<=|at most|不超过)\\s*' + NUM_TOKEN,
    'i'
  );
  const sumM = text.match(sumRe);
  if (sumM) {
    maxSum = parseNumExpr(sumM[2]);
    if (maxSum) notes.push('总额保证：sum of ' + sumM[1] + ' ≤ ' + maxSum);
  }

  // ② 变量 n 的上界： "n (2 <= n <= 2*10^5)" / "n (1 <= n <= 1000)" / "n <= 10^5"
  const upperBounds = [];
  const parenRe = new RegExp('\\bn\\b\\s*\\(([^)]{0,80})\\)', 'gi');
  let pm;
  while ((pm = parenRe.exec(text)) !== null) {
    const inner = pm[1];
    const bounds = inner.match(new RegExp('(?:<=|<)\\s*' + NUM_TOKEN, 'gi')) || [];
    for (const b of bounds) {
      const mm = b.match(new RegExp('(?:<=|<)\\s*' + NUM_TOKEN, 'i'));
      const v = mm && parseNumExpr(mm[1]);
      if (v) upperBounds.push(v);
    }
  }
  const bareRe = new RegExp('\\bn\\b\\s*(?:<=|<)\\s*' + NUM_TOKEN, 'gi');
  let bm;
  while ((bm = bareRe.exec(text)) !== null) {
    const v = parseNumExpr(bm[1]);
    if (v) upperBounds.push(v);
  }
  if (upperBounds.length) {
    maxN = Math.max.apply(null, upperBounds);
    notes.push('n 上界候选 ' + upperBounds.join('/') + ' → 取 ' + maxN);
  }
  if (maxSum != null && (maxN == null || maxSum > maxN)) {
    // 总额上限才是"一次运行要处理的数据量"的真正上限
    maxN = maxSum;
    notes.push('最大规模按总额上限取 ' + maxSum);
  }

  // ②b 兜底：有些题根本没有 n —— 每个测试用例只有一个数（如 2241B：t 组、每组一个 x<10^8）。
  // 这时唯一的规模变量就是测试组数 t，用它的上界当"最大规模"；否则会落到默认值，
  // 而生成器（尊重题面真实上限 t ≤ 10^4）产出的数据永远够不到那个默认值 → 被误判成"生成器太弱"。
  if (maxN == null) {
    const tBounds = [];
    const tRe = new RegExp('\\bt\\b\\s*\\(([^)]{0,80})\\)', 'gi');
    let tm;
    while ((tm = tRe.exec(text)) !== null) {
      const bs = tm[1].match(new RegExp('(?:<=|<)\\s*' + NUM_TOKEN, 'gi')) || [];
      for (const b of bs) {
        const mm = b.match(new RegExp('(?:<=|<)\\s*' + NUM_TOKEN, 'i'));
        const v = mm && parseNumExpr(mm[1]);
        if (v) tBounds.push(v);
      }
    }
    if (tBounds.length) {
      maxN = Math.max.apply(null, tBounds);
      notes.push('题面里没有 n，只有测试组数 t 的上界 → 最大规模按 t 取 ' + maxN);
    }
  }

  // ③ 值域上限： "0 <= a_i < 2^18" / "1 <= a_i <= 10^9" / "a_i <= 10^6"
  const valBounds = [];
  const valRe = new RegExp('(?:<=|<)\\s*' + NUM_TOKEN, 'gi');
  let vm;
  const valWindow = text.match(/a_i[^.]{0,80}/gi) || [];
  for (const w of valWindow) {
    valRe.lastIndex = 0;
    while ((vm = valRe.exec(w)) !== null) {
      const v = parseNumExpr(vm[1]);
      if (v) valBounds.push({ v, strict: !vm[0].trim().startsWith('<=') });
    }
  }
  if (valBounds.length) {
    let best = null;
    for (const b of valBounds) {
      if (best == null || b.v > best.v) best = b;
    }
    maxV = best.strict ? Math.max(0, best.v - 1) : best.v;
    notes.push('值域上限取 ' + maxV + (best.strict ? '（严格小于 ' + best.v + '）' : ''));
  }

  return { maxSum, maxN, maxV, notes };
}

/* --------------------------------------------------------- 覆盖表与题面来源 */

/** <storeDir>/limits.json：人工覆盖表（最权威），形如 { "2268C": { "timeLimitMs": 2000, "maxN": 200000, "maxV": 262143 } } */
function loadOverrides(storeDir) {
  const file = path.join(storeDir, 'limits.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (e) {
    return { __parseError: String(e && e.message || e) };
  }
}

/** 应用缓存里的题目 JSON（含 timeLimit / memoryLimit） */
function readAppCache(cacheDir, id) {
  if (!cacheDir) return null;
  const file = path.join(cacheDir, id + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const NUMERIC_KEYS = {
  contestId: 1, index: 1, title: 1, statement: 1, samples: 1, tags: 1, rating: 1, warnings: 1
};

/**
 * 解析一道题的真实时限与内存。
 * 优先级：limits.json 覆盖 → problems.json 自带字段 → 应用缓存 → 题面文本 → 默认值。
 */
function resolveLimits(problem, opts) {
  const o = opts || {};
  const overrides = o.overrides || {};
  const ov = overrides[problem.id] || {};
  if (ov.timeLimitMs) {
    return { timeLimitMs: Number(ov.timeLimitMs), memoryLimitMb: ov.memoryLimitMb || null, source: 'override' };
  }
  if (problem.timeLimit) {
    const ms = parseTimeLimitMs(problem.timeLimit);
    if (ms) return { timeLimitMs: ms, memoryLimitMb: parseMemoryMb(problem.memoryLimit), source: 'problem' };
  }
  const cached = readAppCache(o.cacheDir, problem.id);
  if (cached && cached.timeLimit) {
    const ms = parseTimeLimitMs(cached.timeLimit);
    if (ms) return { timeLimitMs: ms, memoryLimitMb: parseMemoryMb(cached.memoryLimit), source: 'cache' };
  }
  const scanned = scanStatement(problem.statement);
  void scanned;
  return { timeLimitMs: DEFAULT_TIME_LIMIT_MS, memoryLimitMb: null, source: 'default' };
}

/** 解析一道题的最大规模与值域上限 */
function resolveScale(problem, opts) {
  const o = opts || {};
  const overrides = o.overrides || {};
  const ov = overrides[problem.id] || {};
  const scanned = scanStatement(problem.statement);
  if (ov.maxN || ov.maxV) {
    return {
      maxN: Number(ov.maxN) || DEFAULT_MAX_SCALE,
      maxV: ov.maxV != null ? Number(ov.maxV) : (scanned.maxV || DEFAULT_MAX_VALUE),
      source: 'override', notes: scanned.notes
    };
  }
  const maxN = scanned.maxN || DEFAULT_MAX_SCALE;
  const maxV = scanned.maxV || DEFAULT_MAX_VALUE;
  return { maxN, maxV, source: scanned.maxN ? 'parsed' : 'default', notes: scanned.notes };
}

/* -------------------------------------------------------------- 生成器来源 */

function looksTierAware(code) {
  const s = String(code || '');
  return /argv|process\.argv|sys\.argv/i.test(s);
}

function extFor(lang) {
  const l = String(lang || '').toLowerCase();
  if (l === 'python' || l === 'py') return 'py';
  if (l === 'js' || l === 'javascript' || l === 'node') return 'js';
  return 'cpp';
}

/** 在 storeDir 下找某个题的 tier-aware 生成器（跑分时由 生成器 Agent 产出、读 argv 的那一版） */
function findRunGen(storeDir, id, ext, extraRoots) {
  const roots = [
    path.join(storeDir, 'l2-data'),
    path.join(storeDir, 'gen-scale')
  ];
  // 别的 store 里产出的生成器可以借来用（cost-sample 这类"只有 records 没有生成器"的目录）
  for (const extra of (extraRoots || [])) {
    roots.push(path.join(extra, 'l2-data'), path.join(extra, 'gen-scale'));
  }
  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'sandbox' || e.name === 'node_modules' || e.name === '.git') continue;
          stack.push(full);
        } else if (e.isFile() && /^gen\.(py|cpp|js)$/.test(e.name) && new RegExp('[\\\\/]ab-' + id + '[\\\\/]').test(full)) {
          hits.push(full);
        }
      }
    }
  }
  // 也接受 <store>/gen-scale/<id>.<ext>（以及借用来的 store）
  const direct = path.join(storeDir, 'gen-scale', id + '.' + ext);
  if (fs.existsSync(direct)) hits.unshift(direct);
  for (const extra of (extraRoots || [])) {
    const d2 = path.join(extra, 'gen-scale', id + '.' + ext);
    if (fs.existsSync(d2)) hits.unshift(d2);
  }
  for (const file of hits) {
    let code = '';
    try { code = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    if (!code.trim()) continue;
    return { file, code, lang: ext === 'py' ? 'python' : (ext === 'js' ? 'js' : 'cpp'), tierAware: looksTierAware(code), from: 'gen-scale' };
  }
  return null;
}

/** 判定这道题判分时该用哪个生成器：优先 tier-aware 的，退而用 store 里的老版本（同时标记它规模不可信） */
function resolveGen(storeDir, problem, opts) {
  const o = opts || {};
  const lang = (problem.gen && problem.gen.lang) || 'python';
  const ext = extFor(lang);
  const runGen = findRunGen(storeDir, problem.id, ext, o.genRoots);
  if (runGen) return runGen;
  const file = problem.gen && problem.gen.file;
  if (!file || !fs.existsSync(file)) return null;
  let code = '';
  try { code = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  return { file, code, lang, tierAware: looksTierAware(code), from: 'store' };
}

/* ------------------------------------------------------------------ 规模校验 */

/**
 * 生成器真的按我们要求的规模出数据了吗？
 * 用"数字 token 数 / 字节数"这种与题面格式无关的代理量判断：
 * 要求至少达到 tier/8（2268C 在 tier=200000 时会产出 ~200001 个数字 token，远超阈值；
 * 而 store 里那个 n≤6 的老生成器只有几十个 token → 直接判 gen-weak）。
 */
function checkScale(input, tier) {
  const text = String(input || '');
  const tokens = (text.match(/\d+/g) || []).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const want = Math.max(8, Math.floor((Number(tier) || 0) / 8));
  const ok = tokens >= want || bytes >= want * 2;
  return { ok, tokens, bytes, want, factor: Number((tokens / Math.max(1, Number(tier) || 1)).toFixed(3)) };
}

/**
 * 生成"真的够大"的数据：随机化生成器一次调用可能只吐玩具规模，所以多试几次取最大的一次。
 * @returns {Promise<{g:?object, sc:?object, tries:number, err:?string}>} sc.ok 为真表示达到了规模要求
 */
async function genCaseBig(arena, tier, valueCap, opts) {
  const o = opts || {};
  const tries = Math.max(1, Number(o.tries) || MAX_SCALE_TRIES);
  let best = null;
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    const g = await arena.genCase(tier, o.genTimeoutMs || DEFAULT_GEN_TIMEOUT_MS, valueCap);
    if (!g.ok) { lastErr = String(g.err || ''); continue; }
    const sc = checkScale(g.input, tier);
    if (best == null || sc.tokens > best.sc.tokens) best = { g, sc, tries: i };
    if (sc.ok) return { g, sc, tries: i };
  }
  if (best) return best;
  return { g: null, sc: null, tries, err: lastErr };
}

/* ------------------------------------------------------------------ 主流程 */

function readPart(part) {
  if (!part || !part.file) return null;
  if (!fs.existsSync(part.file)) return null;
  const code = fs.readFileSync(part.file, 'utf8');
  if (!String(code).trim()) return null;
  return { lang: part.lang || 'cpp', code, file: part.file };
}

/**
 * 对一条提交跑完整的 CF-AC 判定。
 *
 * @param {object} opts
 *   - storeDir   跑分目录（用于找 tier-aware 生成器与覆盖表）
 *   - problem    题目对象（problems.json 里那条）
 *   - code/codeLang  被判定者的代码
 *   - cacheDir   应用题面缓存目录（读 timeLimit）
 *   - tiers      正确性对拍的规模档（默认 [30,200,2000]）
 *   - generousMs 最大规模超时后的宽松上限（默认 20000）
 *   - genTimeoutMs 生成器超时（默认 30000）
 * @returns {Promise<object>} verdict（含 cfac 布尔与全部依据）
 */
async function runRuler(opts) {
  const o = opts || {};
  const problem = o.problem;
  const overrides = o.overrides || loadOverrides(o.storeDir);
  const limits = resolveLimits(problem, { overrides, cacheDir: o.cacheDir });
  const scale = resolveScale(problem, { overrides });
  const gen = resolveGen(o.storeDir, problem, o);
  const base = {
    timeLimitMs: limits.timeLimitMs,
    timeLimitSource: limits.source,
    memoryLimitMb: limits.memoryLimitMb,
    maxTier: scale.maxN,
    maxTierSource: scale.source,
    valueCap: scale.maxV,
    scaleNotes: scale.notes,
    genFrom: gen ? gen.from : null,
    genTierAware: gen ? !!gen.tierAware : false,
    genFile: gen ? gen.file : null
  };
  const code = String(o.code || '');
  // 多解题（输出任意合法答案）：样例/对拍"对不上"都不能证明候选错 —— 只有 checker 能判。
  // 与老判分（ablation/judge.js）共用同一份题面启发式（lib/statement.js 的 looksSpecialJudge），
  // 否则 2241B 这种"样例对不上但差分一致"的格子会被这把尺子误杀。
  // limits.json 可以强制指定（题面启发式会漏、也可能误命中）；显式覆盖优先。
  const ovRow = overrides[problem.id] || {};
  const special = ovRow.specialJudge != null
    ? !!ovRow.specialJudge
    : (typeof statementLib.looksSpecialJudge === 'function'
      ? !!statementLib.looksSpecialJudge(problem && problem.statement)
      : false);
  base.specialJudge = special;
  if (!code.trim()) return Object.assign(base, { cfac: false, verdict: 'no-code' });
  const oracle = readPart(problem.oracle);
  if (!oracle) return Object.assign(base, { cfac: false, verdict: 'no-oracle' });
  if (!gen) return Object.assign(base, { cfac: false, verdict: 'no-gen' });
  if (!gen.tierAware) {
    // 老生成器不认规模档：对拍只能是玩具规模 → **不能**据此声称 AC
    return Object.assign(base, { cfac: false, verdict: 'gen-weak', detail: '生成器不读 argv，规模不可信' });
  }

  const arena = await runner.openArena(
    {
      sol: { lang: o.codeLang || 'cpp', code },
      brute: { lang: oracle.lang, code: oracle.code },
      gen: { lang: gen.lang, code: gen.code }
    },
    { bruteTimeoutMs: o.bruteTimeoutMs || 30000 }
  );
  if (!arena.ok) return Object.assign(base, { cfac: false, verdict: 'arena-error', detail: arena.error });

  try {
    // ① 官方样例
    const smp = await arena.runSamples('sol', problem.samples || [], limits.timeLimitMs);
    const sampleVerdict = smp.allPass
      ? 'AC'
      : ((smp.results.find((r) => r.verdict !== 'AC' && r.verdict !== 'OK') || { verdict: 'WA' }).verdict);
    const samples = { verdict: sampleVerdict, results: smp.results.slice(0, 3) };
    if (sampleVerdict !== 'AC') {
      if (!special) return Object.assign(base, { cfac: false, verdict: 'sample-' + sampleVerdict, samples });
      // 多解题：样例对不上 ≠ 错（题面允许任意合法答案）→ 样例关不作为判错依据，继续往下判
      samples.verdict = 'special-judge';
      samples.note = '这题是多解题：样例对不上不能当判错依据（要判得靠 checker）';
    }

    // ② 多档规模随机对拍（与外部 AC 提交比）
    const tiers = (o.tiers || DIFF_TIERS).slice();
    const diffs = [];
    let diffVerdict = 'AC';
    for (const tier of tiers) {
      const picked = await genCaseBig(arena, tier, scale.maxV, { genTimeoutMs: o.genTimeoutMs, tries: o.diffTries || 3 });
      if (!picked.g) { diffVerdict = 'run-error'; diffs.push({ tier, status: 'gen-error', detail: String(picked.err || '').slice(0, 200) }); break; }
      if (!picked.sc.ok) { diffVerdict = 'gen-weak'; diffs.push({ tier, status: 'gen-weak', scale: picked.sc, tries: picked.tries }); break; }
      const c = await arena.compare(picked.g.input, 'brute', 'sol', limits.timeLimitMs);
      diffs.push({
        tier,
        status: c.same ? 'same' : 'mismatch',
        scale: picked.sc,
        tries: picked.tries,
        solMs: c.b && c.b.timeMs,
        oracleMs: c.a && c.a.timeMs,
        expected: c.same ? null : c.a.output,
        actual: c.same ? null : c.b.output
      });
      if (!c.same) {
        // 多解题 + 没有 checker：两边都可能是对的 → 这一格不可判，别冒充候选错（与老判分同一立场）
        diffVerdict = special ? 'special-judge' : 'WA';
        break;
      }
    }
    if (diffVerdict !== 'AC') {
      const out = {
        cfac: false,
        verdict: diffVerdict === 'special-judge' ? 'special-judge' : 'diff-' + diffVerdict,
        samples, diffs
      };
      if (diffVerdict === 'special-judge') {
        out.diffUnreliable = true;
        out.detail = '对拍不一致，但这题是多解题且没有 checker：两边都可能是对的 → 这一格不可判';
      }
      return Object.assign(base, out);
    }

    // ③ 最大规模 + 真实时限（这一关才是"CF 上能不能过"）
    // oracle 先跑（它是标准答案的来源）。oracle 自己跑不完时**换一份随机输入重试**：
    // 判成 oracle-error-at-max 让候选背锅是不对的（受影响过：ui 的 L1 2268C、cost-sample 的 L2 2268C，
    // 同一条 oracle 在别的随机抽样上只要几百毫秒 —— 差别全在运气）。
    const oracleMs = o.oracleMs || DEFAULT_ORACLE_MS;
    const oracleTries = Math.max(1, Number(o.oracleTries) || DEFAULT_ORACLE_TRIES);
    let pickedBig = null;
    let gBig = null;
    let bigScale = null;
    let oracleRun = null;
    let oracleAttempts = 0;
    let oracleLastFail = null;
    for (let i = 1; i <= oracleTries; i++) {
      oracleAttempts = i;
      // 第一次多试几次拿到"真的够大"的数据；重试时只抽一次（要的是**另一份**数据，不是更大的）
      pickedBig = await genCaseBig(arena, scale.maxN, scale.maxV, {
        genTimeoutMs: o.genTimeoutMs,
        tries: i === 1 ? (o.maxTries || MAX_SCALE_TRIES) : 1
      });
      gBig = pickedBig.g;
      if (!gBig) return Object.assign(base, { cfac: false, verdict: 'gen-error-at-max', samples, diffs, detail: String(pickedBig.err || '').slice(0, 300) });
      bigScale = Object.assign({}, pickedBig.sc, { tries: pickedBig.tries });
      if (!bigScale.ok) {
        return Object.assign(base, { cfac: false, verdict: 'gen-weak-at-max', samples, diffs, maxScale: bigScale });
      }
      oracleRun = await arena.run('brute', gBig.input, oracleMs);
      if (oracleRun.ok) break;
      oracleLastFail = {
        ok: false, timedOut: !!oracleRun.timedOut,
        inputTokens: bigScale.tokens, bytes: Buffer.byteLength(gBig.input, 'utf8'),
        err: String(oracleRun.err || '').slice(0, 300)
      };
    }
    bigScale.oracleAttempts = oracleAttempts;
    bigScale.oracleBudgetMs = oracleMs;
    if (!oracleRun || !oracleRun.ok) {
      return Object.assign(base, {
        cfac: false, verdict: 'oracle-error-at-max', samples, diffs, maxScale: bigScale,
        oracle: Object.assign({ attempts: oracleAttempts }, oracleLastFail),
        detail: '换了 ' + oracleAttempts + ' 份随机数据，oracle 自己在 ' + oracleMs + 'ms 内都没跑完 → 这份尺子在这题的最大规模上不成立，这一格不可判（不是候选的错）'
      });
    }
    const solRun = await arena.run('sol', gBig.input, limits.timeLimitMs);
    const maxScale = Object.assign({}, bigScale, {
      oracleMs: oracleRun.timeMs,
      measuredMs: solRun.timedOut ? limits.timeLimitMs : solRun.timeMs
    });
    const same = !solRun.timedOut && solRun.ok && runner.compareOutputs(oracleRun.output, solRun.output).ok;

    let verdict;
    if (solRun.timedOut) {
      // 轻超时？还是差了数量级？用宽松上限再跑一次 —— 报告要能区分这两件事
      const retry = await arena.run('sol', gBig.input, o.generousMs || DEFAULT_GENEROUS_MS);
      maxScale.generousMs = o.generousMs || DEFAULT_GENEROUS_MS;
      if (retry.ok) {
        verdict = 'slow';
        maxScale.measuredMs = retry.timeMs;
      } else {
        verdict = 'TLE';
        maxScale.measuredMs = null;
      }
      maxScale.same = same;
      maxScale.ratioToOracle = maxScale.measuredMs && oracleRun.timeMs
        ? Number((maxScale.measuredMs / Math.max(1, oracleRun.timeMs)).toFixed(2)) : null;
      return Object.assign(base, { cfac: false, verdict, samples, diffs, maxScale });
    }
    if (!solRun.ok) {
      return Object.assign(base, {
        cfac: false, verdict: 'RE', samples, diffs, maxScale,
        err: String(solRun.err || '').slice(0, 300)
      });
    }
    maxScale.same = same;
    maxScale.ratioToOracle = oracleRun.timeMs ? Number((solRun.timeMs / Math.max(1, oracleRun.timeMs)).toFixed(2)) : null;
    if (!same) {
      if (special) {
        return Object.assign(base, {
          cfac: false, verdict: 'special-judge', samples, diffs, maxScale, diffUnreliable: true,
          detail: '最大规模上答案不一致，但这是多解题且没有 checker → 不可判（跑得动/跑不动的实测仍记在 maxScale 里）'
        });
      }
      return Object.assign(base, {
        cfac: false, verdict: 'WA-at-max', samples, diffs, maxScale,
        expected: String(oracleRun.output || '').slice(0, 400),
        actual: String(solRun.output || '').slice(0, 400)
      });
    }
    // 跑得动、答案对、且在真实时限内
    if (solRun.timeMs > limits.timeLimitMs) {
      return Object.assign(base, { cfac: false, verdict: 'slow', samples, diffs, maxScale });
    }
    return Object.assign(base, { cfac: true, verdict: 'AC', samples, diffs, maxScale });
  } finally {
    arena.close();
  }
}

/** 把一批 verdict 汇总成"按档"的表（与 judge.js 的 summarizeByLevel 同形，但只认 cfac） */function summarizeCfac(verdicts) {
  const groups = {};
  for (const v of verdicts || []) {
    const lvl = v.level || '?';
    if (!groups[lvl]) {
      groups[lvl] = {
        total: 0, cfac: 0, sampleAC: 0, diffAC: 0,
        noCode: 0, noOracle: 0, noGen: 0, genWeak: 0,
        tle: 0, slow: 0, wa: 0, re: 0, other: 0, oracleBroken: 0, costTotal: 0, specialJudge: 0
      };
    }
    const g = groups[lvl];
    g.total++;
    const sampleVerdict = v.sampleVerdict || (v.samples && v.samples.verdict);
    if (sampleVerdict === 'AC') g.sampleAC++;
    if (v.diffVerdict === 'AC' || (v.diffs && v.diffs.length && v.diffs.every((d) => d.status === 'same'))) g.diffAC++;
    if (v.cfac) g.cfac++;
    if (v.cost != null && Number.isFinite(Number(v.cost))) g.costTotal += Number(v.cost);
    if (v.specialJudge) g.specialJudge++;
    const verdict = String(v.verdict || '');
    if (verdict === 'no-code') g.noCode++;
    else if (verdict === 'no-oracle') g.noOracle++;
    else if (verdict === 'no-gen') g.noGen++;
    else if (/gen-weak/.test(verdict)) g.genWeak++;
    else if (verdict === 'TLE') g.tle++;
    else if (verdict === 'slow') g.slow++;
    else if (/WA/.test(verdict)) g.wa++;
    else if (verdict === 'RE') g.re++;
    else if (/oracle-error/.test(verdict)) g.oracleBroken++;
    else if (verdict !== 'AC') g.other++;
  }
  return groups;
}

module.exports = {
  DEFAULT_TIME_LIMIT_MS,
  DEFAULT_MAX_SCALE,
  DEFAULT_MAX_VALUE,
  DIFF_TIERS,
  DEFAULT_GENEROUS_MS,
  DEFAULT_ORACLE_MS,
  DEFAULT_ORACLE_TRIES,
  parseTimeLimitMs,
  parseMemoryMb,
  parseNumExpr,
  flattenStatement,
  scanStatement,
  loadOverrides,
  resolveLimits,
  resolveScale,
  resolveGen,
  findRunGen,
  looksTierAware,
  checkScale,
  genCaseBig,
  MAX_SCALE_TRIES,
  runRuler,
  summarizeCfac
};
