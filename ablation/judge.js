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
const runner = require('../lib/runner');

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
    sampleVerdict: 'skipped', diffVerdict: 'skipped', detail: null };
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
  return out;
}

async function main() {
  const args = env.parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args.out) {
    console.log('用法：node ablation/judge.js --out <跑分目录> [--iterations 200] [--problems-file …] [--limit N]');
    return;
  }
  const outDir = path.resolve(String(args.out));
  const lc = problemsLib.loadProblems(Object.assign({}, args, { problems: 'all', limit: 0 }));
  const byId = new Map(lc.all.map((p) => [p.id, p]));
  const iterations = env.num(args.iterations, 200);
  const maxTotalMs = env.num(args.maxTotalMs, 180000);
  const limit = env.num(args.limit, 0);

  let records = readRecords(outDir);
  if (limit > 0) records = records.slice(0, limit);
  console.log('=== 判分 ===');
  console.log('记录：' + path.join(outDir, 'records.jsonl') + '（' + records.length + ' 条）');
  console.log('差分：每题最多 ' + iterations + ' 组随机数据（oracle 来自 problems.json，不是 L2 产出的）\n');

  const verdicts = [];
  for (const rec of records) {
    const problem = byId.get(rec.problem);
    const v = await judgeRecord(rec, problem, { iterations, maxTotalMs });
    verdicts.push(v);
    console.log([v.level, v.problem, (v.model || '')].join(' ') + ' → 样例 ' + v.sampleVerdict + '｜差分 ' + v.diffVerdict + (v.detail ? '  ' + v.detail : ''));
  }
  const vfile = path.join(outDir, 'verdicts.jsonl');
  fs.writeFileSync(vfile, verdicts.map((v) => JSON.stringify(v)).join('\n') + (verdicts.length ? '\n' : ''), 'utf8');

  const byLevel = {};
  for (const v of verdicts) {
    const g = byLevel[v.level] = byLevel[v.level] || { total: 0, sampleAC: 0, diffAC: 0, both: 0, noCode: 0, noOracle: 0 };
    g.total++;
    if (v.sampleVerdict === 'AC') g.sampleAC++;
    if (v.diffVerdict === 'AC') g.diffAC++;
    if (v.diffVerdict === 'AC' && (v.sampleVerdict === 'AC' || v.sampleVerdict === 'skipped')) g.both++;
    if (v.sampleVerdict === 'no-code') g.noCode++;
    if (v.diffVerdict === 'no-oracle') g.noOracle++;
  }
  console.log('\n=== 结果（按档位）===');
  for (const [lv, g] of Object.entries(byLevel)) {
    const pct = (n) => g.total ? Math.round((n / g.total) * 100) + '%' : '—';
    console.log(lv.padEnd(3) + ' n=' + g.total + '  样例通过 ' + g.sampleAC + '(' + pct(g.sampleAC) + ')'
      + '  差分通过 ' + g.diffAC + '(' + pct(g.diffAC) + ')' + '  无代码 ' + g.noCode + '  无 oracle ' + g.noOracle);
  }
  console.log('\n判据：差分通过 = 与外部 AC 标准在 ' + iterations + ' 组随机数据上完全一致。');
  console.log('统计建议：同一批题跑齐 L0/L1/L2 后做配对比较（每题只有 对/错 两种结果 → 符号检验/McNemar），');
  console.log('        并同时报告每档的 tokens 与花费（"提升 30 个百分点"要配上"多花多少 token"才有意义）。');
  console.log('明细：' + vfile);
}

module.exports = { judgeRecord, readRecords };

if (require.main === module) {
  main().catch((e) => { console.error('判分失败：' + ((e && e.stack) || e)); process.exit(1); });
}

