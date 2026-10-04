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

async function judgeRecord(rec, problem, opts) {
  const out = { level: rec.level, problem: rec.problem, model: rec.model, codeSource: rec.codeSource || null,
    sampleVerdict: 'skipped', diffVerdict: 'skipped', detail: null,
    // 链自己有没有声称"已验证"（只有 L2 有这个概念）→ 用来算假自信率
    assertedVerified: rec.level === 'L2' ? rec.assertedVerified === true : null,
    scopeComplete: rec.level === 'L2' ? rec.scopeComplete === true : null };
  if (!rec.code) { out.sampleVerdict = 'no-code'; out.diffVerdict = 'no-code'; out.detail = rec.error || '没有代码'; return out; }
  if (!problem) { out.detail = '题库里没有这道题的记录'; out.sampleVerdict = 'unknown'; out.diffVerdict = 'unknown'; return out; }

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

    }
  }

  const oracle = readPart(problem.oracle, 'cpp');
  const gen = readPart(problem.gen, 'cpp');
  if (oracle && gen) {
    const r = await runner.stressTest({
      solution: { lang: rec.codeLang || 'cpp', code: rec.code },
      brute: oracle,
      gen,
      iterations: opts.iterations,
      timeLimitMs: runner.RUN_TIMEOUT_MS,
      maxTotalMs: opts.maxTotalMs
    });
    if (!r.ok) { out.diffVerdict = 'run-error'; out.detail = r.error; }
    else if (r.status === 'ok') out.diffVerdict = 'AC';
    else if (r.status === 'mismatch') { out.diffVerdict = 'WA'; out.detail = out.detail || ('差分第 ' + r.iteration + ' 组不一致'); out.counterExample = { input: r.input, expected: r.expected, actual: r.actual }; }
    else { out.diffVerdict = 'run-error'; out.detail = out.detail || (r.which + '：' + r.detail); }
  } else {
    out.diffVerdict = 'no-oracle';
  }
  // 假自信：链说"已验证"、外部 oracle 却判它错 —— 这是验证链最该被追问的一种失败
  if (out.assertedVerified) out.falseConfidence = (out.diffVerdict === 'WA');
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
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const problem = byId.get(rec.problem);
    const v = await judgeRecord(rec, problem, { iterations, maxTotalMs });
    verdicts.push(v);
    log([v.level, v.problem, (v.model || '')].join(' ') + ' → 样例 ' + v.sampleVerdict + '｜差分 ' + v.diffVerdict
      + (v.assertedVerified != null ? '｜链声称已验证 ' + (v.assertedVerified ? '是' : '否') : '')
      + (v.falseConfidence ? '  ⚠️假自信' : '') + (v.detail ? '  ' + v.detail : ''));
    if (h.onVerdict) h.onVerdict(v, i, records.length);
  }
  const vfile = path.join(outDir, 'verdicts.jsonl');
  fs.writeFileSync(vfile, verdicts.map((v) => JSON.stringify(v)).join('\n') + (verdicts.length ? '\n' : ''), 'utf8');

  const byLevel = {};
  for (const v of verdicts) {
    const g = byLevel[v.level] = byLevel[v.level] || { total: 0, sampleAC: 0, diffAC: 0, both: 0, noCode: 0, noOracle: 0, asserted: 0, falseConfidence: 0 };
    g.total++;
    if (v.sampleVerdict === 'AC') g.sampleAC++;
    if (v.diffVerdict === 'AC') g.diffAC++;
    if (v.diffVerdict === 'AC' && (v.sampleVerdict === 'AC' || v.sampleVerdict === 'skipped')) g.both++;
    if (v.sampleVerdict === 'no-code') g.noCode++;
    if (v.diffVerdict === 'no-oracle') g.noOracle++;
    if (v.assertedVerified === true) g.asserted++;
    if (v.falseConfidence) g.falseConfidence++;
  }
  log('\n=== 结果（按档位）===');
  for (const [lv, g] of Object.entries(byLevel)) {
    const pct = (n) => g.total ? Math.round((n / g.total) * 100) + '%' : '—';
    log(lv.padEnd(3) + ' n=' + g.total + '  样例通过 ' + g.sampleAC + '(' + pct(g.sampleAC) + ')'
      + '  差分通过 ' + g.diffAC + '(' + pct(g.diffAC) + ')' + '  无代码 ' + g.noCode + '  无 oracle ' + g.noOracle
      + (g.asserted ? '  声称已验证 ' + g.asserted + '（其中假自信 ' + g.falseConfidence + '）' : ''));
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
    log('配对 ' + cmp.n + ' 题：' + cand + ' 更好 ' + cmp.win + '，打平 ' + cmp.tie + '，' + base + ' 更好 ' + cmp.loss
      + '  →  **不差于 ' + base + ' 的比例 ' + pct(cmp.notWorseRate) + '**（' + cmp.notWorse + '/' + cmp.n + '）');
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

module.exports = { judgeRecord, readRecords, judgeAll };

if (require.main === module) {
  main().catch((e) => { console.error('判分失败：' + ((e && e.stack) || e)); process.exit(1); });
}

