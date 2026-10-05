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
const l2 = require('./lib/l2');
const compareLib = require('./lib/compare');
const cffetch = require('./lib/cffetch');
const mkgen = require('./lib/mkgen');
const uistore = require('./lib/uistore');
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
