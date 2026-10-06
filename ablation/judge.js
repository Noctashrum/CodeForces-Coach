#!/usr/bin/env node
/**
 * 判分：样例 + 外部 oracle 差分测试。
 *
 * 判分口径（这是整套消融能不能站住的地方）：
 *  第一关 · 官方样例：题目自带的样例输入/输出，跑过才算"至少对样例正确"。
 *  第二关 · 差分对拍：用**外部 AC 提交**当标尺（problems.json 的 oracle.file），
 *          配一个随机数据生成器（gen.file），在小数据上跑几百组比对。
 *  第三关（可选，人工）：抽若干题人工读代码，看是不是"真解"而不是"骗样例"。
 *
 * ⛔ 纪律：oracle **绝不能**是 cf-coach（L2）自己产出的题解/暴力解。
 *    那样等于用"被测对象的标准答案"评判被测对象 —— 自证，评审一眼就能否掉。
 *    oracle 只能来自：CF 上真实 AC 的提交、题解博客的代码、或你自己手写并验证过的实现。
 *
 * 用法：
 *   node ablation/judge.js --out ablation/out/20250101-120000
 *   node ablation/judge.js --out … --iterations 200 --limit 3
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const problemsLib = require('./lib/problems');
const compareLib = require('./lib/compare');
const mkgen = require('./lib/mkgen');
const runner = require('../lib/runner');
const { compare } = compareLib;

function readRecords(outDir) {
  const file = path.join(outDir, 'records.jsonl');
  if (!fs.existsSync(file)) throw new Error('找不到记录：' + file);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readPart(part, fallbackLang) {
  if (!part || !part.file) return null;
  if (!fs.existsSync(part.file)) return null;
  return { lang: part.lang || fallbackLang || 'cpp', code: fs.readFileSync(part.file, 'utf8') };
}

/**
 * oracle 先验（判分前必过的一关）：拿官方样例跑这把"尺子"，**并比对样例输出**。
 *
 * 为什么必须有：差分对拍是拿 oracle 当标尺，尺子本身错了，候选的**正确**解答会被判成 WA。
 * 实证（用户 m08171 的 pilot）：2268A 的 oracle 只打印 (1<<(n-k+1)) + 2*(k-1)、完全不读数组，
 * 连自己的 4 组官方样例都过不了（期望 9/3/1/19，它给 10/8/2/20）；判分器照样拿它当标尺，
 * 把 L0 与 L2 两侧（用按题面独立写的暴力解验过：400+120 组全对）都判成"差分 WA"。
 *
 * @returns {Promise<{status:'ok'|'no-oracle'|'unverified'|'oracle-broken'|'special-judge', detail:?string, special:boolean, sampleMismatch:?object}>}
 */
async function oracleGate(problem) {
  const out = { status: 'ok', detail: null, special: !!(problem && mkgen.looksSpecialJudge(problem.statement)), sampleMismatch: null };
  const samples = ((problem && problem.samples) || []).filter((s) => s && String(s.input || '').trim() && String(s.output || '').trim());
  const oracle = readPart(problem && problem.oracle, 'cpp');
  if (!oracle) { out.status = 'no-oracle'; return out; }
  if (!samples.length) {
    out.status = 'unverified';
    out.detail = '这把 oracle 没有可比对的官方样例，没法先验它是不是正解：下面的差分结论只能当"相对这把尺子"看';
    return out;
  }
  const r = await runner.runSamples({
    lang: oracle.lang,
    code: oracle.code,
    samples: samples.map((s) => ({ input: s.input, output: s.output })),
    timeLimitMs: runner.RUN_TIMEOUT_MS
  });
  if (!r.ok) { out.status = 'oracle-broken'; out.detail = 'oracle 自己跑不起来（和候选无关）：' + String(r.error || '').slice(0, 200); return out; }
  const bad = (r.results || []).filter((x) => x.verdict !== 'AC');
  if (!bad.length) return out;
  const b = bad[0];
  const idx = (b.index || 1) - 1;
  const got = String(b.actual == null ? '' : b.actual).trim().slice(0, 120);
  const want = String((samples[idx] || {}).output || '').trim().slice(0, 120);
  /* 尺子自己过不了官方样例 —— 这是**独立于候选**的事实，无论这题是不是多解题都要留证：
   * 多解题的豁免（special-judge）说的是"样例不能当判错依据"，不是"尺子没问题"。
   * 2268F 的 oracle 就是另一道题的代码（给 3/4/2、样例期望 7 行），如果只留 special-judge，
   * 这条"贴错题"就永远查不出来了。 */
  out.sampleMismatch = { index: b.index || 1, got: got, want: want };
  if (out.special) {
    out.status = 'special-judge';
    out.detail = '这题是多解题（题面允许输出任意合法答案）：样例第 ' + (b.index || 1) + ' 组它给「' + got
      + '」、样例是「' + want + '」，两者都可能是对的 → 样例关不作为判错依据（要判得靠 checker）';
    return out;
  }
  out.status = 'oracle-broken';
  out.detail = '**这把 oracle 过不了自己的官方样例**（第 ' + (b.index || 1) + ' 组：样例期望「' + want + '」、它给「'
    + got + '」）→ 它多半不是这道题的正解（贴错题了 / 贴成别的题的解了）。本轮不拿它判候选：错的尺子会把正确解答判成 WA';
  return out;
}

/**
 * 这条记录交上来的，到底是不是"它自己为这道题给出的解"？
 *
 * 题解 Agent 交不出代码时，链会**降级交付自己的暴力解**（`verification.degraded === 'brute'` /
 * `verificationStatus === 'degraded-brute'`）。那份代码是正确但很慢的暴力解：官方样例能过、
 * 小数据对拍也能过 —— 判分器于是给它 AC，能力表上就成了"这一档做出来了"，而事实是
 * "这一档一个字都没交出来，交的是它的暴力解"。
 *
 * 实测（2026-10-06）：`L2|2268C`、`L2|2268D` 两格都是这么被记成 AC 的，L2 的 AC 数因此虚高。
 * 所以：样例/差分照旧判（那是"交付的代码对不对"的事实，有价值），但单独打标记，
 * 由 `compare.acOf` 决定"这不算这档解出来了"。
 */
function deliveredBrute(rec) {
  if (!rec) return false;
  const v = rec.verification || {};
  const degraded = v.degraded ? String(v.degraded) : (rec.verificationStatus === 'degraded-brute' ? 'brute' : null);
  if (degraded !== 'brute') return false;
  // 链自己声明交付的是"模型第一版"（delivered === 'model-first'）→ 是它自己的解，不算降级
  return rec.delivered !== 'model-first';
}

/**
 * 按档位汇总判分结果 —— 抽成函数是为了自测能直接喂数据。
 *
 * 命门是 `diffAC` 与 `diffACstrict` 必须同时给：标题行里那个"差分通过 6(75%)"**含了降级交付的暴力解**
 * （题解 Agent 没交出代码、链把暴力解交上来，暴力解当然能过对拍），单看百分数会被读成能力。
 * 严格数剔掉降级交付的格子，才是"这一档自己解出来的"。
 */
function summarizeByLevel(verdicts) {
  const byLevel = {};
  for (const v of verdicts) {
    const g = byLevel[v.level] = byLevel[v.level] || { total: 0, sampleAC: 0, diffAC: 0, diffACstrict: 0, both: 0, noCode: 0, noOracle: 0, noGen: 0, asserted: 0, falseConfidence: 0, oracleBroken: 0, specialJudge: 0, oracleSampleMismatch: 0, deliveredBrute: 0 };
    g.total++;
    if (v.sampleVerdict === 'AC') g.sampleAC++;
    if (v.diffVerdict === 'AC') g.diffAC++;
    if (v.diffVerdict === 'AC' && !v.deliveredBrute) g.diffACstrict++;
    if (v.diffVerdict === 'AC' && (v.sampleVerdict === 'AC' || v.sampleVerdict === 'skipped')) g.both++;
    if (v.sampleVerdict === 'no-code') g.noCode++;
    if (v.diffVerdict === 'no-oracle') g.noOracle++;
    if (v.diffVerdict === 'no-gen') g.noGen++;
    if (v.oracleBroken) g.oracleBroken++;
    if (v.specialJudge) g.specialJudge++;
    if (v.oracleSampleMismatch) g.oracleSampleMismatch++;
    if (v.assertedVerified === true) g.asserted++;
    if (v.falseConfidence) g.falseConfidence++;
    if (v.deliveredBrute) g.deliveredBrute++;
  }
  return byLevel;
}

async function judgeRecord(rec, problem, opts) {
  const o = opts || {};
  const out = { level: rec.level, problem: rec.problem, model: rec.model, codeSource: rec.codeSource || null,
    sampleVerdict: 'skipped', diffVerdict: 'skipped', detail: null,
    // 链自己有没有声称"已验证"（只有 L2 有这个概念）→ 用来算假自信率
    assertedVerified: rec.level === 'L2' ? rec.assertedVerified === true : null,
    scopeComplete: rec.level === 'L2' ? rec.scopeComplete === true : null,
    // 降级交付的暴力解（见 deliveredBrute 的注释）：代码能过样例/对拍，但**不是这一档给出的解**
    deliveredBrute: deliveredBrute(rec) };
  if (!rec.code) { out.sampleVerdict = 'no-code'; out.diffVerdict = 'no-code'; out.detail = rec.error || '没有代码'; return out; }
  if (!problem) { out.detail = '题库里没有这道题的记录'; out.sampleVerdict = 'unknown'; out.diffVerdict = 'unknown'; return out; }

  // 先验尺子：尺子不可信时，差分结论一律不许算到候选头上
  const gate = o.gate !== undefined ? o.gate : await oracleGate(problem);
  if (gate) {
    if (gate.status === 'oracle-broken') out.oracleBroken = true;
    if (gate.status === 'special-judge') out.specialJudge = true;
    // 尺子**过了**样例、但题面判定是"输出任意合法答案"：字面比对同样不能当判错依据。
    // 这里曾漏掉 —— 于是"oracle 正确 + 多解题"（最常见的那种组合）反而按严格字面比对判，
    // 把合法答案判成 WA（2268F 的构造答案就是这么被误判的）。
    if (gate.status === 'ok' && gate.special) { out.specialJudge = true; out.specialJudgeFromText = true; }
    if (gate.status === 'unverified') out.oracleUnverified = true;
    // 尺子自己过不了样例：多解题豁免不代表尺子没问题（可能贴错题）→ 单独留证
    if (gate.sampleMismatch) out.oracleSampleMismatch = true;
  }

  if (problem.samples && problem.samples.length) {
    const r = await runner.runSamples({
      lang: rec.codeLang || 'cpp',
      code: rec.code,
      samples: problem.samples.map((s) => ({ input: s.input, output: s.output })),
      timeLimitMs: runner.RUN_TIMEOUT_MS
    });
    if (!r.ok) { out.sampleVerdict = 'run-error'; out.detail = r.error; }
    else {
      const bad = (r.results || []).filter((x) => x.verdict !== 'AC');
      out.sampleVerdict = bad.length ? 'WA' : 'AC';
      if (bad.length) out.detail = '样例失败（第 ' + (bad[0].index || 1) + ' 组）：' + bad[0].verdict
        + (bad[0].actual != null ? '（实际输出 ' + String(bad[0].actual).slice(0, 200) + '）' : '');
      // 多解题：样例对不上 ≠ 错（题面允许任意合法答案），不能记成 WA
      if (bad.length && out.specialJudge) {
        const idxS = (bad[0].index || 1) - 1;
        const gotS = String(bad[0].actual == null ? '' : bad[0].actual).trim().slice(0, 120);
        const wantS = String((problem.samples[idxS] || {}).output || '').trim().slice(0, 120);
        out.sampleVerdict = 'special-judge';
        let base = (gate && gate.detail) || ('这题是多解题（题面允许输出任意合法答案）：样例第 ' + (bad[0].index || 1)
          + ' 组它给「' + gotS + '」、样例是「' + wantS + '」，两者都可能是对的 → 样例关不作为判错依据（要判得靠 checker）');
        // 多解豁免只说明"样例不能当判错依据"，**不说明尺子没问题**：这里再点一句，别让贴错题混过去
        if (gate && gate.status === 'special-judge' && gate.sampleMismatch) {
          base += '；⚠️ 另外：这把 oracle **自己也过不了官方样例**（第 ' + gate.sampleMismatch.index + ' 组：样例「'
            + gate.sampleMismatch.want + '」、它给「' + gate.sampleMismatch.got + '」）→ 如果这题其实不多解，那就是贴错题了，'
            + '建议核对 oracle';
        }
        out.detail = base;
      }
    }
  }

  const oracle = readPart(problem.oracle, 'cpp');
  const gen = readPart(problem.gen, 'cpp');
  if (out.oracleBroken) {
    // 尺子自己过不了官方样例：差分结论作废（不是候选的错）
    out.diffVerdict = 'oracle-broken';
    out.detail = gate.detail;
  } else if (oracle && gen) {
    const r = await runner.stressTest({
      solution: { lang: rec.codeLang || 'cpp', code: rec.code },
      brute: oracle,
      gen,
      iterations: o.iterations,
      timeLimitMs: runner.RUN_TIMEOUT_MS,
      maxTotalMs: o.maxTotalMs
    });
    if (!r.ok) { out.diffVerdict = 'run-error'; out.detail = r.error; }
    else if (r.status === 'ok') out.diffVerdict = 'AC';
    else if (r.status === 'mismatch') {
      out.diffVerdict = 'WA';
      out.detail = out.detail || ('差分第 ' + r.iteration + ' 组不一致');
      out.counterExample = { input: r.input, expected: r.expected, actual: r.actual };
      // 多解题 + 没有 checker：两边都可能是对的 → 标成"不可判"，别冒充候选错
      if (out.specialJudge) {
        out.diffUnreliable = true;
        out.detail = '差分第 ' + r.iteration + ' 组不一致，但这题是多解题且没有 checker：两边都可能是对的 → 这一格不可判（'
          + (gate && gate.detail ? gate.detail : '题面允许输出任意合法答案') + '）';
      }
    } else { out.diffVerdict = 'run-error'; out.detail = out.detail || (r.which + '：' + r.detail); }
  } else if (oracle) {
    // 有 oracle、没有生成器：差分跑不了，但缺的**不是** oracle（测试台点「自动写生成器」就能补）
    out.diffVerdict = 'no-gen';
    out.detail = out.detail || '有 oracle 但没有数据生成器：差分对拍跑不了（先在测试台点「自动写生成器」/「补生成器」再判分）';
    if (out.oracleUnverified && gate) out.detail = (gate.detail || '') + '；' + out.detail;
  } else {
    out.diffVerdict = 'no-oracle';
    out.detail = out.detail || '没有 oracle：差分对拍跑不了（oracle 必须是外部提供的 AC 代码，不能是 cf-coach 自己的产出）';
  }
  // 假自信：链说"已验证"、外部 oracle 却判它错 —— 只在**尺子可信**的 WA 上算
  if (out.assertedVerified && out.diffVerdict === 'WA' && !out.specialJudge && !out.oracleBroken) out.falseConfidence = true;
  return out;
}

async function main() {
  const args = env.parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args.out) {
    console.log('用法：node ablation/judge.js --out <跑分目录> [--iterations 200] [--problems-file …] [--limit N]');
    return;
  }
  await judgeAll({ outDir: String(args.out), args }, { log: (...a) => console.log(...a) });
}

/**
 * 判分一批记录（CLI 与人工测试台共用）：
 * 跑样例 + oracle 差分 → 写 verdicts.jsonl → 按档统计 → 读 human.jsonl（若有）做配对比较 → 写 compare.json。
 * @param {{outDir:string, problems?:Array, records?:Array, problemsFile?:string, iterations?:number,
 *          maxTotalMs?:number, limit?:number, human?:Array, args?:object}} opts
 *         problems/records 可由调用方直接给（UI 内存里的题与记录），否则从磁盘读。
 * @param {{log?:Function, onVerdict?:Function}} hooks  log 缺省静默；onVerdict(v, i, total) 用于流式进度。
 */
async function judgeAll(opts, hooks) {
  const o = opts || {};
  const h = hooks || {};
  const log = h.log || (() => {});
  const args = o.args || {};
  const outDir = path.resolve(String(o.outDir));
  let problems = o.problems;
  if (!problems) {
    const largs = Object.assign({}, args, { problems: 'all', limit: 0 });
    if (o.problemsFile) largs.problemsFile = o.problemsFile;
    problems = problemsLib.loadProblems(largs).all;
  }
  const byId = new Map(problems.map((p) => [p.id, p]));
  const iterations = o.iterations != null ? Number(o.iterations) : env.num(args.iterations, 200);
  const maxTotalMs = o.maxTotalMs != null ? Number(o.maxTotalMs) : env.num(args.maxTotalMs, 180000);
  const limit = o.limit != null ? Number(o.limit) : env.num(args.limit, 0);

  let records = o.records || readRecords(outDir);
  if (limit > 0) records = records.slice(0, limit);
  log('=== 判分 ===');
  log('记录：' + path.join(outDir, 'records.jsonl') + '（' + records.length + ' 条）');
  log('差分：每题最多 ' + iterations + ' 组随机数据（oracle 来自题库，不是 L2 产出的）\n');

  const verdicts = [];
  // 尺子先验：每题只体检一次（跑官方样例 + 比对输出），结论复用到这一题的所有记录上
  const gates = new Map();
  const gateFor = async (id) => {
    if (!gates.has(id)) gates.set(id, await oracleGate(byId.get(id)));
    return gates.get(id);
  };
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const problem = byId.get(rec.problem);
    let gate = null;
    if (problem) {
      const first = !gates.has(rec.problem);
      gate = await gateFor(rec.problem);
      if (first) {
        log('  尺子先验 ' + rec.problem + '：' + gate.status + (gate.detail ? '  ' + gate.detail : '')
          + (gate.special ? '（题面判为多解题）' : ''));
      }
    }
    const v = await judgeRecord(rec, problem, { iterations, maxTotalMs, gate });
    verdicts.push(v);
    log([v.level, v.problem, (v.model || '')].join(' ') + ' → 样例 ' + v.sampleVerdict + '｜差分 ' + v.diffVerdict
      + (v.deliveredBrute ? '｜⚠️降级交付的暴力解（不是这一档给出的解）' : '')
      + (v.oracleBroken ? '｜⛔尺子不可信' : '') + (v.specialJudge ? '｜多解题' : '')
      + (v.oracleSampleMismatch && !v.oracleBroken ? '｜⚠️尺子样例不符' : '')
      + (v.assertedVerified != null ? '｜链声称已验证 ' + (v.assertedVerified ? '是' : '否') : '')
      + (v.falseConfidence ? '  ⚠️假自信' : '') + (v.detail ? '  ' + v.detail : ''));
    if (h.onVerdict) h.onVerdict(v, i, records.length);
  }
  const vfile = path.join(outDir, 'verdicts.jsonl');
  fs.writeFileSync(vfile, verdicts.map((v) => JSON.stringify(v)).join('\n') + (verdicts.length ? '\n' : ''), 'utf8');

  const byLevel = summarizeByLevel(verdicts);
  log('\n=== 结果（按档位）===');
  for (const [lv, g] of Object.entries(byLevel)) {
    const pct = (n) => g.total ? Math.round((n / g.total) * 100) + '%' : '—';
    log(lv.padEnd(3) + ' n=' + g.total + '  样例通过 ' + g.sampleAC + '(' + pct(g.sampleAC) + ')'
      + '  差分通过 ' + g.diffAC + '(' + pct(g.diffAC) + ')'
      + (g.deliveredBrute ? '  严格 ' + g.diffACstrict + '(' + pct(g.diffACstrict) + ')（剔掉降级交付的暴力解）' : '')
      + '  无代码 ' + g.noCode + '  无 oracle ' + g.noOracle + '  缺生成器 ' + g.noGen
      + (g.deliveredBrute ? '  ⚠️降级交付暴力解 ' + g.deliveredBrute + '（**不算解出来了**，见下）' : '')
      + (g.oracleBroken ? '  ⛔尺子不可信 ' + g.oracleBroken : '') + (g.specialJudge ? '  多解题 ' + g.specialJudge : '')
      + (g.oracleSampleMismatch && !g.oracleBroken ? '  ⚠️尺子样例不符 ' + g.oracleSampleMismatch + '（多解的另一种合法答案、或贴错题 —— 请人工核对 oracle）' : '')
      + (g.asserted ? '  声称已验证 ' + g.asserted + '（其中假自信 ' + g.falseConfidence + '）' : ''));
  }
  const anyDeliveredBrute = Object.values(byLevel).reduce((n, g) => n + g.deliveredBrute, 0);
  if (anyDeliveredBrute) {
    log('⚠️ 有 ' + anyDeliveredBrute + ' 格是**降级交付的暴力解**：题解 Agent 没交出代码，链把同一轮生成的暴力解交了上来。');
    log('   它的样例/对拍结论只说明"这份暴力解是对的"，**不说明这一档解出了这道题**。');
    log('   这个口径落在三处：标题行的「严格」数、rating 阶梯（该格单列成「⚠ 交的是暴力解」、不进"会做 ≤ rX"）、');
    log('   题卡徽章（`⚠ 交的是暴力解（不算 AC）`）；配对比较里也按"未交付"处理（不计 AC）。');
  }

  // ---- 配对比较：对标 L0（用户口径：合格线 = 不差于 L0）----
  let human = o.human;
  if (!human) {
    human = [];
    const hfile = path.join(outDir, 'human.jsonl');
    if (fs.existsSync(hfile)) {
      human = fs.readFileSync(hfile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  }
  const levels = [...new Set(verdicts.map((v) => v.level))].sort();
  if (!levels.length) {
    log('\n（没有可判分的记录：先跑 node ablation/run.js 生成 records.jsonl）');
    return { outDir, records, verdicts, byLevel, cmp: null, human, vfile, cfile: null, iterations };
  }
  const base = levels.indexOf('L0') >= 0 ? 'L0' : levels[0];
  const cand = levels.indexOf('L2') >= 0 ? 'L2' : levels[levels.length - 1];
  const cmp = compare(records, verdicts, { base, cand, human });
  const cfile = path.join(outDir, 'compare.json');
  fs.writeFileSync(cfile, JSON.stringify(cmp, null, 2), 'utf8');
  log('\n=== 配对比较：' + cand + ' vs ' + base + '（合格线 = 不差于 ' + base + '）===');
  if (!cmp.n) {
    log('（没有跑齐两档的题：对同一批题同时跑 ' + base + ' 与 ' + cand + ' 才有配对结论）');
  } else {
    const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
    log('配对 ' + cmp.n + ' 题（可判 ' + cmp.decidable + '）：' + cand + ' 更好 ' + cmp.win + '，打平 ' + cmp.tie + '，' + base + ' 更好 ' + cmp.loss
      + '  →  **不差于 ' + base + ' 的比例 ' + pct(cmp.notWorseRate) + '**（' + cmp.notWorse + '/' + cmp.decidable + '）');
    if (cmp.undecidable && cmp.undecidable.count) {
      log('⚠️ 判不了 ' + cmp.undecidable.count + ' 题（没有算进胜平负）：'
        + cmp.undecidable.items.map((x) => x.problem + '（' + x.why + '）').join('、'));
    }
    if (cmp.deliveredBrute && cmp.deliveredBrute.count) {
      log('⚠️ ' + cand + ' 有 ' + cmp.deliveredBrute.count + ' 题交的是**降级交付的暴力解**（没交出自己的题解）→ 已按"未交付"记，不计 AC：'
        + cmp.deliveredBrute.problems.join('、'));
    }
    log('不一致格子：' + cand + ' 更好 ' + cmp.discordant.candBetter + ' / ' + base + ' 更好 ' + cmp.discordant.baseBetter
      + '  → McNemar 精确检验双侧 p = ' + cmp.p.toFixed(3)
      + (cmp.discordant.candBetter + cmp.discordant.baseBetter < 6 ? '（格子太少，p 没有判别力：这只是"没发现差异"，不是"证明相等"）' : ''));
    log('成本：' + Object.entries(cmp.byLevel).map(([lv, g]) => lv + ' 平均 ' + g.avgTokens + ' tok'
      + (g.avgCost != null ? '/¥' + g.avgCost : '') + '（n=' + g.runs + '）').join('；'));
    if (cmp.falseConfidence.asserted) {
      log('假自信率：' + cand + ' 声称已验证 ' + cmp.falseConfidence.asserted + ' 次，其中被外部 oracle 判错 '
        + cmp.falseConfidence.assertedWrong + ' 次（' + pct(cmp.falseConfidence.rate) + '）');
    }
    if (cmp.quality.total) {
      log('人工判定（讲解质量）：' + cand + ' 更好 ' + cmp.quality.coach + '，打平 ' + cmp.quality.tie + '，' + base + ' 更好 ' + cmp.quality.l0 + '（共 ' + cmp.quality.total + '）');
    }
  }
  log('\n判据：差分通过 = 与外部 AC 标准在 ' + iterations + ' 组随机数据上完全一致。');
  log('统计建议：同一批题跑齐 L0/L1/L2 后做配对比较（每题只有 对/错 两种结果 → 符号检验/McNemar），');
  log('        并同时报告每档的 tokens 与花费（"提升 30 个百分点"要配上"多花多少 token"才有意义）。');
  log('明细：' + vfile + '\n配对：' + cfile);
  return { outDir, records, verdicts, byLevel, cmp, human, vfile, cfile, iterations };
}

module.exports = { judgeRecord, readRecords, judgeAll, oracleGate, deliveredBrute, summarizeByLevel };

if (require.main === module) {
  main().catch((e) => { console.error('判分失败：' + ((e && e.stack) || e)); process.exit(1); });
}

