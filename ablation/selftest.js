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
const vm = require('vm');
const net = require('net');
const { spawn } = require('child_process');
const env = require('./lib/env');
const record = require('./lib/record');
const levels = require('./lib/levels');
const l2 = require('./lib/l2');
const compareLib = require('./lib/compare');
const cffetch = require('./lib/cffetch');
const mkgen = require('./lib/mkgen');
const uistore = require('./lib/uistore');
const problemsLib = require('./lib/problems');
const ladderLib = require('./lib/ladder');
const runlog = require('./lib/runlog');
const judge = require('./judge');
const diagbundle = require('../lib/diagbundle');
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
    // P0 回归①：消融工作台写出的 problems.json 里 `statement` 是**整段题面正文**，装载器原来把它当文件名
    //   → 题面解析成空串 → 多解题检测恒 false → 2241B/2267B 被判 oracle-broken 整题排除（正确解被字面比对误判成 WA）。
    const inlineProblems = path.join(tmp, 'inline-problems.json');
    fs.writeFileSync(inlineProblems, JSON.stringify({
      problems: [{
        id: '2241B',
        statement: 'You are given an integer x. If there are multiple valid answers, output any one of them.',
        samples: [{ input: '1 1', output: '11' }]
      }]
    }), 'utf8');
    const inlineLoaded = problemsLib.loadProblems({ problemsFile: inlineProblems, problems: 'all' });
    check('装载：problems.json 里内联的整段题面不再被当成文件名丢掉',
      inlineLoaded.all.length === 1 && inlineLoaded.all[0].statement.length > 60 && inlineLoaded.skipped.length === 0,
      JSON.stringify([inlineLoaded.all.length, inlineLoaded.skipped.length, String(inlineLoaded.all[0] && inlineLoaded.all[0].statement).length]));
    check('装载：内联题面也判得出多解题（判分器与产品共用一份判据）',
      mkgen.looksSpecialJudge(inlineLoaded.all[0].statement) === true
      && mkgen.looksSpecialJudge('Print the maximum possible score.') === false);
    // P0 回归②：工作区/文档按轮次隔离 —— 否则上一轮遗留的 sol.py 会被下一轮当成自己的产物读走
    //   （2268A 的失败轮就是这样被记成"有代码、验证通过"，交付的却是 4 小时前那一轮的文档与代码）
    check('轮次隔离：批次号形如 YYYYMMDD-HHMMSS', /^\d{8}-\d{6}$/.test(String(run.id)), String(run.id));
    const wsA = l2.prepareWorkspace(run.outDir, '21000101-000000');
    const wsB = l2.prepareWorkspace(run.outDir, '21000101-000001');
    // 直接验"上一轮写下的产物下一轮读不到"：2268A 事故就是上一轮的 sol.py 被下一轮当成自己的交付
    const probeDir = path.join(wsA, 'workspace', 'ab-isolation-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'sol.py'), 'print(1)', 'utf8');
    check('轮次隔离：不同轮次落在不同工作区根目录，且上一轮的产物下一轮读不到',
      wsA !== wsB && path.dirname(wsA) === path.dirname(wsB) && /l2-data/.test(wsA)
      && !fs.existsSync(path.join(wsB, 'workspace', 'ab-isolation-probe', 'sol.py')),
      wsA + ' | ' + wsB);
    l2.prepareWorkspace(run.outDir, run.id);   // 还原成本轮的根目录（自测后面还要真跑 L2）

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

    // ②b L1 的收尾兜底：2268A 实测那次 20 步全花在辅助脚本上，最后「正解没落盘、正文也没代码块」→
    //    兜底要追问一次"只要最终代码"，把交付物救回来（否则整档就是 FAILED，白烧 70 万 token）
    const mockNoCode = await startMockLlm({ port: 0, l1NoCode: true });
    try {
      const rec1b = await levels.runL1({
        problem, statement: problem.statement, run, name: 'L1-nocode-ab', maxSteps: 3, iterations: 5, params,
        target: { provider: { id: 'mock', type: 'openai', baseUrl: mockNoCode.url, apiKey: 'mock', stream: true }, providerId: 'mock', model: 'mock-gpt-4' }
      });
      check('L1 收尾兜底：没代码也没落盘 → 追问一次"只要最终代码"',
        !!rec1b.finalize, JSON.stringify(rec1b.finalize || null));
      check('L1 收尾兜底：追问拿到的代码算数（来源标成 answer-final）',
        rec1b.ok && rec1b.codeSource === 'answer-final', JSON.stringify([rec1b.ok, rec1b.codeSource, rec1b.error]));
      check('L1 收尾兜底：那次追问的 token 也计入本档成本',
        !!(rec1b.finalize && rec1b.finalize.promptTokens > 0 && rec1b.usage && rec1b.usage.promptTokens > 0),
        JSON.stringify([rec1b.finalize, rec1b.usage]));
      check('L1 收尾兜底：回答单独留档（原始那份是空话/标记）',
        !!rec1b.finalAnswerFile && fs.existsSync(rec1b.finalAnswerFile), String(rec1b.finalAnswerFile || ''));
    } finally { await mockNoCode.close(); }

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

    // ④b 差分"跑不了"的两种原因必须分开报（2268A 那次就是被混成一句 no-oracle 才看不出该点「补生成器」）
    const vNoGen = await judge.judgeRecord(
      { level: 'L0', problem: 'nogen', code: 'print(1)', codeLang: 'python', codeSource: 'selftest' },
      { id: 'nogen', samples: [], oracle: problem.oracle, gen: null }, { iterations: 20, maxTotalMs: 60000 });
    check('判分：有 oracle 没生成器 → no-gen（提示怎么补，而不是怪 oracle）',
      vNoGen.diffVerdict === 'no-gen' && /生成器/.test(String(vNoGen.detail || '')), JSON.stringify([vNoGen.diffVerdict, vNoGen.detail]));
    const vNoOracle = await judge.judgeRecord(
      { level: 'L0', problem: 'nooracle', code: 'print(1)', codeLang: 'python', codeSource: 'selftest' },
      { id: 'nooracle', samples: [], oracle: null, gen: problem.gen }, { iterations: 20, maxTotalMs: 60000 });
    check('判分：没有 oracle → no-oracle（oracle 必须是外部 AC，不能是 coach 自己的产出）',
      vNoOracle.diffVerdict === 'no-oracle', JSON.stringify([vNoOracle.diffVerdict, vNoOracle.detail]));

    // ⑤ L2（cf-coach 本体无头跑）：验证链要真的跑起来并给出可判分的交付物
    const rec2 = await l2.runL2({
      problem, statement: problem.statement, target, params, run, name: 'L2-example-ab',
      iterations: 5, lang: 'python', depth: 'L3', maxStressMs: 60000
    });
    check('L2 出代码', rec2.ok && !!rec2.code, rec2.error || '');
    check('L2 交付物取自工作区文件', /^workspace:/.test(String(rec2.codeSource)), rec2.codeSource || '');
    check('L2 内部多角色都跑到了', ['solution', 'brute', 'gen'].every((r) => (rec2.roles || {})[r] > 0), JSON.stringify(rec2.roles));
    check('L2 验证状态 ok 且链声称已验证', rec2.verificationStatus === 'ok' && rec2.assertedVerified === true, String(rec2.verificationStatus));
    check('L2 验证报告带覆盖范围（可自证边界）', !!rec2.scopeNote && rec2.scopeComplete === true, rec2.scopeNote || '');
    const v2 = await judge.judgeRecord(rec2, problem, { iterations: 20, maxTotalMs: 60000 });
    check('判分：L2 正解 → 样例+差分 AC', v2.sampleVerdict === 'AC' && v2.diffVerdict === 'AC', JSON.stringify([v2.sampleVerdict, v2.diffVerdict, v2.detail]));

    // ⑥ P0 闸门：题解本身是错的（题面里埋「错解」让假模型吐错代码）
    //    期望：链**不许**声称已验证；重写版没过官方样例 → 被拒并保留原版；判分判它 WA。
    const wrongStatement = '（自测用）题面里故意写「错解」两个字，让假模型吐一份错代码。\n\n输入两个整数 a、b，输出它们的和。';
    const wrongProblem = Object.assign({}, problem, {
      id: 'wrong-ab', statement: wrongStatement, statementSha: env.sha256(wrongStatement), statementFile: null
    });
    const recW = await l2.runL2({
      problem: wrongProblem, statement: wrongStatement, target, params, run, name: 'L2-wrong-ab',
      iterations: 5, lang: 'python', depth: 'L3', maxStressMs: 60000
    });
    check('L2 错解时不声称已验证（P0：收紧"已验证"）', recW.assertedVerified === false && recW.verificationStatus !== 'ok', String(recW.verificationStatus));
    check('L2 错解时如实标注交付的是第一版', recW.delivered === 'model-first', String(recW.delivered));
    check('L2 拒绝没过官方样例的重写（P0 闸门留痕）', (recW.trajectory || []).some((t) => t.kind === 'sol-rewrite-sample-fail'));
    const vW = await judge.judgeRecord(recW, wrongProblem, { iterations: 20, maxTotalMs: 60000 });
    check('判分：L2 错解 → 差分 WA（判据有鉴别力）', vW.diffVerdict === 'WA', JSON.stringify([vW.sampleVerdict, vW.diffVerdict]));

    // ⑦ 配对比较（用户口径：合格线 = 不差于 L0）
    //    错解那题也真跑一遍 L0（不能拿"对的 L0 判分明细"冒充）——否则配对比的是两个不同的东西
    const rec0W = await levels.runL0({ problem: wrongProblem, statement: wrongStatement, target, params, run, name: 'L0-wrong-ab' });
    const v0W = await judge.judgeRecord(rec0W, wrongProblem, { iterations: 20, maxTotalMs: 60000 });
    check('判分：错解那题的 L0 也是错的（两边都错才是"打平"）', v0W.diffVerdict === 'WA', JSON.stringify([v0W.sampleVerdict, v0W.diffVerdict]));
    const cmp = compareLib.compare([rec0, rec1, rec2, rec0W, recW], [v0, v1, v2, v0W, vW], { base: 'L0', cand: 'L2' });
    check('配对比较：只统计跑齐两档的题', cmp.n === 2, 'n=' + cmp.n);
    check('配对比较：正解那题打平、错解那题也打平 → 不差于 L0 = 100%', cmp.notWorse === 2 && cmp.tie === 2, JSON.stringify([cmp.win, cmp.tie, cmp.loss]));
    check('配对比较：假自信率（只有 L2 会"声称已验证"，错的那题没声称）',
      cmp.falseConfidence.asserted === 1 && cmp.falseConfidence.assertedWrong === 0, JSON.stringify(cmp.falseConfidence));
    check('配对比较：没有 oracle 的题只算样例级证据（不冒充差分 AC）',
      compareLib.acOf({ diffVerdict: 'no-oracle', sampleVerdict: 'AC' }).strength === 'samples'
      && compareLib.acOf({ diffVerdict: 'WA', sampleVerdict: 'AC' }).ac === false);
    check('配对比较：缺生成器（no-gen）同样只算样例级证据，不冒充差分 AC',
      compareLib.acOf({ diffVerdict: 'no-gen', sampleVerdict: 'AC' }).strength === 'samples'
      && compareLib.acOf({ diffVerdict: 'no-gen', sampleVerdict: 'WA' }).ac === false);
    check('配对比较：McNemar 精确检验的已知值正确',
      Math.abs(compareLib.exactBinomialTwoSided(0, 5) - 0.0625) < 1e-9
      && Math.abs(compareLib.exactBinomialTwoSided(1, 9) - (22 / 1024)) < 1e-9
      && compareLib.exactBinomialTwoSided(0, 0) === 1
      && Math.abs(compareLib.exactBinomialTwoSided(3, 3) - 1) < 1e-9);

    // ⑧ 取题通道 + 自动写生成器（用户 m04297：我只想贴 oracle，题面和生成器都别让我手填）
    check('题号解析：1800C / 1800 C / 链接 / 看不懂 → 按预期',
      JSON.stringify(cffetch.parseRef('1800C')) === '{"contestId":1800,"index":"C"}'
      && JSON.stringify(cffetch.parseRef('1800 C')) === '{"contestId":1800,"index":"C"}'
      && JSON.stringify(cffetch.parseRef('https://codeforces.com/contest/1800/problem/C')) === '{"contestId":1800,"index":"C"}'
      && cffetch.parseRef('随便写点什么') === null);
    // 题库清单里 oracle 只记 {lang, file}（判分自己读文件）；mkgen 要的是能贴进提示词的代码正文
    const oracleSrc = { lang: problem.oracle.lang, code: fs.readFileSync(problem.oracle.file, 'utf8') };
    const gen1 = await mkgen.makeGen({ problem, statement: problem.statement, oracle: oracleSrc, target, params });
    check('自动写生成器：模型写出来 + 体检通过',
      gen1.ok === true && !!gen1.code && !!gen1.gate && gen1.gate.status === 'ok',
      gen1.error || JSON.stringify(gen1.gate && gen1.gate.detail));
    check('自动写生成器：体检是真的跑了代码（有数据样例）', !!(gen1.gate && String(gen1.gate.sample || '').trim()), gen1.gate && gen1.gate.sample);
    const gArgv = await mkgen.gateGen({ gen: { lang: 'python', code: 'import sys\nn = int(sys.argv[1])\nprint(n, n)' }, oracle: oracleSrc });
    check('体检拦住"不给命令行参数就跑不动"的生成器（判分调用它时没有 argv）',
      gArgv.ok === false && gArgv.status === 'gen', JSON.stringify([gArgv.ok, gArgv.status, gArgv.detail]));
    const gBad = await mkgen.gateGen({ gen: { lang: 'python', code: 'print("这一行不是两个整数")' }, oracle: oracleSrc });
    check('体检拦住"数据违反输入格式"的生成器（oracle 会崩）',
      gBad.ok === false && gBad.status === 'oracle', JSON.stringify([gBad.ok, gBad.status]));
    const gConst = await mkgen.gateGen({ gen: { lang: 'python', code: 'print(3, 4)' }, oracle: oracleSrc });
    check('体检对"每次产出同一组数据"给警告但不拦（能跑，只是覆盖面小）',
      gConst.ok === true && gConst.diverse === false && gConst.warnings.length >= 1, JSON.stringify(gConst.warnings));

    // ⑧a-2 两道清洗：整块粘贴带 ``` 围栏 + 语言选错（用户 m07960「生成器为什么一直跑崩」的真因：
    //       落盘的 oracle 第 1 行是 ```、语言记成 python 而正文是 C++，报错却指向"生成的数据"）
    check('剥围栏：整块粘贴的代码只留正文', uistore.stripFence('```cpp\nint main(){}\n```') === 'int main(){}',
      JSON.stringify(uistore.stripFence('```cpp\nint main(){}\n```')));
    check('剥围栏：正文里出现的 ``` 不动（不是整块围栏就不碰）',
      uistore.stripFence('int main(){}\n// ``` 这种注释') === 'int main(){}\n// ``` 这种注释');
    check('猜语言：C++ / Python 都认得出，没把握就给 null（不擅自改用户的选项）',
      uistore.detectLang('#include <bits/stdc++.h>\nint main(){}') === 'cpp'
      && uistore.detectLang('n = int(input())\nprint(n)') === 'python'
      && uistore.detectLang('') === null);
    const gBroken = await mkgen.gateGen({
      gen: { lang: 'python', code: 'print(3, 4)' },
      oracle: { lang: 'python', code: '```\n#include <bits/stdc++.h>\nint main(){}\n```' },
      samples: [{ input: '3 4', output: '7' }]
    });
    check('oracle 自己坏掉时报 oracle-broken（不冤枉生成器，并指出围栏/语言）',
      gBroken.ok === false && gBroken.status === 'oracle-broken' && /围栏|语言/.test(String(gBroken.detail)),
      JSON.stringify([gBroken.status, String(gBroken.detail).slice(0, 120)]));
    // 老数据自愈：problems.json 记 python、文件却是"带围栏的 C++" → 重新 init 一次应被修好
    // （真机上 2268A 就是这个形态；用户重启工作台即自动修）
    const legacy = path.join(tmp, 'uistore-legacy');
    uistore.init(legacy).save({
      id: '1111A', title: '1111A', statement: '输入两个整数', samples: [{ input: '1 2', output: '3' }],
      oracleLang: 'cpp', oracleCode: '#include <bits/stdc++.h>\nint main(){}'
    });
    fs.writeFileSync(path.join(legacy, 'problems.json'), JSON.stringify([{
      id: '1111A', title: '1111A', statement: '输入两个整数', samples: [{ input: '1 2', output: '3' }],
      oracleLang: 'python', genLang: 'python',
      oracle: { lang: 'python', file: path.join(legacy, 'oracle', '1111A.py') }
    }]), 'utf8');
    fs.writeFileSync(path.join(legacy, 'oracle', '1111A.py'), '```\n#include <bits/stdc++.h>\nint main(){}\n```', 'utf8');
    fs.unlinkSync(path.join(legacy, 'oracle', '1111A.cpp'));
    const healed = uistore.init(legacy).get('1111A');
    check('自愈：老数据里"带围栏 + 语言记错"的 oracle 重启后被修好',
      !!healed && healed.oracleLang === 'cpp' && healed.oracle && healed.oracle.lang === 'cpp'
      && !/```/.test(fs.readFileSync(healed.oracle.file, 'utf8'))
      && !fs.existsSync(path.join(legacy, 'oracle', '1111A.py')),
      JSON.stringify([healed && healed.oracleLang, healed && healed.oracle && healed.oracle.file]));

    // ⑧b 导应用缓存：现场取题被 CF 反爬拦死时的退路（纯本地文件读，离线可测）
    const fakeData = path.join(tmp, 'appdata');
    check('导缓存：目录不存在时清单为空（不炸）', JSON.stringify(cffetch.listAppCache({ dataDir: fakeData })) === '[]');
    fs.mkdirSync(path.join(fakeData, 'cf-problems'), { recursive: true });
    fs.writeFileSync(path.join(fakeData, 'cf-problems', '1800C.json'), JSON.stringify({
      contestId: 1800, index: 'C', title: 'C. Double Sort?', statement: '题面正文', samples: [{ input: '1', output: '2' }]
    }), 'utf8');
    check('导缓存：列出缓存里已有的题号', JSON.stringify(cffetch.listAppCache({ dataDir: fakeData })) === '["1800C"]');
    const cached = cffetch.readAppCache('1800C', { dataDir: fakeData });
    check('导缓存：按题号读回题面与样例（绕开反爬）',
      !!cached && cached.statement === '题面正文' && cached.samples.length === 1, JSON.stringify(cached && cached.title));
    check('导缓存：缓存里没有的题号返回 null（上层给人话）',
      cffetch.readAppCache('9999Z', { dataDir: fakeData }) === null
      && cffetch.readAppCache('1800 D', { dataDir: fakeData }) === null);
    check('导缓存：链接与 {contestId,index} 两种写法都认',
      !!cffetch.readAppCache('https://codeforces.com/contest/1800/problem/C', { dataDir: fakeData })
      && !!cffetch.readAppCache({ contestId: 1800, index: 'c' }, { dataDir: fakeData }));

    // ⑧c 应用数据目录解析：工作台必须看**应用真正在用的**那个目录
    //     （用户跑的是打包版 exe，providers 配置与题面缓存都在 dist/<...>/data/，不在仓库 data/）
    const dNoCfg = path.join(tmp, 'data-no-cfg');
    const dCfg = path.join(tmp, 'data-with-cfg');
    fs.mkdirSync(dNoCfg, { recursive: true });
    fs.mkdirSync(dCfg, { recursive: true });
    fs.writeFileSync(path.join(dCfg, 'config.json'),
      JSON.stringify({ providers: [{ id: 'p1', apiKey: 'k', models: ['m1'] }] }), 'utf8');
    check('数据目录解析：优先挑"有 providers 配置"的那个（打包版 exe 的数据目录）', env.pickDataDir([dNoCfg, dCfg]) === dCfg);
    check('数据目录解析：都没有配置时退回第一个存在的目录', env.pickDataDir([dNoCfg, path.join(tmp, '不存在')]) === dNoCfg);
    check('数据目录解析：候选为空也不炸', String(env.pickDataDir([])).length > 0);
    const keepData = process.env.CFCOACH_APP_DATA;
    process.env.CFCOACH_APP_DATA = dNoCfg;
    check('数据目录解析：CFCOACH_APP_DATA 显式覆盖必须赢（探针靠它隔离真实数据）',
      env.dataDir() === path.resolve(dNoCfg) && cffetch.appDataDir() === path.resolve(dNoCfg));
    if (keepData === undefined) delete process.env.CFCOACH_APP_DATA; else process.env.CFCOACH_APP_DATA = keepData;

    // ⑧d 尺子先验：判分器必须先证明 oracle 自己是对的，否则不许拿它判候选
    //     实证（用户 m08171 的 pilot）：2268A 的 oracle 只打印 n,k 的闭式、完全不读数组，
    //     连自己的官方样例都过不了（期望 9/3/1/19，它给 10/3/7/8）；旧判分器照样拿它当标尺，
    //     把 L0/L2 两侧（用按题面独立写的暴力解验过 520 组全对）都判成"差分 WA"。
    check('多解题识别：题面写 any valid answer 就认得出，普通题面不误判',
      mkgen.looksSpecialJudge('If there are multiple valid answers, output any one of them.') === true
      && mkgen.looksSpecialJudge('Print the maximum possible score.') === false);
    const gWrongOracle = await mkgen.gateGen({
      gen: { lang: 'python', code: 'print(1)' },
      oracle: { lang: 'python', code: 'print(0)' },        // 跑得动，但样例答案错
      samples: [{ input: '1 2', output: '3' }]
    });
    check('尺子先验：oracle 跑得动但样例答案不对 → oracle-broken（不再拿它判候选）',
      gWrongOracle.ok === false && gWrongOracle.status === 'oracle-broken' && /官方样例/.test(String(gWrongOracle.detail)),
      JSON.stringify([gWrongOracle.status, String(gWrongOracle.detail).slice(0, 120)]));
    const gWrongSpecial = await mkgen.gateGen({
      gen: { lang: 'python', code: 'print(1)' },
      oracle: { lang: 'python', code: 'print(0)' },
      statement: 'If there are multiple valid answers, output any one of them.',
      samples: [{ input: '1 2', output: '3' }]
    });
    check('尺子先验：多解题的 oracle 与样例不同不算坏（题面允许任意合法答案）',
      gWrongSpecial.status !== 'oracle-broken', String(gWrongSpecial.status));

    const wrongOracleFile = path.join(tmp, 'gate-wrong-oracle.py');
    fs.writeFileSync(wrongOracleFile, 'print(0)', 'utf8');
    const gateBad = await judge.oracleGate({ samples: [{ input: '1 2', output: '3' }], oracle: { lang: 'python', file: wrongOracleFile } });
    check('oracleGate：坏尺子判 oracle-broken 并说清"不是候选的错"',
      gateBad.status === 'oracle-broken' && /官方样例|不是这道题的正解/.test(String(gateBad.detail)), gateBad.status);
    const gateSpecial = await judge.oracleGate({
      statement: 'If there are multiple valid answers, output any one of them.',
      samples: [{ input: '1 2', output: '3' }], oracle: { lang: 'python', file: wrongOracleFile }
    });
    check('oracleGate：多解题 → special-judge 状态',
      gateSpecial.status === 'special-judge' && gateSpecial.special === true, gateSpecial.status);
    const vBrokenRuler = await judge.judgeRecord(
      { level: 'L2', problem: '9999Z', model: 'mock', code: 'print(0)', codeLang: 'python', assertedVerified: true },
      { id: '9999Z', samples: [{ input: '1 2', output: '3' }], oracle: { lang: 'python', file: wrongOracleFile } },
      { iterations: 5, maxTotalMs: 10000, gate: gateBad });
    check('坏尺子上不记候选 WA，也不算链吹牛（falseConfidence）',
      vBrokenRuler.diffVerdict === 'oracle-broken' && vBrokenRuler.oracleBroken === true && vBrokenRuler.falseConfidence !== true,
      JSON.stringify([vBrokenRuler.sampleVerdict, vBrokenRuler.diffVerdict, vBrokenRuler.falseConfidence]));

    // 配对比较：判不了的格子不许冒充"打平"
    const cmpHalf = compareLib.compare(
      [{ level: 'L0', problem: '2268A', model: 'm' }, { level: 'L2', problem: '2268A', model: 'm' },
        { level: 'L0', problem: '2241C', model: 'm' }, { level: 'L2', problem: '2241C', model: 'm' }],
      [{ level: 'L0', problem: '2268A', model: 'm', diffVerdict: 'oracle-broken', sampleVerdict: 'AC' },
        { level: 'L2', problem: '2268A', model: 'm', diffVerdict: 'oracle-broken', sampleVerdict: 'AC', assertedVerified: true },
        { level: 'L0', problem: '2241C', model: 'm', diffVerdict: 'AC', sampleVerdict: 'AC' },
        { level: 'L2', problem: '2241C', model: 'm', diffVerdict: 'AC', sampleVerdict: 'AC', assertedVerified: true }],
      { base: 'L0', cand: 'L2' });
    check('配对比较：坏尺子那一对挪出胜平负、只按可判的题算比例（不冒充打平）',
      cmpHalf.n === 2 && cmpHalf.decidable === 1 && cmpHalf.tie === 1 && cmpHalf.undecidable.count === 1
      && cmpHalf.notWorseRate === 1 && /2268A/.test(cmpHalf.note),
      JSON.stringify([cmpHalf.n, cmpHalf.decidable, cmpHalf.tie, cmpHalf.undecidable.count, cmpHalf.notWorseRate]));

    // 去重口径：失败重跑不许把更早的**成功**记录顶掉（用户 pilot 里 2268A 就是这样"消失"的）
    const dedupe = uistore.init(path.join(tmp, 'uistore-dedupe'));
    fs.writeFileSync(path.join(dedupe.dir, 'records.jsonl'), [
      JSON.stringify({ level: 'L0', problem: '2268A', model: 'm', startedAt: 'T1', code: 'int main(){}' }),
      JSON.stringify({ level: 'L0', problem: '2268A', model: 'm', startedAt: 'T2' })   // 更晚，但没代码
    ].join('\n') + '\n', 'utf8');
    const kept = dedupe.latestRecords();
    check('去重：更晚的失败重跑（无代码）不吃掉更早的成功记录',
      kept.length === 1 && kept[0].startedAt === 'T1' && !!kept[0].code, JSON.stringify(kept.map((x) => x.startedAt)));
    check('去重：被跳过的记录留了账（latestAudit 能说清谁被顶掉了）',
      dedupe.latestAudit().length === 1 && dedupe.latestAudit()[0].dropped.length === 1
      && dedupe.latestAudit()[0].dropped[0].startedAt === 'T2', JSON.stringify(dedupe.latestAudit()));

    // ⑩ 新档位 L0C = 裸模型 + "只输出一个代码块"（成本 A/B 里唯一有效的干预：0/2 → 2/2）
    //     唯一变量必须是那段格式要求本身：system 一旦不一样，"不会做"和"没交出来"就混在一起了。
    {
      const runC = record.openRun(path.join(tmp, 'l0c'));
      const base = { problem, statement: problem.statement, target, params, run: runC, maxSteps: 4, iterations: 4 };
      const recL0 = await levels.runL0(Object.assign({}, base, { name: 'l0' }));
      const recL0C = await levels.runL0(Object.assign({}, base, { name: 'l0c', codeOnly: true }));
      check('档位 L0C：level/codeOnly 写进记录，且与 L0 的 system 完全相同（唯一变量只有那段格式要求）',
        recL0.level === 'L0' && recL0C.level === 'L0C' && recL0C.codeOnly === true && !recL0.codeOnly
        && recL0.system === recL0C.system,
        JSON.stringify([recL0.level, recL0C.level, recL0C.codeOnly, recL0.system === recL0C.system]));
      check('档位 L0C：那段格式要求就是"只输出一个代码块"（与探针里那句同源）',
        /【格式硬要求】/.test(levels.CODE_ONLY) && levels.CODE_ONLY.indexOf('只输出一个代码块') >= 0);
      check('档位 L0C：两档在假模型下都抽得到代码（这条路本身跑得通）',
        !!recL0.code && !!recL0C.code, JSON.stringify([!!recL0.code, !!recL0C.code]));
      check('档位 L0C：记录里带 finishReason/truncated（撞长度上限要能与"答错"分开）',
        'finishReason' in recL0C && recL0C.truncated === false,
        JSON.stringify([recL0C.finishReason, recL0C.truncated]));
    }

    // ⑪ 工作台界面：rating 阶梯。index.html 里的 JS 以前没有任何测试覆盖，而"裸模 rating 上限"全靠它读。
    //     用假 DOM 把 <script> 真跑一遍，喂一份构造好的 state，断言阶梯把
    //     "答错" / "没跑完（中止、撞顶）" / "不可判（多解题、尺子坏了）" 分开 —— 这是读数的命门：
    //     把中止当成"不会做"，rating 上限就会被系统性低估。
    {
      const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
      const code = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
      let syntaxOk = false;
      try { new vm.Script(code); syntaxOk = true; } catch (e) { /* 下面报 */ }
      check('工作台：index.html 里的脚本能取到且语法通过', !!code && syntaxOk);
      check('工作台：四个档位勾选框 + 重复次数 + 单次超时控件都在，旧的 withL1 已清干净',
        ['lvL0', 'lvL0C', 'lvL1', 'lvL2', 'reps', 'timeout'].every((id) => html.indexOf('id="' + id + '"') >= 0)
        && html.indexOf('withL1') < 0);
      check('工作台：并发 / 重复方案 / 连判不了的一起跑 三个控件都在（跑不完的解法在调度上）',
        ['conc', 'plan', 'includeSkipped'].every((id) => html.indexOf('id="' + id + '"') >= 0)
        && /<select id="plan">[\s\S]*?value="sweep"[\s\S]*?value="ladder"/.test(html));
      check('工作台：题表里有"跳过这题"的勾选框（判不了的题要能一键剔掉）', html.indexOf('data-skip=') >= 0);
      check('工作台：并发进度显示的是"正在跑哪几道"，不是最后一条（否则看不出并发）',
        html.indexOf('activeJobs') >= 0 && html.indexOf('tickProgress') >= 0);

      const P = (id, rating) => ({ id, title: 'T' + id, rating, samples: [{}], hasOracle: true, hasGen: true, oracleLang: 'cpp' });
      const rec = (level, id, o) => Object.assign({ level, problem: id, model: 'mock', ok: true, hasCode: true, ms: 60000, cost: { amount: 0.1 } }, o || {});
      const state = {
        levels: ['L0', 'L0C', 'L1', 'L2'],
        levelHint: { L0: '裸模型', L0C: '裸模型·只给代码块', L1: '裸 agent', L2: 'cf-coach' },
        problems: [P('p800', 800), P('p1100', 1100), P('p2300', 2300), P('p2600', 2600), P('p2900', 2900)],
        records: [], verdicts: [], human: [], compare: null,
        defaults: { iterations: 60, lang: 'cpp', depth: 'L3', rich: false },
        root: 'smoke', targets: [{ providerId: 'mock', model: 'mock-gpt-4' }],
        job: null, appCache: { ids: [], dir: '' }, appDataDir: '', events: [],
        // L0：r800 AC → r1100 真答错 → r2300 撞长度上限 → r2600 单次调用中止（尺子还不可判）→ r2900 未跑
        // L0C：AC 到 r2300 为止 → r2600 真答错；r2900 未跑
        runs: [
          Object.assign(rec('L0', 'p800'), { usage: { completionTokens: 1200 } }),
          Object.assign(rec('L0', 'p1100'), { usage: { completionTokens: 2000 } }),
          Object.assign(rec('L0', 'p2300'), { ok: false, hasCode: false, truncated: true, usage: { completionTokens: 65536 } }),
          Object.assign(rec('L0', 'p2600'), { ok: false, hasCode: false, cost: null, usage: { completionTokens: 0 }, error: '单次模型调用超时（已到 12 分钟，中止 —— 这不是答错，是没跑完）' }),
          Object.assign(rec('L0C', 'p800'), { usage: { completionTokens: 900 } }),
          Object.assign(rec('L0C', 'p1100'), { usage: { completionTokens: 1000 } }),
          Object.assign(rec('L0C', 'p2300'), { usage: { completionTokens: 1500 } }),
          Object.assign(rec('L0C', 'p2600'), { usage: { completionTokens: 1800 } })
        ],
        verdicts: [
          { level: 'L0', problem: 'p800', diffVerdict: 'AC', sampleVerdict: 'AC' },
          { level: 'L0', problem: 'p1100', diffVerdict: 'WA', sampleVerdict: 'AC' },
          { level: 'L0', problem: 'p2300', diffVerdict: 'no-code', sampleVerdict: 'skipped' },
          { level: 'L0', problem: 'p2600', diffVerdict: 'unknown', diffUnreliable: true, sampleVerdict: 'skipped' },
          { level: 'L0C', problem: 'p800', diffVerdict: 'AC', sampleVerdict: 'AC' },
          { level: 'L0C', problem: 'p1100', diffVerdict: 'AC', sampleVerdict: 'AC' },
          { level: 'L0C', problem: 'p2300', diffVerdict: 'AC', sampleVerdict: 'AC' },
          { level: 'L0C', problem: 'p2600', diffVerdict: 'WA', sampleVerdict: 'AC' },
          // 判不了的一种：尺子自己就过不了官方样例（多解的另一种合法答案，或干脆贴错题）
          { level: 'L0', problem: 'p2900', diffVerdict: 'WA', sampleVerdict: 'special-judge', specialJudge: true, oracleSampleMismatch: true }
        ]
      };
      state.records = state.runs.map((r) => Object.assign({}, r, { cost: { amount: 0.1 } }));
      // 阶梯是**服务端**算的（ablation/lib/ladder.js 是唯一实现）—— 这里就喂真算出来的那份：
      // 于是这段同时守着"规则"和"渲染"，而不是守着一份界面里的抄件。
      state.ladder = ladderLib.compute({
        problems: state.problems, runs: state.runs, verdicts: state.verdicts,
        levels: state.levels, levelHint: state.levelHint
      });
      const rows = state.ladder.rows;
      const kindOf = (id, lv) => (rows.find((r) => r.id === id) || { cells: {} }).cells[lv].kind;
      check('阶梯规则：撞长度上限的 no-code 记"中止/撞顶"，不是"没交出来"（r2300）',
        kindOf('p2300', 'L0') === 'unfinished', kindOf('p2300', 'L0'));
      check('阶梯规则：不可判（尺子坏了）优先于一切，既不算 AC 也不算失败（r2600）',
        kindOf('p2600', 'L0') === 'unreliable', kindOf('p2600', 'L0'));
      check('阶梯规则：真答错才是 fail（r1100 的差分 WA）', kindOf('p1100', 'L0') === 'fail', kindOf('p1100', 'L0'));
      check('阶梯规则：没跑的题是 none（r2900 任何档都没跑）',
        ['L0', 'L0C'].every((lv) => kindOf('p2900', lv) === 'none'));
      check('阶梯规则：AC 只是下界 / 首次可信失败给上限（L0 下界 r800、上限 r1100）',
        (rows.find((r) => r.id === 'p800') || {}).cells.L0.kind === 'ac'
        && state.ladder.levels[0].acMax.rating === 800 && state.ladder.levels[0].failMin.rating === 1100,
        JSON.stringify([state.ladder.levels[0].acMax, state.ladder.levels[0].failMin]));
      // 有"正常跑完"的那次才谈得上可信失败：全部被中止/撞顶时，WA 也不作数。
      const onlyAborted = ladderLib.compute({
        problems: [{ id: 'x', rating: 2000 }],
        runs: [{ level: 'L0', problem: 'x', ok: false, hasCode: false, truncated: true, error: '' }],
        verdicts: [{ level: 'L0', problem: 'x', diffVerdict: 'WA' }], levels: ['L0']
      });
      check('阶梯规则：整题只跑出"中止/撞顶"时，即使差分 WA 也不算可信失败（否则上限被报低）',
        onlyAborted.levels[0].failMin === null && onlyAborted.levels[0].cells[0].kind === 'unfinished',
        JSON.stringify(onlyAborted.levels[0].cells));
      check('阶梯规则：缺 oracle/生成器记"缺尺子"，不能被读成"不会做"',
        ladderLib.compute({
          problems: [{ id: 'y', rating: 1500 }],
          runs: [{ level: 'L0', problem: 'y', ok: true, hasCode: true }],
          verdicts: [{ level: 'L0', problem: 'y', diffVerdict: 'no-gen' }], levels: ['L0']
        }).levels[0].cells[0].kind === 'noruler');
      check('阶梯规则：规则只在这一处实现（界面里不许再抄一份 cellState/CELL_TXT）',
        !/function cellState|CELL_TXT/.test(fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8')));

      const nodes = {};
      const mkEl = (id) => ({
        id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, dataset: {}, style: {},
        scrollTop: 0, scrollHeight: 0, classList: { add() {}, remove() {} },
        addEventListener() {}, close() {}, click() {}, insertAdjacentHTML() {}
      });
      const sandbox = {
        document: {
          getElementById: (id) => (nodes[id] = nodes[id] || mkEl(id)),
          createElement: () => mkEl('a'), querySelectorAll: () => [], querySelector: () => null,
          body: { appendChild() {} }
        },
        fetch: async () => ({ ok: true, json: async () => state }),
        EventSource: function () { return { onmessage: null }; },
        URL: { createObjectURL: () => 'blob:x' },
        console: { log() {}, warn() {}, error() {} }
      };
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox, { filename: 'ablation/ui/index.html' });
      await new Promise((r) => setTimeout(r, 40));   // 脚本尾部的 refresh() 是异步的
      const ladder = String((nodes.ceiling || {}).innerHTML || '');
      check('工作台：阶梯渲染出来了（state → 视图这条路是通的）',
        ladder.indexOf('<table class="ladder">') >= 0 && ladder.length > 200, 'len=' + ladder.length);
      check('工作台：行按 rating 升序（阶梯必须从下往上读）',
        ['p800', 'p1100', 'p2300', 'p2600', 'p2900'].every((id, i, arr) => i === 0 || ladder.indexOf(arr[i - 1]) < ladder.indexOf(id)));
      check('工作台：✓ AC / ✗ 差分 WA / 中止·撞顶 / 不可判 四种格子都分开了',
        ladder.indexOf('✓ AC') >= 0 && ladder.indexOf('✗ 差分 WA') >= 0
        && ladder.indexOf('中止/撞顶') >= 0 && ladder.indexOf('不可判') >= 0);
      const acMax = (ladder.match(/最高差分 AC：p\d+/g) || []).join('|');
      const failMin = (ladder.match(/首次可信失败：r\d+/g) || []).join('|');
      check('工作台：上限只由可信失败给出 —— L0 的首次失败是 r1100（真答错），中止(r2600)/撞顶(r2300) 都不算失败',
        acMax === '最高差分 AC：p800|最高差分 AC：p2300' && failMin === '首次可信失败：r1100|首次可信失败：r2600',
        JSON.stringify([acMax, failMin]));
      check('工作台：未跑的题显示"未跑"，并提示中止/撞顶不是答错',
        ladder.indexOf('未跑') >= 0 && ladder.indexOf('它们不是答错') >= 0);
      check('工作台：花费按 cost.amount 累加（cost 是对象，直接相加会变成字符串拼接），中止那次标"未计费"',
        /¥0\.2/.test(ladder) && ladder.indexOf('未计费') >= 0, (ladder.match(/¥[\d.]+/g) || []).slice(0, 4).join(','));
      check('工作台：输出 token 读的是 usage.completionTokens（记录里是 camelCase，读 snake_case 会恒为 0）',
        ladder.indexOf('输出 2,100 tok') >= 0, (ladder.match(/输出 [\d,]+ tok/g) || []).slice(0, 3).join(' | '));
      check('工作台：渲染没有把异常吞进日志（加载失败）', String((nodes.log || {}).innerHTML || '').indexOf('加载失败') < 0);
      const problemsHtml = String((nodes.problems || {}).innerHTML || '');
      check('工作台：判不了的题在题表里被点名（尺子与样例不符 → 提示核对 oracle），并带"跳过这题"开关',
        problemsHtml.indexOf('判不了：') >= 0 && problemsHtml.indexOf('核对 oracle') >= 0
        && problemsHtml.indexOf('data-skip="p2900"') >= 0
        && problemsHtml.indexOf('data-skip="p800"') >= 0,
        'len=' + problemsHtml.length);
    }

    // ⑫ 运行日志：测试在**别人机器**上跑，终端里滚过去的现场必须落盘，否则出问题时没有东西可发。
    {
      const logFile = path.join(tmp, 'server.log');
      const origLog = console.log;
      const rl = runlog.start(logFile, { banner: '工作台启动 v0.0.0-test' });
      console.log('第一行：普通日志');
      console.warn('第二行：警告');
      rl.stop();
      const text = fs.readFileSync(logFile, 'utf8');
      check('运行日志：启动横幅 + console.log/warn 都落盘（带时间戳与级别）',
        text.indexOf('工作台启动 v0.0.0-test') >= 0 && text.indexOf('第一行：普通日志') >= 0
        && text.indexOf('第二行：警告') >= 0 && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)
        && text.indexOf('[warn]') >= 0);
      check('运行日志：stop() 之后 console 被还原（不能把进程输出一直接管着不放）', console.log === origLog);
      check('运行日志：note() 能报出日志在哪、多大（界面要拿它告诉测试者发什么）',
        /server\.log/.test(rl.note()) && /(KB|MB|字节|B)/.test(rl.note()), rl.note());
      // 日志写不进去时必须只降级：日志不能变成新的故障点
      // （那条"写不进去"的提醒本来就是要打到屏幕上的，这里只是别让它污染自测输出）
      const notADir = path.join(tmp, 'plain.txt');
      fs.writeFileSync(notADir, 'x');
      const origWarn = console.warn;
      console.warn = () => {};
      const bad = runlog.start(path.join(notADir, 'sub', 'server.log'), { banner: 'x' });
      const badNote = bad.note();
      const badStopOk = (() => { try { bad.stop(); return true; } catch (e) { return false; } })();
      console.warn = origWarn;
      check('运行日志：目录建不出来时只降级（note() 如实说、stop() 不抛、屏幕照常）',
        badStopOk && /写不|不可|无法|失败/.test(badNote) && console.log === origLog, badNote);
      check('诊断包文件名是无依赖纯文本（测试者能直接贴聊天窗口，不用解压）',
        /^cfcoach-diag-\d{8}-\d{6}\.txt$/.test(diagbundle.defaultFileName()), diagbundle.defaultFileName());
    }

    // ⑬ 工作台端到端：真把 serve.js 起起来走一遍 HTTP。
    //     用户 m11748 要的是"日志打包功能方便发送" —— 所以这里直接断言 server.log 落盘、诊断包里带着它。
    {
      const freePort = await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
      });
      const uiRoot = path.join(tmp, 'ui-e2e');
      const child = spawn(process.execPath, [
        path.join(__dirname, 'serve.js'), '--port', String(freePort), '--root', uiRoot,
        '--base-url', mock.url, '--api-key', 'mock', '--model', 'mock-gpt-4'
      ], { stdio: 'ignore' });
      const base = 'http://127.0.0.1:' + freePort;
      let up = null;
      try {
        for (let i = 0; i < 120 && !up; i++) {
          try {
            const r = await fetch(base + '/api/state');
            if (r.ok) up = await r.json();
          } catch (e) { /* 还没起来 */ }
          if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        check('工作台端到端：serve.js 起得来，/api/state 给出 host / logFile / ladder',
          !!up && !!up.host && !!up.logFile && !!up.ladder && Array.isArray(up.ladder.rows));
        const serverLog = path.join(uiRoot, 'server.log');
        const logText = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8') : '';
        check('工作台端到端：终端输出真的落到 <数据目录>/server.log（屏幕上滚掉也还有）',
          logText.indexOf('工作台启动') >= 0, serverLog);

        const post = (p, body) => fetch(base + p, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
        const pr = await post('/api/problems', {
          id: 'e2e800', title: 'E2E', rating: 800, statement: '给两个数，输出和', samples: [{ input: '1\n', output: '1\n' }],
          oracleCode: oracleSrc, oracleLang: 'python'
        });
        check('工作台端到端：能往题库塞一道题（界面上的"加题"走的就是这条路）', pr.ok);
        await post('/api/run', { levels: ['L0', 'L0C'], reps: 2, callTimeoutMin: 1, iterations: 1, lang: 'python', conc: 2 });
        let done = null;
        for (let i = 0; i < 200 && !done; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const st = await (await fetch(base + '/api/state')).json();
          if (st.runs && st.runs.length >= 4) done = st;
        }
        const runs = (done || {}).runs || [];
        const reps = runs.map((r) => r.rep).sort().join(',');
        check('工作台端到端：L0 + L0C × 重复 2 次 = 4 条记录，rep 落进记录（同题多跑才看得到抖动）',
          runs.length === 4 && reps === '1,1,2,2' && runs.some((r) => r.level === 'L0C'),
          runs.length + ' 条 rep=' + reps);
        check('工作台端到端：阶梯随记录更新（跑过的题不再是"未跑"，裸模上限靠它读）',
          !!done && done.ladder.rows.length >= 1 && done.ladder.rows[0].cells.L0.kind !== 'none',
          done ? JSON.stringify(done.ladder.rows[0].cells.L0) : '服务没起来');

        // ④ 判不了的题默认不跑 + 阶梯式 reps（sweep = 全池先各 1 遍，与"重复次数"解耦）
        await post('/api/problems', {
          id: 'e2e1300', title: 'E2E-跳过', rating: 1300, statement: '给两个数，输出和',
          samples: [{ input: '1\n', output: '1\n' }], oracleCode: oracleSrc, oracleLang: 'python', skip: true
        });
        await post('/api/run', { levels: ['L0'], reps: 3, plan: 'sweep', iterations: 1, lang: 'python', conc: 2 });
        let swept = null;
        for (let i = 0; i < 200 && !swept; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const st = await (await fetch(base + '/api/state')).json();
          if (st.runs && st.runs.length >= 5 && (!st.job || !st.job.running)) swept = st;
        }
        const after = (swept || {}).runs || [];
        const l0Before = runs.filter((r) => r.problem === 'e2e800' && r.level === 'L0').length;
        const l0After = after.filter((r) => r.problem === 'e2e800' && r.level === 'L0').length;
        check('工作台端到端：标了跳过的题默认不进队列（判不了的题只烧钱不产数据）',
          after.length === 5 && !after.some((r) => r.problem === 'e2e1300'),
          after.length + ' 条，含 1300：' + after.some((r) => r.problem === 'e2e1300'));
        check('工作台端到端：重复方案 sweep = 全池先各跑 1 遍（不再受"重复次数 3"影响）',
          l0After === l0Before + 1, 'e2e800/L0 ' + l0Before + ' → ' + l0After);
        const logAll = fs.existsSync(path.join(uiRoot, 'server.log')) ? fs.readFileSync(path.join(uiRoot, 'server.log'), 'utf8') : '';
        check('工作台端到端：跳过与并发都写进日志（事后能从日志里复原调度）',
          logAll.indexOf('跳过') >= 0 && logAll.indexOf('并发 2') >= 0);
        await post('/api/run', { levels: ['L0'], plan: 'sweep', includeSkipped: true, iterations: 1, lang: 'python', conc: 2 });
        let forced = null;
        for (let i = 0; i < 200 && !forced; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const st = await (await fetch(base + '/api/state')).json();
          if (st.runs && st.runs.length >= 6 && (!st.job || !st.job.running)) forced = st;
        }
        check('工作台端到端：勾"连判不了的题一起跑"时还能强制跑（默认跳过不是硬拦）',
          !!forced && (forced.runs || []).some((r) => r.problem === 'e2e1300'));

        const dr = await fetch(base + '/api/diag/export');
        const dtext = await dr.text();
        const disp = dr.headers.get('content-disposition') || '';
        check('工作台端到端：诊断包里带着运行日志 / rating 阶梯 / 跑分明细（含 rep）',
          dtext.indexOf('工作台运行日志') >= 0 && dtext.indexOf('rating 阶梯') >= 0
          && dtext.indexOf('跑分明细') >= 0 && dtext.indexOf('rep=') >= 0);
        check('工作台端到端：诊断包里写明是**哪台机器**（多机同时测时能分清谁发的）',
          dtext.indexOf('机器：' + os.hostname()) >= 0, 'host=' + os.hostname());
        check('工作台端到端：下载文件名也带机器名',
          disp.indexOf(os.hostname()) >= 0, disp);
        // 界面的回执要用这个正则数"含几段" —— 分隔符格式变了而正则没跟着改，回执就会说"含 0 段"
        const sections = (dtext.match(/^#+ .+? #+$/gm) || []);
        check('工作台端到端：诊断包的段落分隔与界面回执的正则对得上（回执要能数出段数）',
          sections.length >= 5, sections.length + ' 段');
      } catch (e) {
        check('工作台端到端：整个过程没有抛异常', false, (e && e.stack) || String(e));
      } finally {
        try { child.kill(); } catch (e) { /* 已经退了 */ }
      }
    }

    // ⑨ 记录与汇总
    run.writeSummary({ selftest: true });
    const lines = fs.readFileSync(run.recordsFile, 'utf8').split('\n').filter(Boolean);
    check('records.jsonl 每条跑分一行（L0/L1/L1 兜底/L2/错解 L2/错解 L0 = 6 行）', lines.length === 6, 'lines=' + lines.length);
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
