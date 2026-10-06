'use strict';
/**
 * rating 阶梯：把"跑过的题 × 档位"折成一句话 —— **这一档的 rating 上限在哪**。
 *
 * 这是用户要回答的问题（"裸模 rating 上限"）：同一档位从低 rating 往上排，
 * 看它在哪里开始做不出来。
 *
 * 规则**只在这一处实现**（服务端算好、界面只渲染）：读数规则很容易在第二份拷贝里
 * 悄悄走样，而走样的方向恰好都是"把上限报低了"。
 *
 * 读数纪律（改动前先读一遍，这四条是台子存在的意义）：
 *   ① AC 只给出**下界**：AC 证明它会做这道题，不证明它不会做更高的。
 *   ② 上限只能由**可信失败**给出：差分 WA / 样例 WA / 运行错。
 *   ③ **中止（单次调用超时）与撞长度上限不算答错** —— 那是"没跑完"。
 *      把没跑完当成不会做，会系统性低估上限（实测 r2300 的题单次思考 11–12 分钟，
 *      默认 12 分钟超时下"失败"里混着大量没跑完的）。
 *   ④ 尺子坏了（尺子与 oracle 对不上 / 没有 oracle）既不算 AC 也不算失败，记"不可判"。
 */

const KIND_TEXT = {
  ac: '✓ AC',
  fail: '✗ 差分 WA',
  unfinished: '中止/撞顶',
  nocode: '没交出来',
  degraded: '⚠ 交的是暴力解',
  unreliable: '不可判',
  noruler: '缺尺子',
  ran: '未判分',
  none: '未跑'
};

/**
 * 中止 = **不是因为"答错"而结束**：单次调用超时（lib/llm.js 的文案）、被取消、传输层中断。
 *
 * 传输层也算中止，是踩过的坑（2026-10-06，3500 分题 2268F）：L0 报 `terminated`、L0C 报 `fetch failed`
 * （都只跑了 10 秒、0 token、0 成本、一个字都没收到），当时的规则只认 `超时|abort`，于是这两条被记成
 * "没交出来"（= 这一档做不出来），而不是"这次没跑完"—— 记错方向的代价就是把整档上限报低。
 */
const ABORT_RE = /超时|abort|传输层|terminated|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/i;

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/**
 * 这条跑是"降级交付的暴力解"吗？—— 题解 Agent 交不出代码，链把同一轮的暴力解交了上来。
 *
 * 它**既不是 AC 也不是答错**：那份暴力解能过样例/对拍只证明"暴力解是对的"，
 * 完全不能证明这一档解出了这道题（判据见 `ablation/judge.js` 的 `deliveredBrute`）。
 * 阶梯里必须单独成一格 —— 否则"会做 ≤ r3500"这种话会被一份暴力解撑起来（实测踩过）。
 */
function isDegradedRun(r) {
  const v = (r && r.verification) || {};
  const d = v.degraded ? String(v.degraded) : (r && r.verificationStatus === 'degraded-brute' ? 'brute' : null);
  if (d !== 'brute') return false;
  return !(r && r.delivered === 'model-first');   // 交了模型自己的解就不算降级
}

/** 一条 run 的用量：记录里是 camelCase（lib/llm.js 归一化），兼容 snake_case。 */
function outTokens(u) {
  if (!u) return 0;
  const v = u.completionTokens != null ? u.completionTokens : u.completion_tokens;
  return num(v);
}
function costAmount(r) {
  return r && r.cost && typeof r.cost.amount === 'number' ? r.cost.amount : null;
}

/** 把 runs 按 (档位, 题) 归并。全部记录（含重复次数）都算进来。 */
function indexRuns(runs) {
  const map = new Map();
  for (const r of runs || []) {
    if (!r || !r.level || !r.problem) continue;
    const key = r.level + '\u0000' + r.problem;
    let s = map.get(key);
    if (!s) {
      s = {
        level: r.level, id: r.problem, n: 0, withCode: 0, degraded: 0,
        aborted: 0, truncated: 0, ok: 0, priced: 0, cost: 0, out: 0, ms: 0, reps: []
      };
      map.set(key, s);
    }
    s.n++;
    if (r.hasCode) s.withCode++;
    if (isDegradedRun(r)) s.degraded++;
    if (!r.ok && ABORT_RE.test(String(r.error || ''))) s.aborted++;
    if (r.truncated) s.truncated++;
    if (r.ok) s.ok++;
    const c = costAmount(r);
    if (c != null) { s.priced++; s.cost += c; }
    s.out += outTokens(r.usage);
    s.ms += num(r.ms);
    if (r.rep != null) s.reps.push(r.rep);
  }
  return map;
}

/** 一次失败可信吗？—— 至少有一次跑是"正常跑完"的，才算数。 */
function trusted(s) { return s && s.n > 0 && (s.aborted + s.truncated) < s.n; }

function classify(s, v) {
  if (!s || !s.n) return 'none';
  if (!v) return 'ran';
  // 降级交付的暴力解：**既不算 AC 也不算答错**，必须放在 AC 之前判 —— 它常常正是"差分 AC"。
  // 两路判据：判分结果里的 deliveredBrute（`14e0b80` 起有），或"这一格里所有有代码的跑都是降级交付"
  // （判分还是旧口径时的兜底；只要有一条真解就不算）。
  const byRuns = s.withCode > 0 && s.degraded === s.withCode;
  if (v.deliveredBrute || byRuns) return 'degraded';
  if (v.diffVerdict === 'AC') return 'ac';
  if (v.diffUnreliable) return 'unreliable';
  const dv = v.diffVerdict;
  if (dv === 'no-code') return (s.aborted || s.truncated) ? 'unfinished' : 'nocode';
  if (dv === 'WA' || dv === 'run-error') return trusted(s) ? 'fail' : 'unfinished';
  if (dv === 'no-oracle' || dv === 'no-gen') return 'noruler';
  return 'ran';
}

/**
 * @param {{problems:Array, runs:Array, verdicts:Array, levels?:string[]}} o
 * @returns 阶梯（界面直接渲染；诊断包也把它带上）
 */
function compute(o) {
  const problems = (o && o.problems) || [];
  const runs = (o && o.runs) || [];
  const verdicts = (o && o.verdicts) || [];
  const levels = (o && o.levels) && o.levels.length ? o.levels : ['L0', 'L0C', 'L1', 'L2'];

  const vmap = new Map();
  for (const v of verdicts) { if (v && v.level && v.problem) vmap.set(v.level + '\u0000' + v.problem, v); }
  const rmap = indexRuns(runs);

  const rows = problems
    .slice()
    .sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0) || String(a.id).localeCompare(String(b.id)))
    .map((p) => {
      const cells = {};
      const stats = { n: 0, out: 0, ms: 0, aborted: 0, truncated: 0, degraded: 0, priced: 0, cost: 0 };
      for (const lv of levels) {
        const s = rmap.get(lv + '\u0000' + p.id) || null;
        const v = vmap.get(lv + '\u0000' + p.id) || null;
        const kind = classify(s, v);
        cells[lv] = {
          kind, text: KIND_TEXT[kind] || kind,
          n: s ? s.n : 0, withCode: s ? s.withCode : 0, degraded: s ? s.degraded : 0,
          aborted: s ? s.aborted : 0, truncated: s ? s.truncated : 0,
          priced: s ? s.priced : 0, cost: s ? s.cost : 0, out: s ? s.out : 0, ms: s ? s.ms : 0,
          falseConfidence: !!(v && v.falseConfidence)
        };
        if (s) {
          stats.n += s.n; stats.out += s.out; stats.ms += s.ms; stats.aborted += s.aborted;
          stats.truncated += s.truncated; stats.degraded += s.degraded; stats.priced += s.priced; stats.cost += s.cost;
        }
      }
      return { id: p.id, title: p.title || '', rating: Number(p.rating) || 0, cells, stats };
    });

  const totals = { runs: 0, aborted: 0, truncated: 0, degraded: 0, priced: 0, unpriced: 0, cost: 0, out: 0 };
  const byLevel = levels.map((lv) => {
    const cells = rows.map((r) => Object.assign({ id: r.id, rating: r.rating }, r.cells[lv]));
    const t = { level: lv, n: 0, withCode: 0, degraded: 0, aborted: 0, truncated: 0, priced: 0, cost: 0, out: 0, ms: 0 };
    for (const s of rmap.values()) {
      if (s.level !== lv) continue;
      t.n += s.n; t.withCode += s.withCode; t.degraded += s.degraded; t.aborted += s.aborted; t.truncated += s.truncated;
      t.priced += s.priced; t.cost += s.cost; t.out += s.out; t.ms += s.ms;
      totals.runs += s.n; totals.aborted += s.aborted; totals.truncated += s.truncated; totals.degraded += s.degraded;
      totals.priced += s.priced; totals.cost += s.cost; totals.out += s.out;
      totals.unpriced += Math.max(0, s.n - s.priced);
    }
    // AC 只是下界：取最高的那道 AC 题
    const acs = cells.filter((c) => c.kind === 'ac' && c.rating > 0);
    const acMax = acs.length ? acs[acs.length - 1] : null;
    // 上限只能由可信失败给出：取 rating 最低的那道可信失败题
    const fails = cells.filter((c) => c.kind === 'fail' && c.rating > 0);
    const failMin = fails.length ? fails[0] : null;
    const unfinished = cells.filter((c) => c.kind === 'unfinished');
    const undecidable = cells.filter((c) => c.kind === 'unreliable' || c.kind === 'noruler');
    // 降级交付：题解 Agent 交不出代码，链把暴力解交了上来 —— 不能当 AC，也不能当"答错"（它不是能力证据）。
    // 但必须在结论里点名：否则读者看到"会做 ≤ rX"会以为那些更高的 rating 只是还没跑到。
    const degraded = cells.filter((c) => c.kind === 'degraded' && c.rating > 0);
    return {
      level: lv,
      hint: (o && o.levelHint && o.levelHint[lv]) || '',
      cells, stats: t, acMax, failMin,
      degraded: degraded.map((c) => ({ id: c.id, rating: c.rating })),
      counts: {
        ac: cells.filter((c) => c.kind === 'ac').length,
        fail: fails.length,
        unfinished: unfinished.length,
        undecidable: undecidable.length,
        degraded: cells.filter((c) => c.kind === 'degraded').length,
        nocode: cells.filter((c) => c.kind === 'nocode').length,
        none: cells.filter((c) => c.kind === 'none').length
      },
      // 一句话结论：给不出上限时要说清为什么（没跑 / 全是中止 / 没失败过）
      verdict: acMax
        ? ('会做 ≤ r' + acMax.rating + '（' + acMax.id + '）'
          + (failMin ? '；在 r' + failMin.rating + '（' + failMin.id + '）上失效' : '；更高 rating 上还没拿到可信失败')
          + (degraded.length ? '；r' + degraded.map((c) => c.rating + '（' + c.id + '）').join('、r')
            + ' 交的是**降级交付的暴力解**，不算会做也不算命里没有' : ''))
        : (t.n ? '还没有 AC（已跑 ' + t.n + ' 次）' : '还没跑')
          + (degraded.length ? '；r' + degraded.map((c) => c.rating + '（' + c.id + '）').join('、r') + ' 只交了降级交付的暴力解' : '')
    };
  });

  return {
    generatedAt: Date.now(),
    levels: byLevel,
    rows,
    totals,
    kinds: KIND_TEXT,
    note: 'AC 只是下界；上限只能由可信失败（差分 WA / 样例 WA / 运行错）给出。'
      + '中止（单次调用超时）与撞长度上限是"没跑完"，不算答错 —— 混进去会把上限报低。'
      + '**降级交付的暴力解**（题解 Agent 没交出自己的解，链把暴力解交了上来）既不算 AC 也不算答错：'
      + '它的 AC 只证明"那份暴力解是对的"，撑不起"这一档会做"。'
      + '同一 rating 至少 3 道题才谈"断崖"。',
    evidence: '同一 (题×档) 只跑一遍不足为证（实测同一题同一档有 1/3 概率交不出代码）：拿 3–6 次重复的通过率说话。'
  };
}

module.exports = { compute, classify, indexRuns, trusted, isDegradedRun, KIND_TEXT, ABORT_RE, outTokens, costAmount };
