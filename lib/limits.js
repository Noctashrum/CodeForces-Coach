'use strict';

/**
 * 题面里的"最坏输入规模"解析（**产品侧**，性能闸用；纯函数，不联网、不写盘）。
 *
 * 为什么必须有它：性能闸的职责是"交付前按题面真实上限计时"，可它原来并不知道题面上限 ——
 *   最大规模档是**自造**的：`n = CFCOACH_PERF_GATE_MAXN`（默认 200000），
 *   数值上限是 `valueCapFor(n)`（n > 50 一律 **200**，那个 200 是为了让**暴力解**跑得动才定的约定）。
 * 后果（2026-10-10 真实流水线 A/B 撞出来的活例子，见 docs/why-we-lag-2026-10-09.md §6.7）：
 *   2250C 真实上限 n ≤ 5000、a_i ≤ 1e9；闸拿 n=200000、值 ≤200 的数据跑出 **134ms 通过**，
 *   于是记录里 `claimVerified=true`（"已按题面上限计时"），而 CF-AC 尺子在真实上限上跑出
 *   **3.8s > 时限 2000ms**（判 slow）。同一份交付物，一边说"已验证"，一边是 TLE。
 *
 * 两条纪律（写在这里，免得下次又走偏）：
 *   ① 闸里**只跑题解**（不跑暴力解），所以"值域压到 200 好让暴力跑得动"这条理由在这里**不成立**；
 *      数据该有多狠就多狠（题面允许的最坏输入才是判据）。
 *   ② 解析不到就不许**假装**知道：source 记 'override' / 'parsed' / 'partial' / 'default'，
 *      交付文案必须照实说（见 `scaleLabel`），绝不许把自造的数字说成"题面上限"。
 *      优先级：**显式覆盖（env，夹具/A-B 用）> 题面解析 > 默认兜底**。
 *      （夹具必须能钉死规模，否则同一个实验跑两次规模不同，对照就失去意义。）
 *
 * 这里的解析规则与 CF-AC 尺子 `ablation/lib/ruler.js` 的 `scanStatement` **保持一致**
 * （两侧对同一道题必须得出同一个"最坏输入"，否则交付侧的"已验证"与尺子的判分必然打架）。
 */

/** 题面里的数字表达式 → 数值：`2\cdot10^5`、`2·10^5`、`10^5`、`2^{18}`、普通整数 */
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
  const raw = Array.isArray(statement)
    ? statement.map((s) => String(s == null ? '' : s)).join('\n')
    : String(statement == null ? '' : statement);
  return raw
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
 * 只做**保守**估计：解析不到就返回 null，交给调用方的默认值与 `source` 标注
 * （宁可用少了并说清是自己编的，也别用多了还说是题面的）。
 * @returns {{ maxSum: number|null, maxN: number|null, maxV: number|null, notes: string[] }}
 */
function scanStatement(statement) {
  const text = flattenStatement(statement);
  const notes = [];
  let maxSum = null;
  let maxN = null;
  let maxV = null;

  // ① 总额保证："sum of n over all test cases does not exceed 2*10^5"
  const sumRe = new RegExp(
    'sum of (?:all )?(?:the )?(n|q|m|k|len|length|values)[^.]{0,120}?(?:does not exceed|not exceed|<=|at most|不超过)\\s*' + NUM_TOKEN,
    'i'
  );
  const sumM = text.match(sumRe);
  if (sumM) {
    maxSum = parseNumExpr(sumM[2]);
    if (maxSum) notes.push('总额保证：sum of ' + sumM[1] + ' ≤ ' + maxSum);
  }

  // ② 变量 n 的上界："n (2 <= n <= 2*10^5)" / "n <= 10^5"
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
    maxN = maxSum;
    notes.push('最大规模按总额上限取 ' + maxSum);
  }

  // ②b 有些题没有 n：规模变量是测试组数 t
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

  // ③ 值域上限："0 <= a_i < 2^18" / "1 <= a_i <= 10^9"
  const valBounds = [];
  const valRe = new RegExp('(?:<=|<)\\s*' + NUM_TOKEN, 'gi');
  const valWindow = text.match(/a_i[^.]{0,80}/gi) || [];
  for (const w of valWindow) {
    valRe.lastIndex = 0;
    let vm;
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

/** 1e9 → "1e9"、200000 → "2e5"、5000 → "5000"（只用于给人看的文案） */
function fmtNum(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return String(n);
  // 只对 ≥1e5 用科学计数（1e9 / 2e5 这种）；5000 这种继续写全数字，人读着更实在
  for (let e = 9; e >= 5; e--) {
    const p = Math.pow(10, e);
    if (v >= p && v % p === 0) {
      const m = v / p;
      if (m <= 9.99) return (Number.isInteger(m) ? m : m.toFixed(1)) + 'e' + e;
    }
  }
  return String(v);
}

const DEFAULT_MAX_SCALE = 200000;
/** 值域解析不出来时的兜底：与 CF-AC 尺子 `ablation/lib/ruler.js` 的 DEFAULT_MAX_VALUE 一致 */
const DEFAULT_MAX_VALUE = 1000000000;

/**
 * 把题面 + 覆盖值解析成"闸要用哪一组最坏输入"。优先级：override > 题面 > 兜底。
 * @param {{statement?:any, cfProblem?:any, overrideN?:number, overrideV?:number, maxN?:number, maxV?:number}} o
 *        overrideN/overrideV = **显式**指定（env `CFCOACH_PERF_GATE_MAXN`/`_MAXV`；夹具与 A/B 用，不设即不覆盖）
 *        maxN/maxV           = 解析不到时的兜底（不传则用 DEFAULT_MAX_SCALE / DEFAULT_MAX_VALUE）
 * @returns {{maxN:number, maxV:number, source:'override'|'parsed'|'partial'|'default', nSource:string, vSource:string, notes:string[]}}
 */
function resolveGateScale(o) {
  const opt = o || {};
  const cf = opt.cfProblem || {};
  const stmt = (opt.statement != null && String(opt.statement).trim() !== '')
    ? opt.statement
    : (cf.statement != null ? cf.statement : '');
  // 覆盖（override）是**显式**要求，优先于题面：夹具与 A/B 必须能钉死规模，
  // 否则"同一个实验跑两次规模不同"会让对照失去意义。生产路径不设这些值。
  const ovN = Number(opt.overrideN) > 0 ? Math.floor(Number(opt.overrideN)) : null;
  const ovV = Number(opt.overrideV) > 0 ? Math.floor(Number(opt.overrideV)) : null;
  const fallbackN = Number(opt.maxN) > 0 ? Math.floor(Number(opt.maxN)) : DEFAULT_MAX_SCALE;
  const fallbackV = Number(opt.maxV) > 0 ? Math.floor(Number(opt.maxV)) : DEFAULT_MAX_VALUE;
  const scanned = scanStatement(stmt);
  const fromStmtN = scanned.maxN != null ? scanned.maxN : null;
  // 值域解析不出来时用兜底（1e9，和尺子同一个数）—— 闸里只跑题解，
  // "为了让暴力解跑得动而压小数值"的约定在这里不适用，所以不给 200 这种弱上限。
  const fromStmtV = scanned.maxV != null ? scanned.maxV : null;
  const maxN = ovN != null ? ovN : (fromStmtN != null ? fromStmtN : fallbackN);
  const maxV = ovV != null ? ovV : (fromStmtV != null ? fromStmtV : fallbackV);
  const nSource = ovN != null ? 'override' : (fromStmtN != null ? 'parsed' : 'default');
  const vSource = ovV != null ? 'override' : (fromStmtV != null ? 'parsed' : 'default');
  // 只要有一边是显式覆盖，整档就标成 override（文案要说"是谁指定的"，不能拿它冒充题面上限）
  const source = (ovN != null || ovV != null) ? 'override'
    : ((fromStmtN != null && fromStmtV != null) ? 'parsed'
      : ((fromStmtN != null || fromStmtV != null) ? 'partial' : 'default'));
  return {
    maxN,
    maxV,
    source,
    nSource,
    vSource,
    notes: scanned.notes
  };
}

/**
 * 性能闸的统一口径文案。**不许在别处另写**"按题面上限"这种话：
 * 只有 source === 'parsed' 才配说"题面解析出的上限"，其它情况必须说清是我们自己编的档。
 */
function scaleLabel(scale) {
  const s = scale || {};
  const n = fmtNum(s.maxN);
  const v = fmtNum(s.maxV);
  if (s.source === 'override') {
    return '按 A/B 指定的最大档（n≈' + n + (s.nSource === 'override' ? '（指定）' : '（自造）')
      + '、值≤' + v + (s.vSource === 'override' ? '（指定）' : '（自造）') + '）';
  }
  if (s.source === 'parsed') return '按题面解析出的上限（n≈' + n + '、值≤' + v + '）';
  if (s.source === 'partial') {
    return '按题面解析出的部分上限 + 兜底（n≈' + n + (s.nSource === 'parsed' ? '（题面）' : '（自造）')
      + '、值≤' + v + (s.vSource === 'parsed' ? '（题面）' : '（自造）') + '）';
  }
  return '自造最大档（n≈' + n + '、值≤' + v + '；题面里没解析出上限）';
}

module.exports = {
  parseNumExpr,
  flattenStatement,
  scanStatement,
  resolveGateScale,
  scaleLabel,
  fmtNum,
  DEFAULT_MAX_SCALE,
  DEFAULT_MAX_VALUE
};
