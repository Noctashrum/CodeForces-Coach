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
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
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
/**
 * 最大档要抽几份数据。生成器是随机的（`random.randint`、洗牌、随机树…），**一份数据只是一次抽样**：
 * 抽到一份宽容的就能过、抽到一份苛刻的就误杀。产品侧的性能闸已经改成"抽 3 份取最慢"
 * （docs/why-we-lag-2026-10-09.md §6.9），尺子必须同一口径，否则 CF-AC 判定也会押运气。
 */
const DEFAULT_MAX_SCALE_CASES = 3;
const MAX_SCALE_CASES = 10;
/**
 * 对拍档（30/200/2000）每一档也抽几份。同一个道理：一份随机数据只是一次抽样，
 * 同一格两次重判可能一次 mismatch 一次 same —— 2026-10-10 实测 2257F1 的 200 档：
 * 老判分记 `diff-WA（200:mismatch）`，抽 3 份最大档重判时同档三次都 same，最后判的是 `slow`。
 * 判据取"这一档抽的每一份都一致"，抽到错答就照旧立刻判 WA（真 bug 不看运气，是"没有 bug"要看运气）。
 */
const DEFAULT_DIFF_CASES = 2;
const MAX_DIFF_CASES = 10;

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
 *
 * ⚠️ 产品侧的性能闸有一份**同规则**的实现（`lib/limits.js` 的 `scanStatement`）：
 *    交付侧说"按题面上限计时"、尺子在同一个上限上判分，两边必须是同一个最坏输入，
 *    否则"已验证"与判词必然打架。改动这里之后请跑
 *    `node .probe/probe-limits-vs-ruler.js`（现状：73 道入库题目两侧 maxN/maxV **全一致**）。
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

/* ------------------------------------------------------- checker（special judge）
 * 多解题（合法答案不唯一）的终极判据是 checker：给它「输入 / 选手输出 / 标尺答案」三份文件，
 * 它说合法就是 AC，说不合法就是 WA —— 这比"两边文本一样"强得多，也是 2257C / 2267B / 2250F
 * 这些格子从"不可判"变成"可判"的唯一办法。
 *
 * 纪律（都为了让判分可信，而不是为了让候选好过）：
 *   ① checker 必须先**自检**：拿官方样例答案同时当"选手输出"与"标尺答案"喂进去，必须判 AC。
 *      自检不过 → 这把 checker 不可信，本次直接忽略它（记 checker.trusted=false），回落 special-judge。
 *      宁可不可判，也不拿坏 checker 判候选的错。
 *   ② checker 自己跑挂/超时 → 不判 WA，记下原因并回落 special-judge（不可判）。
 *   ③ 候选在这一档超时/跑挂，先按 TLE/RE 走（那是"慢"与"崩"，不是"答案不合法"）。
 *   ④ 退出码按 testlib 约定读：0=OK、1=WA、2=PE，**其它（含 3=FAIL）都算"checker 没给出结论"**
 *      → 回落 special-judge。元宝的 checker 会在"jury 不是最优"时返回 3：那是标尺的锅，不是候选的锅。
 */

/** 找这道题的 checker：limits.json 的 `checker` 字段（最权威）→ <storeDir>/checker/<id>.* → ablation/checker/<id>.* */
function resolveChecker(storeDir, problem, overrides) {
  const id = problem && problem.id;
  if (!id) return null;
  const exts = ['.py', '.exe', '.cpp', '.cc', '.cxx'];
  const ov = (overrides || {})[problem.id] || {};
  const cands = [];
  if (ov.checker) {
    const f = path.isAbsolute(ov.checker) ? ov.checker : path.resolve(storeDir || '.', ov.checker);
    cands.push({ file: f, source: 'override' });
  }
  const dirs = [];
  if (storeDir) { dirs.push({ dir: path.join(storeDir, 'checker'), source: 'store' }); dirs.push({ dir: storeDir, source: 'store' }); }
  dirs.push({ dir: path.join(__dirname, '..', 'checker'), source: 'repo' });
  for (const d of dirs) for (const ext of exts) cands.push({ file: path.join(d.dir, id + ext), source: d.source });
  for (const c of cands) {
    let st = null;
    try { st = fs.statSync(c.file); } catch (e) { st = null; }
    if (!st || !st.isFile()) continue;
    const ext = path.extname(c.file).toLowerCase();
    return { file: c.file, lang: ext === '.py' ? 'python' : (ext === '.exe' ? 'exe' : 'cpp'), source: c.source };
  }
  return null;
}

/** 准备 checker：.cpp 编译一次（按 mtime 缓存到 .build/），.py / .exe 直接用 */
function buildChecker(ck, opts) {
  if (!ck) return { ok: false, error: 'no-checker' };
  if (ck.lang !== 'cpp') return { ok: true, exe: ck.file };
  const buildDir = (opts && opts.buildDir) || path.join(path.dirname(ck.file), '.build');
  try { fs.mkdirSync(buildDir, { recursive: true }); } catch (e) { /* 建不出来就让编译自己报错 */ }
  const exe = path.join(buildDir, path.basename(ck.file).replace(/\.[^.]+$/, '') + '.exe');
  try {
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(ck.file).mtimeMs) return { ok: true, exe, cached: true };
  } catch (e) { /* 继续编译 */ }
  const r = spawnSync('g++', ['-O2', '-std=c++17', '-Wl,--stack,268435456', ck.file, '-o', exe], {
    encoding: 'utf8', timeout: 120000, windowsHide: true
  });
  if (r.error) return { ok: false, error: 'g++：' + String(r.error.message || r.error).slice(0, 200) };
  if (r.status !== 0 || !fs.existsSync(exe)) {
    const msg = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' / ');
    return { ok: false, error: 'g++ 编译失败（exit ' + r.status + '）：' + msg.slice(0, 300) };
  }
  return { ok: true, exe };
}

/**
 * 跑一次 checker：三份临时文件 → 退出码判定（0 = 候选合法；1/2 = 候选不合法；
 * 其它含 3 = FAIL = checker 自己没给出结论，见下方注释）。
 */
function runCheckerOnce(built, input, participant, jury, timeoutMs) {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfac-checker-'));
    const fi = path.join(dir, 'in.txt');
    const fo = path.join(dir, 'out.txt');
    const fa = path.join(dir, 'ans.txt');
    fs.writeFileSync(fi, String(input == null ? '' : input));
    fs.writeFileSync(fo, String(participant == null ? '' : participant));
    fs.writeFileSync(fa, String(jury == null ? '' : jury));
    const isPy = /\.py$/i.test(built.exe);
    const cmd = isPy ? (process.platform === 'win32' ? 'python' : 'python3') : built.exe;
    const argv = isPy ? [built.exe, fi, fo, fa] : [fi, fo, fa];
    const r = spawnSync(cmd, argv, { cwd: dir, encoding: 'utf8', timeout: timeoutMs || 15000, windowsHide: true });
    const out = String((r.stdout || '') + '\n' + (r.stderr || '')).trim();
    const detail = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-2).join(' | ').slice(0, 220);
    if (r.error) return { ok: false, error: 'checker 起不来：' + String(r.error.message || r.error).slice(0, 200) };
    if (r.status === null || r.signal) return { ok: false, error: 'checker 超时或被信号终止' + (detail ? '：' + detail : '') };
    // 退出码约定（testlib：0=OK / 1=WA / 2=PE / 3=FAIL）：
    //   0 → 候选合法；1 / 2 → 候选不合法（WA / PE）；**其它（含 3=FAIL）→ checker 自己没给出可用结论** ⇒
    //   不能算候选的错，调用方必须回落 special-judge（2257C 的 checker 在"jury 不是最优"时会返回 3，
    //   那是标尺（我们的 oracle）不行，不是候选不行 —— 这一条不区分开就会把标尺的锅扣到候选头上）。
    if (r.status === 0) return { ok: true, ac: true, exit: 0, detail: detail || 'OK' };
    if (r.status === 1 || r.status === 2) {
      return { ok: true, ac: false, exit: r.status, verdict: r.status === 2 ? 'PE' : 'WA', detail: detail || ('exit ' + r.status) };
    }
    return { ok: false, error: 'checker 自己没给出可用结论（exit ' + r.status + '）' + (detail ? '：' + detail : '') };
  } catch (e) {
    return { ok: false, error: 'checker 运行异常：' + String(e && e.message || e).slice(0, 200) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 只降级 */ } }
  }
}

/**
 * 从 `arena.compare` 的一次运行结果里取**完整输出**。
 * `compare` 返回的 `output` 是给报告用的截断版（1500 字符），checker 必须吃 `full`；
 * 没有 `full`（老的 runner）时退回 `output`，宁可像以前那样"checker 说 jury 太短"也不要崩。
 */
function fullOut(r) {
  if (!r) return '';
  return r.full != null ? String(r.full) : String(r.output || '');
}

/**
 * 从样例结果里取**完整**的 input / actual / expected（`arena.runSamples` 的 `*Full` 字段）。
 * 官方样例也可能输出很长（截断版只有 800 字符）→ 拿截断版喂 checker 会把对的判成
 * "output ended at line 1" 这类假 PE。
 */
function sampleFull(r, which) {
  const k = which + 'Full';
  if (r && r[k] != null) return String(r[k]);
  return String((r && r[which]) || '');
}

/** checker 自检：官方样例答案当选手输出必须 AC；样例全过才算可信 */
function checkerSelfTest(built, samples) {
  const list = (samples || []).filter((s) => s && s.input != null && s.output != null);
  if (!list.length) return { trusted: true, tested: 0, note: '没有官方样例可自检：按可信处理，但无法自证' };
  const failures = [];
  for (const s of list) {
    const r = runCheckerOnce(built, s.input, s.output, s.output, 15000);
    if (!r.ok || !r.ac) {
      failures.push({
        input: String(s.input).replace(/\s+/g, ' ').slice(0, 80),
        why: r.ok ? ('checker 把官方答案判成 WA：' + r.detail) : r.error
      });
    }
  }
  if (failures.length) return { trusted: false, tested: list.length, failures, note: 'checker 与官方答案矛盾 → 本次忽略它，回落到 special-judge（不可判）' };
  return { trusted: true, tested: list.length };
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
  // 多解题的终极判据：checker（有就判得动；没有就只能 special-judge = 不可判）
  let checkerUsable = null;
  if (special && !o.noChecker) {
    const ck = o.checker === undefined ? resolveChecker(o.storeDir, problem, overrides) : o.checker;
    if (ck) {
      const built = buildChecker(ck, { buildDir: o.checkerBuildDir });
      if (!built.ok) {
        base.checker = { file: ck.file, lang: ck.lang, source: ck.source, trusted: false, note: 'checker 准备失败：' + built.error };
      } else {
        const st = checkerSelfTest(built, problem.samples);
        base.checker = {
          file: ck.file, lang: ck.lang, source: ck.source,
          trusted: !!st.trusted, selfTested: st.tested || 0, note: st.note || null
        };
        if (st.failures) base.checker.selfTestFailures = st.failures;
        if (st.trusted) checkerUsable = built;
      }
    }
  }
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
      // 有可信 checker 时，样例只有一条合法答案也不是问题：让 checker 判候选输出**合不合法**
      if (checkerUsable) {
        const fails = smp.results.filter((r) => r.verdict !== 'AC' && r.verdict !== 'OK');
        const judged = [];
        for (const r of fails.slice(0, 3)) {
          const ck = runCheckerOnce(checkerUsable, sampleFull(r, 'input'), sampleFull(r, 'actual'), sampleFull(r, 'expected'), 30000);
          judged.push({ index: r.index, ok: ck.ok, ac: ck.ok ? !!ck.ac : undefined, detail: ck.ok ? ck.detail : ck.error });
        }
        samples.checker = judged;
        if (judged.length && judged.every((j) => j.ok && j.ac)) {
          samples.verdict = 'AC';
          samples.note = '多解题：checker 判定官方样例上的输出合法（与官方答案文本不同不算错）';
        } else if (judged.length && judged.every((j) => j.ok && !j.ac)) {
          base.checker = Object.assign({}, base.checker, { decided: 'sample-WA' });
          return Object.assign(base, {
            cfac: false, verdict: 'sample-WA', samples,
            detail: 'checker 判定候选输出在官方样例上不合法（这题是多解题，所以这里靠 checker 而不是文本比对）'
          });
        } else {
          samples.note += '；checker 在样例上没给出可用结论（'
            + judged.map((j) => '样例' + j.index + '：' + (j.ok ? (j.ac ? 'AC' : 'WA') : '跑不动')).join('、') + '）';
        }
      }
    }

    // ② 多档规模随机对拍（与外部 AC 提交比）
    // 每一档抽**若干份**随机数据：一份数据只是一次抽样，同一格两次重判可能一次 mismatch 一次 same
    // （2026-10-10 实测 2257F1 的 200 档，两次重判结论不同）⇒ 一档多抽几份，判据取"全一致"。
    const tiers = (o.tiers || DIFF_TIERS).slice();
    const diffs = [];
    let diffVerdict = 'AC';
    const diffCases = Math.max(1, Math.min(MAX_DIFF_CASES, Number(o.diffCases) || DEFAULT_DIFF_CASES));
    for (const tier of tiers) {
      let row = null;
      let bad = false;
      for (let k = 1; k <= diffCases && !bad; k++) {
        const picked = await genCaseBig(arena, tier, scale.maxV, {
          genTimeoutMs: o.genTimeoutMs,
          tries: k === 1 ? (o.diffTries || 3) : 1
        });
        if (!picked.g) {
          diffVerdict = 'run-error';
          row = { tier, cases: k, status: 'gen-error', detail: String(picked.err || '').slice(0, 200) };
          bad = true;
          break;
        }
        if (!picked.sc.ok) {
          diffVerdict = 'gen-weak';
          row = { tier, cases: k, status: 'gen-weak', scale: picked.sc, tries: picked.tries };
          bad = true;
          break;
        }
        const c = await arena.compare(picked.g.input, 'brute', 'sol', limits.timeLimitMs);
        row = {
          tier,
          cases: k,
          status: c.same ? 'same' : 'mismatch',
          scale: picked.sc,
          tries: picked.tries,
          solMs: c.b && c.b.timeMs,
          oracleMs: c.a && c.a.timeMs,
          expected: c.same ? null : c.a.output,
          actual: c.same ? null : c.b.output
        };
        if (!c.same) {
          // 先把"不是候选的错"分出去，别一律记成 WA（2026-10-09）：
          //   · 候选在**这一档**超时      → TLE（候选太慢，不是答案错）
          //   · 候选在这一档跑挂（RE/编译失败）→ RE
          //   · 标尺（外部 AC 提交）自己跑挂  → oracle-run-error（不可判，不能算候选头上）
          // 老判分把这三类统统落到 `diff-WA`：2247F 就是这么被记错的 —— 交付码与 oracle 逐 token 相同，
          // 只是最大规模档 12.1s 撞上 3s 时限，判分却写 `diff-WA`，让人以为"答案是错的"。
          bad = true;
          if (c.a && !c.a.ok) {
            diffVerdict = 'oracle-run-error';
            row.status = 'oracle-error';
            row.detail = String(c.a.err || '').slice(0, 200);
            break;
          }
          if (c.b && c.b.timedOut) {
            diffVerdict = 'TLE';
            row.status = 'timeout';
            row.solMs = c.b.timeMs;
            break;
          }
          if (c.b && !c.b.ok) {
            diffVerdict = 'RE';
            row.status = 'run-error';
            row.detail = String(c.b.err || '').slice(0, 200);
            break;
          }
          // 有可信 checker：答案形态不同不算错，让 checker 判候选输出合不合法
          if (checkerUsable) {
            // 必须用 full（未截断）输出：`output` 被截到 1500 字符，大输出会被 checker 判成
            // "jury output is too short" → 本来能判的格子退回"不可判"（2026-10-10 实测 2257C tier 2000）。
            const ck = runCheckerOnce(checkerUsable, picked.g.input, fullOut(c.b), fullOut(c.a), 30000);
            if (ck.ok && ck.ac) { row.status = 'checker-ac'; row.checker = 'accept'; bad = false; continue; }
            if (ck.ok && !ck.ac) {
              row.status = 'checker-wa';
              row.checker = 'reject';
              row.detail = 'checker 判定候选输出不合法：' + ck.detail;
              diffVerdict = 'WA';
              break;
            }
            row.checker = 'error';
            row.checkerError = ck.error;
          }
          // 多解题 + 没有（可信）checker：两边都可能是对的 → 这一格不可判，别冒充候选错（与老判分同一立场）
          diffVerdict = special ? 'special-judge' : 'WA';
          break;
        }
      }
      if (row) {
        // 这一档抽了几份、其中几份与标尺逐 token 一致（status==='same' 就是全一致）
        row.sameCases = row.status === 'same' ? row.cases : Math.max(0, Number(row.cases || 0) - 1);
        diffs.push(row);
      }
      if (bad) break;
    }
    if (diffVerdict !== 'AC') {
      const named = diffVerdict === 'special-judge' || diffVerdict === 'TLE' || diffVerdict === 'RE'
        || diffVerdict === 'oracle-run-error';
      const out = {
        cfac: false,
        verdict: named ? diffVerdict : 'diff-' + diffVerdict,
        samples, diffs
      };
      if (diffVerdict === 'special-judge') {
        out.diffUnreliable = true;
        // 文案必须区分"没有 checker"和"有 checker 但它自己没给出结论"：
        // 后者是我们标尺侧的问题（例如 jury 输出被截断 / checker 认为 jury 不是最优），
        // 写成"没有 checker"会让人以为这题压根没救 —— 修起来的方向完全不同。
        const bad = diffs.find((d) => d.checker === 'error');
        out.detail = bad
          ? '对拍不一致，但这题是多解题且 checker 自己没给出结论（' + String(bad.checkerError || '').slice(0, 200) + '）→ 这一格不可判'
          : '对拍不一致，但这题是多解题且没有 checker：两边都可能是对的 → 这一格不可判';
      } else if (diffVerdict === 'TLE') {
        out.detail = '候选代码在这一档超出时限（' + limits.timeLimitMs + 'ms）→ TLE，不是答案错';
      } else if (diffVerdict === 'RE') {
        out.detail = '候选代码在这一档运行失败（RE）→ 不是答案错';
      } else if (diffVerdict === 'oracle-run-error') {
        out.diffUnreliable = true;
        out.detail = '标尺（外部 AC 提交）在这一档自己跑挂了 → 这一格不可判，不算候选的错';
      }
      return Object.assign(base, out);
    }

    // ③ 最大规模 + 真实时限（这一关才是"CF 上能不能过"）
    // 抽若干份最大档数据、**取最慢的那份**（一份数据只是一次抽样，与产品侧性能闸同源，见 §6.9）。
    // oracle（外部 AC 提交）先跑：oracle 自己就超过题面时限的那份数据**不是**官方最坏输入
    // （官方最坏输入上标准答案至少跑得完）⇒ 这份抽样直接**剔掉**、另画一份，不让候选背锅。
    // 2026-10-10 现场：机器2 的 2247D2，oracle 4.8s vs 时限 2000ms（判出来的 TLE 是尺子自己的锅）。
    const oracleMs = o.oracleMs || DEFAULT_ORACLE_MS;
    const oracleTries = Math.max(1, Number(o.oracleTries) || DEFAULT_ORACLE_TRIES);
    const wantCases = Math.max(1, Math.min(MAX_SCALE_CASES, Number(o.maxScaleCases) || DEFAULT_MAX_SCALE_CASES));
    const usable = [];        // 可用抽样：oracle 在真实时限内跑完（≥1 份才判得了）
    const rejected = [];      // 被剔掉的抽样：oracle 自己就超了题面时限
    let oracleGiveUp = 0;     // oracle 连宽松预算（oracleMs）都跑不完的抽样
    let oracleLastFail = null;
    let triesSeen = 0;
    const drawCap = wantCases + oracleTries;  // 补被剔掉的抽样所允许的额外抽样次数
    let lastScale = null;
    let genFail = '';
    for (let i = 1; i <= drawCap && usable.length < wantCases; i++) {
      triesSeen = i;
      // 第一次多试几次拿到"真的够大"的数据；后面对拍重画时只抽一次（要的是**另一份**数据，不是更大的）
      const pickedBig = await genCaseBig(arena, scale.maxN, scale.maxV, {
        genTimeoutMs: o.genTimeoutMs,
        tries: i === 1 ? (o.maxTries || MAX_SCALE_TRIES) : 1
      });
      if (!pickedBig.g) {
        genFail = String(pickedBig.err || '').slice(0, 300);
        // 一份都没抽到才算"生成器在最大档给不出数据"；已经测过几份就如实记下来、按已测的判
        if (!usable.length) return Object.assign(base, { cfac: false, verdict: 'gen-error-at-max', samples, diffs, detail: genFail });
        break;
      }
      const sc = Object.assign({}, pickedBig.sc, { tries: pickedBig.tries });
      lastScale = sc;
      if (!sc.ok) {
        if (!usable.length) return Object.assign(base, { cfac: false, verdict: 'gen-weak-at-max', samples, diffs, maxScale: sc });
        break;
      }
      const orun = await arena.run('brute', pickedBig.g.input, oracleMs);
      if (!orun.ok) {
        oracleGiveUp++;
        oracleLastFail = {
          ok: false, timedOut: !!orun.timedOut,
          inputTokens: sc.tokens, bytes: Buffer.byteLength(pickedBig.g.input, 'utf8'),
          err: String(orun.err || '').slice(0, 300)
        };
        continue;
      }
      if (Number(orun.timeMs || 0) > Number(limits.timeLimitMs)) {
        // oracle 都超了时限 ⇒ 这份随机数据比官方最坏输入还狠，剔掉（记下来，报告里要看得见）
        rejected.push({ oracleMs: Number(orun.timeMs) || 0, inputTokens: sc.tokens, bytes: Buffer.byteLength(pickedBig.g.input, 'utf8') });
        continue;
      }
      const srun = await arena.run('sol', pickedBig.g.input, limits.timeLimitMs);
      usable.push({
        input: pickedBig.g.input, sc, oracleMs: orun.timeMs, oracleOut: orun.output,
        solMs: srun.timedOut ? limits.timeLimitMs : srun.timeMs,
        timeout: !!srun.timedOut, ok: !!srun.ok, err: String(srun.err || '').slice(0, 300),
        output: srun.output
      });
      if (srun.timedOut) break;   // 已经撞上最坏情形（超时），不必再抽
    }
    const baseScale = Object.assign({}, lastScale || {}, {
      oracleAttempts: triesSeen,
      oracleBudgetMs: oracleMs,
      cases: usable.length,
      draws: triesSeen,
      rejectedOracleSlow: rejected.length,
      oracleGiveUp,
      genFail
    });
    if (!usable.length) {
      if (rejected.length) {
        const fastest = Math.min.apply(null, rejected.map((r) => Number(r.oracleMs) || 0));
        return Object.assign(base, {
          cfac: false, verdict: 'oracle-over-tl-at-max', samples, diffs, maxScale: baseScale,
          oracle: { attempts: triesSeen, rejected: rejected.slice(0, 5) },
          detail: '抽了 ' + rejected.length + ' 份最大档数据，oracle 自己每一份都超了题面时限（最快 ' + fastest
            + 'ms > 时限 ' + limits.timeLimitMs + 'ms）→ 这些数据比官方最坏输入还狠，这份尺子在这题的最大规模上判不了（不是候选的错）'
        });
      }
      return Object.assign(base, {
        cfac: false, verdict: 'oracle-error-at-max', samples, diffs, maxScale: baseScale,
        oracle: Object.assign({ attempts: triesSeen }, oracleLastFail),
        detail: '换了 ' + triesSeen + ' 份随机数据，oracle 自己在 ' + oracleMs + 'ms 内都没跑完 → 这份尺子在这题的最大规模上不成立，这一格不可判（不是候选的错）'
      });
    }
    const msEach = usable.map((u) => u.solMs);
    const worst = usable.reduce((a, b) => (b.solMs > a.solMs ? b : a));
    const oracleWorst = usable.reduce((a, b) => (Number(b.oracleMs) > Number(a.oracleMs) ? b : a)).oracleMs;
    const maxScale = Object.assign({}, baseScale, {
      oracleMs: oracleWorst,
      msEach,
      oracleMsEach: usable.map((u) => Number(u.oracleMs) || 0),
      timeLimitMs: limits.timeLimitMs,
      // 能走到这里的抽样，oracle 都在时限内 ⇒ 这一格没有"过重的数据"在替候选判死刑
      oracleOverTl: false,
      overTlRejected: rejected.length,
      measuredMs: worst.timeout ? limits.timeLimitMs : worst.solMs
    });
    const rejectNote = rejected.length
      ? '（另有 ' + rejected.length + ' 份抽样因为 oracle 自己超时限被剔掉 → maxScale.rejectedOracleSlow）' : '';

    // 逐份核答案：多解题交给 checker；checker 判不了就如实说判不了（不冒充 WA）
    const sameFlags = [];
    let checkerRejected = null;
    let specialUndecided = null;
    let crashed = null;
    let mismatchSample = null;
    for (const u of usable) {
      if (u.timeout) { sameFlags.push(false); continue; }
      if (!u.ok) { crashed = u; sameFlags.push(false); continue; }
      if (runner.compareOutputs(u.oracleOut, u.output).ok) { sameFlags.push(true); continue; }
      if (!mismatchSample) mismatchSample = u;
      if (special && checkerUsable) {
        const ck = runCheckerOnce(checkerUsable, u.input, u.output, u.oracleOut, 30000);
        u.checker = ck.ok ? (ck.ac ? 'accept' : 'reject') : 'error';
        if (ck.ok && ck.ac) { sameFlags.push(true); continue; }          // 形态不同但合法 ⇒ 与 same 等价
        if (ck.ok && !ck.ac) {
          if (!checkerRejected) checkerRejected = { u, detail: ck.detail };
          sameFlags.push(false);
          continue;
        }
        maxScale.checkerError = ck.error;                                // checker 自己跑不动 ⇒ 判不了
        if (!specialUndecided) specialUndecided = { u };
        sameFlags.push(false);
        continue;
      }
      if (special && !specialUndecided) specialUndecided = { u };
      sameFlags.push(false);
    }
    maxScale.same = sameFlags.every(Boolean);

    let verdict;
    const anyTimeout = usable.some((u) => u.timeout);
    if (anyTimeout) {
      // 轻超时？还是差了数量级？用宽松上限在**那一份**数据上重跑一次 —— 报告要能区分这两件事
      const t = usable.filter((u) => u.timeout)[0];
      const retry = await arena.run('sol', t.input, o.generousMs || DEFAULT_GENEROUS_MS);
      maxScale.generousMs = o.generousMs || DEFAULT_GENEROUS_MS;
      if (retry.ok) {
        verdict = 'slow';
        maxScale.measuredMs = Math.max(Number(retry.timeMs) || 0, ...usable.filter((u) => !u.timeout).map((u) => u.solMs));
      } else {
        verdict = 'TLE';
        maxScale.measuredMs = null;
      }
      maxScale.ratioToOracle = maxScale.measuredMs && oracleWorst
        ? Number((maxScale.measuredMs / Math.max(1, oracleWorst)).toFixed(2)) : null;
      return Object.assign(base, { cfac: false, verdict, samples, diffs, maxScale, detail: rejectNote });
    }
    if (crashed) {
      return Object.assign(base, {
        cfac: false, verdict: 'RE', samples, diffs, maxScale,
        err: String(crashed.err || '').slice(0, 300), detail: rejectNote
      });
    }
    maxScale.ratioToOracle = oracleWorst ? Number((maxScale.measuredMs / Math.max(1, oracleWorst)).toFixed(2)) : null;
    if (checkerRejected) {
      base.checker = Object.assign({}, base.checker, { decided: 'WA-at-max' });
      return Object.assign(base, {
        cfac: false, verdict: 'WA-at-max', samples, diffs, maxScale,
        detail: 'checker 判定候选输出在最大规模上不合法：' + checkerRejected.detail + rejectNote
      });
    }
    if (!maxScale.same) {
      // 走到这里只有两种情形：多解题判不了（specialUndecided），或者普通题答案不一致
      if (special && specialUndecided) {
        return Object.assign(base, {
          cfac: false, verdict: 'special-judge', samples, diffs, maxScale, diffUnreliable: true,
          detail: '最大规模上答案不一致，但这是多解题'
            + (checkerUsable ? '且 checker 自己跑不动 → ' : '且没有 checker → ')
            + '不可判（跑得动/跑不动的实测仍记在 maxScale 里）' + rejectNote
        });
      }
      const m = mismatchSample || worst;
      return Object.assign(base, {
        cfac: false, verdict: 'WA-at-max', samples, diffs, maxScale,
        expected: String(m.oracleOut || '').slice(0, 400),
        actual: String(m.output || '').slice(0, 400),
        detail: rejectNote
      });
    }
    // 跑得动、答案对、且在真实时限内（判据取最慢的那份）
    if (maxScale.measuredMs > limits.timeLimitMs) {
      return Object.assign(base, { cfac: false, verdict: 'slow', samples, diffs, maxScale, detail: rejectNote });
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
        tle: 0, slow: 0, wa: 0, re: 0, other: 0, oracleBroken: 0, oracleOverTl: 0, costTotal: 0, specialJudge: 0
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
    else if (verdict === 'oracle-over-tl-at-max') g.oracleOverTl++;
    else if (/oracle-error/.test(verdict)) g.oracleBroken++;
    else if (verdict !== 'AC') g.other++;
    // 老口径（10-10 之前）：尺子只抽一份数据，oracle 自己就超了时限时仅标"存疑"但照样判 TLE/slow。
    // 现在这种抽样会被直接剔掉（oracle-over-tl-at-max），这里保留是为了读旧 store 的判定文件。
    if ((verdict === 'TLE' || verdict === 'slow') && v.maxScale && v.maxScale.oracleOverTl) g.oracleOverTl++;
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
  DEFAULT_MAX_SCALE_CASES,
  MAX_SCALE_CASES,
  DEFAULT_DIFF_CASES,
  MAX_DIFF_CASES,
  parseTimeLimitMs,
  parseMemoryMb,
  parseNumExpr,
  flattenStatement,
  scanStatement,
  loadOverrides,
  resolveChecker,
  buildChecker,
  runCheckerOnce,
  checkerSelfTest,
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
