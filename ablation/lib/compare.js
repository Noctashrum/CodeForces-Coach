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
 * 没有 oracle 只有官方样例的题，只能算"样例级通过"，单独计数、不与差分 AC 混为一谈。
 */
'use strict';

/** 记录/判分明细的配对键 */
function pairKey(x) {
  return String(x.problem) + '|' + String(x.model || '');
}

/** 判分明细 → 正确性（含证据强度） */
function acOf(v) {
  if (!v) return { ac: false, strength: 'none' };
  if (v.diffVerdict === 'AC') return { ac: true, strength: 'diff' };
  if (v.diffVerdict === 'no-oracle' && v.sampleVerdict === 'AC') return { ac: true, strength: 'samples' };
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
      baseMs: rb.ms || 0, candMs: rc.ms || 0,
      baseTokens: ((rb.usage && rb.usage.promptTokens) || 0) + ((rb.usage && rb.usage.completionTokens) || 0),
      candTokens: ((rc.usage && rc.usage.promptTokens) || 0) + ((rc.usage && rc.usage.completionTokens) || 0),
      baseCost: rb.cost && typeof rb.cost.amount === 'number' ? rb.cost.amount : null,
      candCost: rc.cost && typeof rc.cost.amount === 'number' ? rc.cost.amount : null,
      candAsserted: rc.assertedVerified === true
    });
  }

  let win = 0; let tie = 0; let loss = 0; let b = 0; let c = 0;
  for (const p of pairs) {
    if (p.candAC && !p.baseAC) { win++; c++; }
    else if (!p.candAC && p.baseAC) { loss++; b++; }
    else tie++;
  }

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
  let asserted = 0; let assertedWrong = 0;
  for (const r of records || []) {
    if (!r || r.level !== cand) continue;
    if (r.assertedVerified !== true) continue;
    asserted++;
    const v = vByKey.get(cand + '|' + pairKey(r));
    if (!acOf(v).ac) assertedWrong++;
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
    notWorse: win + tie,
    notWorseRate: n ? (win + tie) / n : null,
    winRate: n ? win / n : null,
    lossRate: n ? loss / n : null,
    discordant: { baseBetter: b, candBetter: c },
    p: exactBinomialTwoSided(b, c),
    byLevel,
    falseConfidence: { asserted, assertedWrong, rate: asserted ? assertedWrong / asserted : null },
    quality,
    note: n ? '' : '没有跑齐两档的题（配对为空）：先对同一批题跑 ' + base + ' 与 ' + cand + '。'
  };
}

module.exports = { compare, acOf, pairKey, exactBinomialTwoSided };
