/**
 * 配对比较：消融实验的**结论就出在这里**。
 *
 * 用户的口径（2025，m03674 原话要点）："消融测试改成对标 L0，看看我们会不会做的'不如'基准，
 * 只要能相等说明项目至少还是有价值的（不至于帮倒忙）。"
 *
 * 所以这里不下"提升 X 个百分点"这种**非配对**结论，而是：
 *   ① 同一道题、同一个模型跑齐两档 → 逐题配对（只有 对/错 两种结果）
 *   ② 报 胜/平/负 与 **"不差于 L0" 的比例**（合格线 = 不差于基准）
 *   ③ 配对检验：不一致的格子够不够多（McNemar 精确二项检验，双侧 p）
 *      —— 只有 5 道题、格子全一边倒时 p 也会很大，这是**如实**，不是缺陷
 *   ④ 成本一起报（tokens / 花费 / 耗时），"打平"要配上"多花多少"才有意义
 *   ⑤ 假自信率：链**声称已验证**但被外部 oracle 判 WA 的比例（cf-coach 最有价值的指标之一）
 *
 * 判"对"的口径（写在输出里，评审要看）：差分对拍 AC 为准；
 * 差分跑不了（缺 oracle 或缺数据生成器）而只有官方样例的题，只能算"样例级通过"，
 * 单独计数、不与差分 AC 混为一谈。
 */
'use strict';

/** 记录/判分明细的配对键 */
function pairKey(x) {
  return String(x.problem) + '|' + String(x.model || '');
}

/** 判分明细 → 正确性（含证据强度）；`undecidable` 表示"这一格判不了"，绝不能冒充候选错 */
function acOf(v) {
  if (!v) return { ac: false, strength: 'none' };
  // 尺子自己过不了官方样例（oracle-broken）→ 判分器没资格说候选错
  if (v.diffVerdict === 'oracle-broken') return { ac: false, strength: 'none', undecidable: true, why: 'oracle-broken' };
  // 多解题 + 没有 checker：差分不一致时两边都可能是对的 → 不可判
  if (v.diffVerdict === 'WA' && v.specialJudge) return { ac: false, strength: 'none', undecidable: true, why: 'special-judge' };
  // 多解题 + 差分根本跑不起来（缺生成器/缺 oracle）：**样例关对多解题本来就不是判据**，
  // 所以这一格同样只能算"判不了"（2026-10-06，2268F：题面"不要求最小化" + 缺生成器 → 原来被算成打平）
  if (v.specialJudge && (v.diffVerdict === 'no-gen' || v.diffVerdict === 'no-oracle'
    || v.diffVerdict === 'run-error' || v.sampleVerdict === 'special-judge') && v.diffVerdict !== 'AC') {
    return { ac: false, strength: 'none', undecidable: true, why: 'special-judge（多解题且没有 checker）' };
  }
  if (v.diffVerdict === 'AC') return { ac: true, strength: 'diff' };
  // 差分跑不了（缺 oracle 或缺生成器）时只能看官方样例：单独标成 samples 级证据，绝不与差分 AC 混为一谈
  if ((v.diffVerdict === 'no-oracle' || v.diffVerdict === 'no-gen') && v.sampleVerdict === 'AC') {
    return { ac: true, strength: 'samples' };
  }
  return { ac: false, strength: 'none' };
}

/** 双侧精确二项检验（McNemar 的精确版）：b/c 是不一致的两个方向 */
function exactBinomialTwoSided(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let comb = 1;   // C(n,0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) comb = comb * (n - i + 1) / i;
    tail += comb;
  }
  const p = 2 * tail / Math.pow(2, n);
  return Math.min(1, p);
}

function money(x) {
  return x == null ? null : Math.round(x * 10000) / 10000;
}

/**
 * @param {Array} records records.jsonl
 * @param {Array} verdicts verdicts.jsonl（judge.js 输出）
 * @param {{base?:string, cand?:string, human?:Array}} opts
 */
function compare(records, verdicts, opts) {
  const o = opts || {};
  const base = o.base || 'L0';
  const cand = o.cand || 'L2';
  const vByKey = new Map();
  (verdicts || []).forEach((v) => {
    if (!v || !v.level) return;
    vByKey.set(v.level + '|' + pairKey(v), v);
  });
  const rByKey = new Map();
  (records || []).forEach((r) => {
    if (!r || !r.level) return;
    rByKey.set(r.level + '|' + pairKey(r), r);
  });

  const problems = [...new Set((records || []).map((r) => pairKey(r)))].sort();
  const pairs = [];
  for (const key of problems) {
    const rb = rByKey.get(base + '|' + key);
    const rc = rByKey.get(cand + '|' + key);
    if (!rb || !rc) continue;              // 没跑齐的题不进配对（如实排除，不做插补）
    const vb = vByKey.get(base + '|' + key);
    const vc = vByKey.get(cand + '|' + key);
    const ab = acOf(vb);
    const ac2 = acOf(vc);
    pairs.push({
      problem: (rb.problem || String(key).split('|')[0]), model: rb.model,
      baseAC: ab.ac, candAC: ac2.ac, baseStrength: ab.strength, candStrength: ac2.strength,
      baseUndecidable: ab.undecidable === true, candUndecidable: ac2.undecidable === true,
      undecidableWhy: ab.why || ac2.why || null,
      baseMs: rb.ms || 0, candMs: rc.ms || 0,
      baseTokens: ((rb.usage && rb.usage.promptTokens) || 0) + ((rb.usage && rb.usage.completionTokens) || 0),
      candTokens: ((rc.usage && rc.usage.promptTokens) || 0) + ((rc.usage && rc.usage.completionTokens) || 0),
      baseCost: rb.cost && typeof rb.cost.amount === 'number' ? rb.cost.amount : null,
      candCost: rc.cost && typeof rc.cost.amount === 'number' ? rc.cost.amount : null,
      candAsserted: rc.assertedVerified === true
    });
  }

  let win = 0; let tie = 0; let loss = 0; let b = 0; let c = 0;
  const undecidableItems = [];
  for (const p of pairs) {
    // 判不了的格子单独列，不塞进胜平负（否则就成了"用错尺子得出的打平"）
    if (p.baseUndecidable || p.candUndecidable) { undecidableItems.push({ problem: p.problem, model: p.model, why: p.undecidableWhy }); continue; }
    if (p.candAC && !p.baseAC) { win++; c++; }
    else if (!p.candAC && p.baseAC) { loss++; b++; }
    else tie++;
  }
  const decidable = win + tie + loss;

  const byLevel = {};
  for (const r of records || []) {
    if (!r || !r.level) continue;
    const g = byLevel[r.level] = byLevel[r.level] || { runs: 0, ok: 0, tokens: 0, cost: 0, ms: 0, priced: 0, unpriced: 0, failed: 0 };
    g.runs++;
    if (r.ok) g.ok++; else g.failed++;
    g.tokens += ((r.usage && r.usage.promptTokens) || 0) + ((r.usage && r.usage.completionTokens) || 0);
    g.ms += r.ms || 0;
    if (r.cost && typeof r.cost.amount === 'number') { g.cost += r.cost.amount; g.priced++; } else g.unpriced++;
  }
  Object.values(byLevel).forEach((g) => { g.avgTokens = g.runs ? Math.round(g.tokens / g.runs) : 0; g.avgCost = g.priced ? money(g.cost / g.priced) : null; });

  // 假自信率（只在候选档上算：基准档没有"已验证"这个概念）
  // 注意：不可判的格子不算"被外部判错"——那是尺子的问题，不是链吹牛
  let asserted = 0; let assertedWrong = 0;
  for (const r of records || []) {
    if (!r || r.level !== cand) continue;
    if (r.assertedVerified !== true) continue;
    asserted++;
    const v = vByKey.get(cand + '|' + pairKey(r));
    const av = acOf(v);
    if (!av.ac && !av.undecidable) assertedWrong++;
  }

  const human = o.human || [];
  // 人工判定（讲解质量轴）：同一题反复判只算最后一次 —— 人是在"改判"，不是在"投票"
  const hmap = new Map();
  human.forEach((h) => { if (h && h.problem) hmap.set(String(h.problem) + '|' + String(h.level || 'L2'), h); });
  const quality = { coach: 0, tie: 0, l0: 0, other: 0, total: 0, items: human };
  for (const h of hmap.values()) {
    const c = String(h.choice || '').toLowerCase();
    if (c === 'coach' || c === 'l2') quality.coach++;
    else if (c === 'tie') quality.tie++;
    else if (c === 'l0' || c === 'base') quality.l0++;
    else quality.other++;   // 两个都不行 / 都很好 / 其他：如实另记，不塞进胜平负
    quality.total++;
  }

  const n = pairs.length;
  return {
    base, cand, n,
    pairs,
    win, tie, loss,
    decidable,
    undecidable: { count: undecidableItems.length, items: undecidableItems },
    notWorse: win + tie,
    notWorseRate: decidable ? (win + tie) / decidable : null,
    winRate: decidable ? win / decidable : null,
    lossRate: decidable ? loss / decidable : null,
    discordant: { baseBetter: b, candBetter: c },
    p: exactBinomialTwoSided(b, c),
    byLevel,
    falseConfidence: { asserted, assertedWrong, rate: asserted ? assertedWrong / asserted : null },
    quality,
    note: n ? (undecidableItems.length ? '有 ' + undecidableItems.length + ' 对题判不了（尺子/checker 问题），没有算进胜平负：' + undecidableItems.map((x) => x.problem + '(' + x.why + ')').join('、') : '')
      : '没有跑齐两档的题（配对为空）：先对同一批题跑 ' + base + ' 与 ' + cand + '。'
  };
}

module.exports = { compare, acOf, pairKey, exactBinomialTwoSided };
