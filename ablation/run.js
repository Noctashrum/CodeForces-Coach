#!/usr/bin/env node
/**
 * 消融实验跑分入口（L0 / L1；L2 请直接用 cf-coach 本体，把它的回答记进同一个目录）。
 *
 * 用法：
 *   node ablation/run.js --level L0,L1 --problems all --model deepseek-chat
 *   node ablation/run.js --level L1 --problems 1800C --out ablation/out/trial1 --max-steps 20
 *   node ablation/run.js --base-url http://127.0.0.1:3999/v1 --api-key mock --model mock-gpt-4   # 零成本自测
 *
 * 产出（都在 --out 目录里）：
 *   records.jsonl    每次运行一行：题面 sha、题号、模型、提示词、工具面、tokens、花费、耗时、最终代码
 *   answers/*.md     模型原始回答全文（人工复核用）
 *   transcript/*.jsonl  L1 的工具调用流水（时间、工具、参数、结果）
 *   sandbox/<name>/  L1 的工作目录（brute.py / gen.py / solution.py 都留着）
 *   summary.json     分档汇总（次数、成败、tokens、花费、总耗时）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const record = require('./lib/record');
const levels = require('./lib/levels');
const problemsLib = require('./lib/problems');
const agentloop = require('../lib/agentloop');

const LEVELS = ['L0', 'L1'];

function usage() {
  console.log([
    '消融实验跑分：node ablation/run.js [选项]',
    '',
    '  --level L0,L1        跑哪些档（默认 L0,L1）',
    '  --problems all|1800C,1800D   跑哪些题（默认 all）',
    '  --problems-file PATH 题库清单（默认 ablation/problems.json，缺则用 example）',
    '  --limit N            只跑前 N 题（先做 pilot 用）',
    '  --model NAME         模型名（可多次/逗号分隔；默认取 data/config.json）',
    '  --provider-id ID     服务商 id（默认取配置里的默认服务商）',
    '  --base-url URL       直接指定服务商地址（测试用，如本地 mock）',
    '  --api-key KEY        配合 --base-url',
    '  --provider-type T    openai（默认）| anthropic',
    '  --max-tokens N       单次输出上限（0/缺省 = 不发这个字段）',
    '  --max-steps N        L1 工具循环上限（默认 20）',
    '  --iterations N       L1 对拍默认组数（默认 30）',
    '  --jobs N             并行跑几个 (题×档)（默认 1）',
    '  --out DIR            输出目录（默认 ablation/out/<时间戳>）',
    '  --dry-run            只打印计划，不调模型'
  ].join('\n'));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 极简并发池（--jobs N） */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(n, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = env.parseArgs(process.argv.slice(2));
  if (args.help || args.h) { usage(); return; }
  const cfg = env.loadAppConfig();
  const targets = env.resolveTargets(args);
  const params = env.resolveParams(args);
  const levelList = env.listOf(args.level).length ? env.listOf(args.level).map((s) => s.toUpperCase()) : LEVELS.slice();
  for (const l of levelList) if (LEVELS.indexOf(l) < 0) throw new Error('未知档位：' + l + '（目前实现：' + LEVELS.join('/') + '）');

  const lc = problemsLib.loadProblems(args);
  const outDir = args.out ? path.resolve(String(args.out)) : path.join(__dirname, 'out', stamp());
  const maxSteps = env.num(args.maxSteps, 20);
  const iterations = env.num(args.iterations, 30);
  const jobs = Math.max(1, env.num(args.jobs, 1));

  console.log('=== 消融实验 ===');
  console.log('题库清单：' + lc.file + (lc.isExample ? '（警告：这是示例清单，请复制成 problems.json 填自己的题）' : ''));
  console.log('题目：' + lc.problems.map((p) => p.id).join(', ') + '（共 ' + lc.problems.length + ' 题）');
  if (lc.skipped.length) lc.skipped.forEach((s) => console.log('  · 跳过 ' + s.id + '：' + s.reason));
  console.log('模型：' + targets.map((t) => t.providerId + '::' + t.model).join('  '));
  console.log('档位：' + levelList.join(', ') + '（L2 用 cf-coach 本体跑）');
  console.log('参数：maxTokens=' + (params.maxTokens || '未设置') + '，stream=true（lib/llm.js 的请求体不含 temperature，三档一致）');
  console.log('输出：' + outDir);
  if (args.dryRun) {
    for (const p of lc.problems) console.log('  · ' + p.id + ' 题面 ' + (p.statementSha || '缺') + ' 样例 ' + p.samples.length + ' 组 oracle ' + (p.oracle ? '有' : '无'));
    return;
  }

  const run = record.openRun(outDir);
  const jobsList = [];
  for (const t of targets) {
    for (const p of lc.problems) {
      for (const level of levelList) {
        if (!p.statement.trim()) continue;
        jobsList.push({ target: t, problem: p, level });
      }
    }
  }
  console.log('待跑：' + jobsList.length + ' 个 (模型×题×档)，并发 ' + jobs + '\n');

  let done = 0;
  await pool(jobsList, jobs, async (j) => {
    const name = j.level + '-' + j.problem.id + (targets.length > 1 ? '-' + j.target.model : '');
    const ctx = { problem: j.problem, statement: j.problem.statement, target: j.target, params, run, name, maxSteps, iterations };
    const t0 = Date.now();
    const rec = j.level === 'L0' ? await levels.runL0(ctx) : await levels.runL1(ctx);
    const cost = record.costOf(cfg, j.target.providerId, j.target.model, rec.usage);
    rec.cost = cost;
    rec.statementSha = j.problem.statementSha;
    rec.statementFile = j.problem.statementFile;
    // 把"这次到底发了什么"记全（审计用）：请求体形状 + 工具名清单
    rec.requestFingerprint = {
      model: j.target.model, providerId: j.target.providerId, baseUrl: j.target.provider.baseUrl,
      stream: true, maxTokens: params.maxTokens || null,
      toolNames: rec.tools && rec.tools.length ? rec.tools : [],
      leakMarkupInAnswer: !!rec.leakMarkup
    };
    if (agentloop.hasLeakMarkup(rec.code || '')) rec.codeLeakMarkup = true;
    // records.jsonl 已经写过一行（run.add），这里补写"带成本/指纹"的最终版本：直接重写整个文件更简单
    done++;
    const tag = rec.ok ? '✓' : '✗';
    console.log('[' + done + '/' + jobsList.length + '] ' + tag + ' ' + name + '  ' + Math.round((Date.now() - t0) / 1000) + 's  '
      + 'tok ' + ((rec.usage && rec.usage.promptTokens) || 0) + '+' + ((rec.usage && rec.usage.completionTokens) || 0)
      + (cost ? '  ¥' + cost.amount : '') + (rec.error ? '  ' + rec.error : '') + (rec.codeSource ? '  [' + rec.codeSource + ']' : ''));
    return rec;
  });

  // run.add 里已经逐行写过初版记录；这里用补全后的记录整体覆盖，保证 JSONL 与内存一致
  fs.writeFileSync(run.recordsFile, run.records.map((r) => JSON.stringify(r)).join('\n') + (run.records.length ? '\n' : ''), 'utf8');
  const summary = run.writeSummary({ problems: lc.problems.map((p) => p.id), levels: levelList, targets: targets.map((t) => t.providerId + '::' + t.model), params });
  console.log('\n=== 汇总 ===');
  for (const [lv, g] of Object.entries(summary.byLevel)) {
    console.log(lv + '：跑 ' + g.runs + ' 次，成功 ' + g.ok + '，失败 ' + g.failed + '，tokens ' + g.promptTokens + '+' + g.completionTokens
      + '，花费 ¥' + g.cost.toFixed(3) + '，总耗时 ' + Math.round(g.ms / 1000) + 's');
  }
  console.log('记录：' + run.recordsFile);
  console.log('\n下一步：node ablation/judge.js --out "' + outDir + '"   （样例 + oracle 差分判分）');
}

main().catch((e) => {
  console.error('跑分失败：' + ((e && e.stack) || e));
  process.exit(1);
});
