#!/usr/bin/env node
/**
 * 消融实验自测（零 token）：本地假模型 + 示例题，把 L0 / L1 / 判分 三条链路跑通。
 *
 * 验证四件事：
 *   ① L0 能跑：一次调用拿到回答、抽出代码、记账 tokens
 *   ② L1 能跑：模型真的调了 write_file/stress_test、正解落盘、工具流水留档
 *   ③ 判分能判对：正确代码 → 样例 AC + 差分 AC
 *   ④ 判分能判错：样例过得去、但差分一定抓得到的错代码 → 样例 AC + 差分 WA
 *      （"判据必须能失败"——只会一片绿的判据没有鉴别力，这条是硬要求）
 *
 * 用法：node ablation/selftest.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./lib/env');
const record = require('./lib/record');
const levels = require('./lib/levels');
const problemsLib = require('./lib/problems');
const judge = require('./judge');
const { startMockLlm } = require('./mockllm');
const runner = require('../lib/runner');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function main() {
  console.log('=== ablation 自测（零 token）===');
  const rt = await runner.availableRuntimes();
  console.log('本机运行时：C++=' + !!rt.cpp + '  Python=' + !!rt.python + '  Node=' + !!rt.js);
  if (!rt.python) {
    console.log('本机没有 Python：L1 与判分都需要能跑代码，跳过自测。');
    return;
  }
  const lc = problemsLib.loadProblems({ problemsFile: path.join(__dirname, 'problems.example.json'), problems: 'all' });
  const problem = lc.all.find((p) => p.id === 'example-ab');
  if (!problem || !problem.statement.trim()) throw new Error('示例题装载失败（example/statement-ab.txt 丢了？）');
  check('示例题装载（题面 + 样例 + oracle + gen）', !!problem.statementSha && problem.samples.length === 2 && !!problem.oracle && !!problem.gen);

  const mock = await startMockLlm({ port: 0 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablation-selftest-'));
  const run = record.openRun(path.join(tmp, 'out'));
  const target = { provider: { id: 'mock', type: 'openai', baseUrl: mock.url, apiKey: 'mock', stream: true }, providerId: 'mock', model: 'mock-gpt-4' };
  const params = { temperature: 0.6, topP: 1, maxTokens: 0 };

  try {
    // ① L0
    const rec0 = await levels.runL0({ problem, statement: problem.statement, target, params, run, name: 'L0-example-ab' });
    check('L0 出代码', rec0.ok && !!rec0.code, rec0.error || '');
    check('L0 代码语言识别为 python', rec0.codeLang === 'python');
    check('L0 记账 tokens', !!(rec0.usage && rec0.usage.promptTokens > 0 && rec0.usage.completionTokens > 0), JSON.stringify(rec0.usage));
    check('L0 回答留档', !!rec0.answerFile && fs.existsSync(rec0.answerFile));

    // ② L1
    const rec1 = await levels.runL1({ problem, statement: problem.statement, target, params, run, name: 'L1-example-ab', maxSteps: 8, iterations: 5 });
    check('L1 出代码', rec1.ok && !!rec1.code, rec1.error || '');
    check('L1 真的调了写文件与对拍', (rec1.toolsUsed || []).indexOf('write_file') >= 0 && (rec1.toolsUsed || []).indexOf('stress_test') >= 0, JSON.stringify(rec1.toolsUsed));
    check('L1 正解来自落盘文件', /^file:/.test(String(rec1.codeSource)), rec1.codeSource || '');
    const sbox = path.join(run.outDir, 'sandbox', 'L1-example-ab');
    check('L1 工作目录留下 brute/gen/solution', ['brute.py', 'gen.py', 'solution.py'].every((f) => fs.existsSync(path.join(sbox, f))));
    const events = fs.readFileSync(rec1.transcriptFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('L1 工具流水留档（toolEnd 事件）', events.filter((e) => e.kind === 'toolEnd').length >= 3, 'events=' + events.length);
    check('L1 对拍结果传给了模型', events.some((e) => e.name === 'stress_test' && /对拍通过/.test(String(e.result))));

    // ③ 判分能判对
    const v0 = await judge.judgeRecord(rec0, problem, { iterations: 20, maxTotalMs: 60000 });
    check('判分：L0 正确代码 → 样例 AC', v0.sampleVerdict === 'AC', v0.sampleVerdict + ' ' + (v0.detail || ''));
    check('判分：L0 正确代码 → 差分 AC', v0.diffVerdict === 'AC', v0.diffVerdict + ' ' + (v0.detail || ''));
    const v1 = await judge.judgeRecord(rec1, problem, { iterations: 20, maxTotalMs: 60000 });
    check('判分：L1 正确代码 → 样例+差分 AC', v1.sampleVerdict === 'AC' && v1.diffVerdict === 'AC', JSON.stringify([v1.sampleVerdict, v1.diffVerdict, v1.detail]));

    // ④ 判分能判错：样例过得去、差分一定抓到
    const tricky = [
      'import sys',
      'data = sys.stdin.read().split()',
      'a, b = int(data[0]), int(data[1])',
      'print(0 if b in (3, 4, 6, 7, 8, 9, 10) else a + b)'
    ].join('\n');
    const vBad = await judge.judgeRecord({ level: 'L0', problem: problem.id, code: tricky, codeLang: 'python', codeSource: 'selftest' }, problem, { iterations: 30, maxTotalMs: 60000 });
    check('判分：样例过得去但差分抓到错', vBad.sampleVerdict === 'AC' && vBad.diffVerdict === 'WA', JSON.stringify([vBad.sampleVerdict, vBad.diffVerdict, vBad.detail]));

    // ⑤ 记录与汇总
    run.writeSummary({ selftest: true });
    const lines = fs.readFileSync(run.recordsFile, 'utf8').split('\n').filter(Boolean);
    check('records.jsonl 写出两条记录', lines.length === 2, 'lines=' + lines.length);
    check('summary.json 写出分档汇总', fs.existsSync(path.join(run.outDir, 'summary.json')));
    const r0 = JSON.parse(lines[0]);
    check('记录里有题面 sha（三档同题面可审计）', !!r0.statementSha, String(r0.statementSha));
    check('两档题面 sha 相同（信息预算对齐）', r0.statementSha === JSON.parse(lines[1]).statementSha);
  } finally {
    await mock.close();
    console.log('（自测临时目录：' + tmp + '，可删）');
  }

  console.log('\nablation 自测：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('自测崩了：' + ((e && e.stack) || e)); process.exit(1); });
