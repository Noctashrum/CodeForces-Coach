/**
 * test-harness.js — 教练对拍 harness 单元测试（工作区 / 运行器）
 * 用法：node scripts/test-harness.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const workspace = require('../lib/workspace.js');
const runner = require('../lib/runner.js');
const harness = require('../lib/harness.js');
const agentloop = require('../lib/agentloop.js');
const cf = require('../lib/cf.js');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

async function main() {
  /* ---------- 0. I/O 契约抽取与代码提取（多 Agent 的共享契约层） ---------- */
  console.log('\n== 0. 契约抽取 / 代码提取 ==');
  {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'cf-2264D-raw.html'), 'utf8');
    const parsed = cf.parseProblemPage(raw, 2264, 'D');
    const c = harness.extractContract(parsed.statement);
    check('契约：抽出输入格式段', c.inputSpec.indexOf('test cases') >= 0 && c.inputSpec.length > 80, c.inputSpec.slice(0, 60));
    check('契约：抽出输出格式段', /binary string/.test(c.outputSpec), c.outputSpec.slice(0, 60));
    check('契约：输入段不吞掉输出段（否则生成器会看到输出描述）',
      c.inputSpec.indexOf('binary string') < 0, c.inputSpec.slice(-60));
    check('契约：抽出数据保证', c.guarantees.length >= 1, c.guarantees);
    check('契约：生成器版只含输入侧（不夹带输出描述与样例）',
      harness.contractBlock(c, false).indexOf('binary string') < 0
      && harness.contractBlock(c, false).indexOf('样例') < 0, harness.contractBlock(c, false).slice(0, 80));
    check('契约：题解/暴力版带输出格式（它们必须对齐输出格式）',
      harness.contractBlock(c, true).indexOf('binary string') >= 0);

    const fenced = harness.extractCode('先讲思路。\n\n```python\nprint(1)\n```\n\n完了');
    check('提取围栏代码', fenced.code.indexOf('print(1)') >= 0 && fenced.code.indexOf('```') < 0, fenced.code);
    const multi = harness.extractCode('```cpp\nint main(){return 0;}\n```\n\n```cpp\nint main(){int n;return 0;}\n```');
    check('多个代码块取最大', multi.code.indexOf('int n') >= 0, multi.code.slice(0, 40));
    check('没有代码时返回空', harness.extractCode('只有文字说明').code === '');

    const userMsg = '【Codeforces 1800C】C. Powering the Hero\n难度：1500 分 · 标签：greedy\n\n牌堆问题……\n\n```python\nimport sys\nprint(0)\n```';
    const code = harness.extractUserCode(userMsg);
    const stmt = harness.cleanUserStatement(userMsg);
    check('用户消息：提取代码块', code.indexOf('print(0)') >= 0, code);
    check('用户消息：清掉界面模板头', stmt.indexOf('【Codeforces') < 0 && stmt.indexOf('难度：') < 0, stmt.slice(0, 40));
    check('用户消息：题面里去掉代码', stmt.indexOf('print(0)') < 0, stmt.slice(0, 40));
    check('等级映射：hint→L1 / full→L3', harness.levelForIntent('hint') === 'L1' && harness.levelForIntent('full') === 'L3');
    check('轨迹摘要可读', harness.summarizeTrajectory([{ kind: 'mismatch', note: '第 3 组', input: '1\n1\n0', expected: '6', actual: '0' }]).indexOf('反例输入') >= 0);

    // CF 桌面版/移动版：我们只请求桌面版，且拒绝解析移动版页面
    check('CF：抓取 URL 自动补 mobile=false', cf.desktopUrl('https://codeforces.com/contests/with/x') === 'https://codeforces.com/contests/with/x?mobile=false',
      cf.desktopUrl('https://codeforces.com/contests/with/x'));
    check('CF：已有 mobile 参数会被改成 false', cf.desktopUrl('https://codeforces.com/x?mobile=true&a=1') === 'https://codeforces.com/x?mobile=false&a=1',
      cf.desktopUrl('https://codeforces.com/x?mobile=true&a=1'));
    check('CF：识别 m1/m2 移动版主机', cf.looksMobile('<html></html>', 'https://m1.codeforces.com/') === true);
    check('CF：识别移动版布局（有 Desktop version 且无桌面外壳）',
      cf.looksMobile('<html><body><a href="?mobile=false">Desktop version</a><table></table></body></html>', 'https://codeforces.com/') === true);
    check('CF：桌面题面页不被误判为移动版',
      cf.looksMobile('<html><body><div id="pageContent"><div class="problem-statement"><div class="header">', 'https://codeforces.com/') === false);
  }

  /* ---------- 1. 每题工作区 ---------- */
  console.log('\n== 1. 每题工作区（缓冲区） ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    workspace.setRoot(tmp);
    const convId = 'c_test1';
    const w = workspace.writeFile(convId, 'sol.cpp', 'int main(){return 0;}');
    check('写入题解', w.name === 'sol.cpp' && w.lang === 'cpp' && w.lines === 1, w);
    workspace.writeFile(convId, 'brute.cpp', 'int main(){return 0;}');
    workspace.writeFile(convId, 'gen.py', 'print(1)');
    check('列出文件', workspace.listFiles(convId).length === 3, workspace.listFiles(convId).map((f) => f.name));
    check('读取文件', workspace.readFile(convId, 'sol.cpp').indexOf('int main') >= 0);
    let rejected = false;
    try { workspace.writeFile(convId, '../escape.cpp', 'x'); } catch (e) { rejected = true; }
    check('拒绝目录穿越', rejected);
    let rejected2 = false;
    try { workspace.writeFile(convId, 'evil.exe', 'x'); } catch (e) { rejected2 = true; }
    check('拒绝非法后缀', rejected2);
    const cleared = workspace.clearScratch(convId);
    const left = workspace.listFiles(convId).map((f) => f.name);
    check('清理临时区（保留题解）', cleared.removed.indexOf('brute.cpp') >= 0 && cleared.removed.indexOf('gen.py') >= 0
      && left.indexOf('sol.cpp') >= 0 && left.indexOf('brute.cpp') < 0, { removed: cleared.removed, left });
    workspace.recordVerification(convId, { verdict: 'mismatch', input: '3\n1 2 3\n' });
    check('反例落盘 fail.txt', (workspace.readFile(convId, 'fail.txt') || '').indexOf('1 2 3') >= 0);
    const s = workspace.summary(convId);
    check('summary 反映状态', s.hasSol === true && s.hasBrute === false && s.verification && s.verification.verdict === 'mismatch', s.verification);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------- 2. 运行器：文件式样例 + 完整对拍 ---------- */
  console.log('\n== 2. 运行器文件式 harness ==');
  {
    const runtimes = await runner.availableRuntimes();
    check('本机有 Python 运行时', runtimes.python === true, runtimes);
    if (runtimes.python && runtimes.cpp) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
      workspace.setRoot(tmp);
      const convId = 'c_test2';
      // 题解：求和
      workspace.writeFile(convId, 'sol.cpp', [
        '#include <bits/stdc++.h>',
        'int main(){int t;scanf("%d",&t);while(t--){int n;scanf("%d",&n);long long s=0,x;for(int i=0;i<n;i++){scanf("%lld",&x);s+=x;}printf("%lld\\n",s);}return 0;}'
      ].join('\n'));
      // 暴力：求和（作为标尺）
      workspace.writeFile(convId, 'brute.cpp', [
        '#include <bits/stdc++.h>',
        'int main(){int t;scanf("%d",&t);while(t--){int n;scanf("%d",&n);std::vector<long long> a(n);for(auto &v:a)scanf("%lld",&v);long long s=0;for(int i=0;i<n;i++)for(int j=i;j<=i;j++)s+=a[j];printf("%lld\\n",s);}return 0;}'
      ].join('\n'));
      // 生成器：随机小数据
      workspace.writeFile(convId, 'gen.py', [
        'import random',
        'n = random.randint(1, 6)',
        'print(1)',
        'print(n)',
        'print(*[random.randint(0, 20) for _ in range(n)])'
      ].join('\n'));
      const samples = [{ input: '1\n3\n1 2 3', output: '6' }];

      const okRun = await runner.stressByFiles({
        solFile: workspace.filePath(convId, 'sol.cpp'),
        bruteFile: workspace.filePath(convId, 'brute.cpp'),
        genFile: workspace.filePath(convId, 'gen.py'),
        solLang: 'cpp', bruteLang: 'cpp', genLang: 'python',
        samples, iterations: 25
      });
      check('对拍：暴力先过样例并全部通过', okRun.status === 'ok' && okRun.iterations === 25
        && okRun.bruteSamples && okRun.bruteSamples.allPass === true, okRun);

      // 题解改成错的 → 应该抓到反例
      workspace.writeFile(convId, 'sol.cpp', [
        '#include <bits/stdc++.h>',
        'int main(){int t;scanf("%d",&t);while(t--){int n;scanf("%d",&n);long long s=0,x;for(int i=0;i<n;i++){scanf("%lld",&x);s+=x;}printf("%lld\\n",s+1);}return 0;}'
      ].join('\n'));
      const badRun = await runner.stressByFiles({
        solFile: workspace.filePath(convId, 'sol.cpp'),
        bruteFile: workspace.filePath(convId, 'brute.cpp'),
        genFile: workspace.filePath(convId, 'gen.py'),
        solLang: 'cpp', bruteLang: 'cpp', genLang: 'python',
        samples: [], iterations: 10
      });
      check('对拍：错误题解被抓出反例', badRun.status === 'mismatch' && !!badRun.input && badRun.expected !== badRun.actual, badRun);

      // 暴力解本身不过样例 → 拒绝开始对拍
      workspace.writeFile(convId, 'brute.cpp', [
        '#include <bits/stdc++.h>',
        'int main(){printf("0\\n");return 0;}'
      ].join('\n'));
      const bruteBad = await runner.stressByFiles({
        solFile: workspace.filePath(convId, 'sol.cpp'),
        bruteFile: workspace.filePath(convId, 'brute.cpp'),
        genFile: workspace.filePath(convId, 'gen.py'),
        solLang: 'cpp', bruteLang: 'cpp', genLang: 'python',
        samples, iterations: 10
      });
      check('对拍：暴力未过样例时拒绝开测', bruteBad.status === 'brute-failed' && bruteBad.stage === 'brute-samples', bruteBad);

      /* ---------- 3. 常驻竞技场：规模阶梯 + 反例最小化 ---------- */
      console.log('\n== 3. 竞技场（一次编译多次跑）/ 最小化反例 ==');
      workspace.writeFile(convId, 'brute.cpp', [
        '#include <bits/stdc++.h>',
        'int main(){int t;scanf("%d",&t);while(t--){int n;scanf("%d",&n);std::vector<long long> a(n);for(auto &v:a)scanf("%lld",&v);long long s=0;for(int i=0;i<n;i++)s+=a[i];printf("%lld\\n",s);}return 0;}'
      ].join('\n'));
      workspace.writeFile(convId, 'sol.cpp', [
        '#include <bits/stdc++.h>',
        'int main(){int t;scanf("%d",&t);while(t--){int n;scanf("%d",&n);long long s=0,x;for(int i=0;i<n;i++){scanf("%lld",&x);s+=x;}printf("%lld\\n",s+1);}return 0;}'
      ].join('\n'));
      const arena = await runner.openArena({
        sol: { lang: 'cpp', code: workspace.readFile(convId, 'sol.cpp') },
        brute: { lang: 'cpp', code: workspace.readFile(convId, 'brute.cpp') },
        gen: { lang: 'python', code: workspace.readFile(convId, 'gen.py') }
      });
      check('竞技场就绪', arena.ok === true, arena.error);
      // 生成器按 argv[1] 接收规模档（尺度协商交给运行器，不交给 agent）
      workspace.writeFile(convId, 'gen_ladder.py', [
        'import random, sys',
        'maxN = int(sys.argv[1]) if len(sys.argv) > 1 else 8',
        'n = random.randint(1, max(1, maxN))',
        'print(1)',
        'print(n)',
        'print(*[random.randint(0, 20) for _ in range(n)])'
      ].join('\n'));
      const arenaLadder = await runner.openArena({
        sol: { lang: 'cpp', code: workspace.readFile(convId, 'brute.cpp') },
        gen: { lang: 'python', code: workspace.readFile(convId, 'gen_ladder.py') }
      });
      const case1 = await arenaLadder.genCase(1);
      const n1 = parseInt(case1.input.replace(/\r/g, '').trim().split('\n')[1], 10);
      const case9 = await arenaLadder.genCase(9);
      const n9 = parseInt(case9.input.replace(/\r/g, '').trim().split('\n')[1], 10);
      check('生成器按 argv 收到规模档', case1.ok && n1 === 1 && n9 >= 1 && n9 <= 9, { n1, n9, raw: case1.input });
      arenaLadder.close();
      const cmp = await arena.compare('1\n1\n5\n', 'sol', 'brute');
      check('竞技场比对：能识别不一致', cmp.same === false && cmp.a.output.trim() === '6' && cmp.b.output.trim() === '5', cmp);
      const mini = await arena.minimize('1\n3\n1 2 3\n', 'sol', 'brute');
      check('反例最小化收敛', mini.ok === true && mini.minimalLength <= mini.originalLength, mini);
      /**
       * ⚠️ 回归（2026-10 事故）：尺子崩了/超时**不算反例**。
       * 旧版 isBad 只看 `!same`，于是"尺子崩溃"也被当成触发点 → 最小化器会为了保持崩溃
       * 一路删输入，最后交付一条连题目都读不进去的假反例（实测 n=20 只剩 14 个数）。
       */
      const arenaCrash = await runner.openArena({
        sol: { lang: 'python', code: 'import sys\nd = list(map(int, sys.stdin.read().split()))\nprint(sum(d[1:]))' },
        brute: { lang: 'python', code: 'import sys\nd = list(map(int, sys.stdin.read().split()))\nassert len(d) <= 3, "too many"\nprint(sum(d[1:]))' }
      });
      const cmpCrash = await arenaCrash.compare('3\n1 2 3 4\n', 'sol', 'brute');
      check('尺子崩了要如实标成 b.ok=false（而不能当成"不一致"）', cmpCrash.same === false && cmpCrash.b.ok === false, cmpCrash);
      const miniCrash = await arenaCrash.minimize('3\n1 2 3 4\n', 'sol', 'brute');
      check('尺子崩掉的输入不许被最小化成反例', miniCrash.ok === false, miniCrash);
      arenaCrash.close();
      await arena.update('sol', { lang: 'cpp', code: workspace.readFile(convId, 'brute.cpp') });
      const cmp2 = await arena.compare('1\n2\n3 4\n', 'sol', 'brute');
      check('竞技场可单独替换题解', cmp2.same === true, cmp2);
      arena.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    } else {
      console.log('  （跳过：本机缺少 g++ 或 python）');
    }
  }

  /* ---------- 4. 第一层体检（编译 / 语法 / UB） ---------- */
  console.log('\n== 4. 代码体检层 ==');
  {
    const pyOk = await runner.sanitizeCheck({
      lang: 'python', code: 'import sys\nd = sys.stdin.read().split()\nprint(int(d[0]) + 1)', samples: [{ input: '1', output: '2' }]
    });
    check('体检：Python 正常代码通过', pyOk.available === true && pyOk.findings.length === 0, pyOk);

    const pyBad = await runner.sanitizeCheck({ lang: 'python', code: 'def f(:\n  pass', samples: [] });
    check('体检：Python 语法错误被抓出', pyBad.findings.some((f) => f.kind === 'compile-error'), pyBad);

    const jsBad = await runner.sanitizeCheck({ lang: 'js', code: 'function ( {', samples: [] });
    check('体检：JS 语法错误被抓出', jsBad.findings.some((f) => f.kind === 'compile-error'), jsBad);

    const cppUb = await runner.sanitizeCheck({
      lang: 'cpp',
      code: '#include <bits/stdc++.h>\nint main(){int a[2];a[5]=1;printf("%d\\n",a[5]);return 0;}',
      samples: [{ input: '', output: '1' }]
    });
    check('体检：C++ UB（数组越界）被抓出或本机不支持 UBSan',
      cppUb.available === false || cppUb.findings.some((f) => f.kind === 'ub'), cppUb);
  }

  /* ---------- 5. 熔断预算 / 追问路由 / 诚实降级提示词 ---------- */
  console.log('\n== 5. 熔断预算与路由 ==');
  {
    // 预算：**难度分档 + 特征检测**（2026-10 二次修正）。历史分两层：
    // ① 原来"任何难度都封顶 3 轮 / 20 分钟 / 40 次"，另一台机器的 19 轮真实数据显示 2000+ 的题
    //    被天花板卡死（8 轮正好停在 12 步、多次撞墙钟），用户要求"题目难，超预算是正常的"。
    // ② 用户复盘指出更根本的问题：**上限在教模型作弊**（预算一紧，最优策略就变成打表 / 交最笨版本 /
    //    正文写短），正确的停手条件是"死循环特征"（lib/loopguard.js）而不是掐表 → 数值整体再放宽一档。
    // 纪律：分档**只放宽不收紧**（低难度档也从 3 轮/20 分钟/40 次放宽到 4 轮/25 分钟/50 次）。
    check('预算：修正轮数按难度分档封顶（低难度 4 / 2000+ 5 / 2400+ 6 / 2800+ 8）',
      harness.solFixBudget(1500) === 4 && harness.solFixBudget(2000) === 5
      && harness.solFixBudget(2500) === 6 && harness.solFixBudget(3200) === 8,
      [harness.solFixBudget(1500), harness.solFixBudget(2000), harness.solFixBudget(2500), harness.solFixBudget(3200)]);
    const b = harness.makeBudget(1500);
    check('预算：低难度档也放宽（50 次调用 / 25 分钟），deadline 已设',
      b.maxAgentCalls === 50 && b.maxWallMs === 25 * 60 * 1000 && b.deadline > Date.now(), b);
    const b2000 = harness.makeBudget(2100);
    const b2400 = harness.makeBudget(2400);
    const b2800 = harness.makeBudget(2800);
    check('预算：难度越高越宽（2000+ 80 次/40 分钟、2400+ 100 次/55 分钟、2800+ 130 次/70 分钟）',
      b2000.maxAgentCalls === 80 && b2000.maxWallMs === 40 * 60 * 1000
      && b2400.maxAgentCalls === 100 && b2400.maxWallMs === 55 * 60 * 1000
      && b2800.maxAgentCalls === 130 && b2800.maxWallMs === 70 * 60 * 1000,
      [b2000.maxAgentCalls, b2400.maxAgentCalls, b2800.maxAgentCalls]);
    check('预算：暴力解重写次数只是兜底（给完"最笨版本"还有一次机会 → maxBruteFix 2）',
      harness.makeBudget(1500).maxBruteFix === 2, { maxBruteFix: harness.makeBudget(1500).maxBruteFix });
    check('预算：对拍规模/运行时限也按难度放宽（2400+ 50 组/210 秒/10 秒；低难度 30 组/90 秒/5 秒）',
      b2400.tier === 3 && harness.stressBudget(2400).perTier === 50
      && harness.stressBudget(2400).maxStressMs === 210000 && harness.stressBudget(2400).runTimeLimitMs === 10000
      && harness.stressBudget(1200).perTier === 30 && harness.stressBudget(1200).maxStressMs === 90000
      && harness.stressBudget(1200).runTimeLimitMs === 5000,
      [harness.stressBudget(2400), harness.stressBudget(1200)]);
    check('预算：教练工具循环步数只是兜底（1500 → 20 步；2000+ 32；2400+ 40；2800+ 48）',
      agentloop.stepsForRating(1500) === 20 && agentloop.stepsForRating(2000) === 32
      && agentloop.stepsForRating(2400) === 40 && agentloop.stepsForRating(2800) === 48
      && agentloop.DEFAULT_MAX_STEPS === 20,
      [agentloop.stepsForRating(1500), agentloop.stepsForRating(2000), agentloop.stepsForRating(2400), agentloop.stepsForRating(2800)]);

    const stub = (text) => async () => text;
    const rExplain = await harness.routeFollowUp({ callAgent: stub('{"mode":"explain","reason":"问某行"}'), hasVerified: true, question: '第 12 行为什么这么写' });
    check('路由：解释型追问 → 不重跑链路', rExplain.mode === 'explain', rExplain);
    const rIdea = await harness.routeFollowUp({ callAgent: stub('```json\n{"mode":"debug","reason":"针对具体做法"}\n```'), hasVerified: true, question: '用 Floyd 能写吗' });
    check('路由：针对具体做法/代码 → 代码评估', rIdea.mode === 'debug', rIdea);
    const rOldIdea = await harness.routeFollowUp({ callAgent: stub('{"mode":"idea","reason":"旧档位"}'), hasVerified: true, question: 'x' });
    check('路由：已合并的旧档位（idea）不再被接受 → 保守重跑', rOldIdea.mode === 'chain', rOldIdea);
    const rGarbage = await harness.routeFollowUp({ callAgent: stub('我判断不了'), hasVerified: true, question: '随便问问' });
    check('路由：判断失败时保守重跑（不省验证）', rGarbage.mode === 'chain', rGarbage);
    const rNone = await harness.routeFollowUp({ callAgent: stub('{"mode":"explain"}'), hasVerified: false, question: 'x' });
    check('路由：本题没验证过 → 必须跑链路', rNone.mode === 'chain', rNone);

    const iYes = await harness.checkIdea({ callAgent: stub('{"viable":true,"approach":"floyd 后统计","reason":"范围小","complexity":"O(n^3)"}'), statement: 'x' });
    check('做法评估：可行 → 带做法描述', iYes.viable === true && iYes.approach.length > 0, iYes);
    const iNo = await harness.checkIdea({ callAgent: stub('{"viable":false,"reason":"会超时"}'), statement: 'x' });
    check('做法评估：不可行 → 带理由', iNo.viable === false && iNo.reason.length > 0, iNo);
    const iBad = await harness.checkIdea({ callAgent: stub('???'), statement: 'x' });
    check('做法评估：判断失败按可行处理（仍去实际验证）', iBad.viable === true, iBad);
    check('讲解提示词：代码评估按"代码审查"骨架讲（根因→实测对比→修正代码）',
      (() => {
        const s = harness.explainerSystem('debug', 'cpp', false, 'L3', { status: 'ok' });
        return s.indexOf('第一句就是根因') >= 0 && s.indexOf('拿实测证据说话') >= 0
          && s.indexOf('修正代码') >= 0 && s.indexOf('最小反例手算') >= 0;
      })());

    const sysOk = harness.explainerSystem('full', 'python', false, 'L3', { status: 'ok' });
    check('讲解提示词：验证通过时不带降级要求', sysOk.indexOf('诚实降级') < 0 && sysOk.indexOf('L3') >= 0);
    const sysFail = harness.explainerSystem('full', 'python', false, 'L3', { status: 'unverified', reason: '4 轮不一致' });
    check('讲解提示词：验证未通过 → 强制诚实降级', sysFail.indexOf('诚实降级') >= 0
      && sysFail.indexOf('我没有把握') >= 0 && sysFail.indexOf('绝对禁止') >= 0, sysFail.slice(0, 80));
    check('讲解提示词：题面按数据对待（防注入）', sysOk.indexOf('属于**数据**') >= 0, sysOk.indexOf('属于**数据**'));

    /* ---------- 5b. 样例隔离：暴力 Agent 看不见官方样例（用户建议的核心防线） ---------- */
    // 理由：暴力解是"标尺"，标尺若是照着样例答案凑出来的，整条验证链就废了。
    // 看不见样例 = 从源头上没有"打表"这个选项，比事后扫描拦截更彻底。
    const pastedStatement = [
      '给一个长度为 n 的数组 a，求最小值。',
      '',
      '输入格式',
      '第一行一个整数 n。',
      '第二行 n 个整数 a_i。',
      '',
      '输出格式',
      '输出一个整数表示最小值。',
      '',
      '样例输入',
      '5',
      '4 2 9 7 3',
      '',
      '样例输出',
      '2',
      '',
      '说明',
      '取最小的那个数即可。'
    ].join('\n');
    const stripped = harness.statementWithoutSamples(pastedStatement);
    check('样例隔离：粘贴题面里的样例段被剥掉', stripped.stripped === true
      && stripped.text.indexOf('4 2 9 7 3') < 0 && stripped.text.indexOf('样例输出') < 0, stripped.text.slice(-60));
    check('样例隔离：输入/输出格式段必须保留（暴力解要靠它对齐格式）',
      stripped.text.indexOf('输入格式') >= 0 && stripped.text.indexOf('输出格式') >= 0);

    // 契约切片绝不能吞掉样例段（真实漏洞：样例答案漏进契约 → 生成器与暴力解都看到了答案）
    const pastedContract = harness.extractContract(pastedStatement);
    check('样例隔离：契约的输入段不含样例数据，也不吞掉输出段',
      pastedContract.inputSpec.indexOf('4 2 9 7 3') < 0 && pastedContract.inputSpec.indexOf('样例') < 0
      && pastedContract.inputSpec.indexOf('输出格式') < 0, pastedContract.inputSpec);
    check('样例隔离：契约的输出段也止步于样例段',
      pastedContract.outputSpec.indexOf('4 2 9 7 3') < 0 && pastedContract.outputSpec.indexOf('样例') < 0,
      pastedContract.outputSpec);

    // 常见写法都要认得（CF 中文站 / 粘贴自各种来源）
    const variants = [
      ['样例输入\n1\n7\n\n样例输出\n7', '样例输入'],
      ['Sample Input 1\n1 2\n\nSample Output 1\n3', 'Sample Input 1'],
      ['输入样例\n2\n5\n\n输出样例\n5', '输入样例'],
      ['Example 1\n3\n1 1 1\n\nExample 2\n4\n1 1 1 1', 'Example 1'],
      ['Examples\n1\n9', 'Examples']
    ];
    variants.forEach(([tail, label]) => {
      const body = '求和。\n\n输入格式\n第一行 n。\n\n输出格式\n输出和。\n\n' + tail;
      const r = harness.statementWithoutSamples(body);
      check('样例隔离：认得「' + label + '」这种样例段写法',
        r.stripped === true && r.text.indexOf('输出和。') >= 0
        && r.text.indexOf('样例输出') < 0 && r.text.indexOf('Sample Output') < 0, r.text.slice(-40));
    });

    const brutePrompt = harness.buildBruteUser({
      statement: pastedStatement,
      samples: [{ input: '5\n4 2 9 7 3', output: '2' }, { input: '1\n42', output: '42' }],
      conv: { title: '自定义题目' }
    }, harness.extractContract(pastedStatement));
    check('样例隔离：暴力解的首轮提示词里没有任何样例数据/答案',
      brutePrompt.indexOf('4 2 9 7 3') < 0 && brutePrompt.indexOf('样例 1') < 0
      && brutePrompt.indexOf('ground truth') < 0, brutePrompt.slice(0, 200));
    check('样例隔离：但明确告诉它"拿不到样例"以及为什么',
      brutePrompt.indexOf('你看不到官方样例（刻意隔离）') >= 0 && brutePrompt.indexOf('不需要"对上样例"') >= 0);
    check('样例隔离：输出格式契约仍下发给暴力解', brutePrompt.indexOf('输出一个整数表示最小值') >= 0);
    check('样例隔离：暴力解系统提示词也说明样例是刻意不给的（且禁写死答案）',
      harness.bruteSystem('python').indexOf('官方样例刻意不给你') >= 0
      && harness.bruteSystem('python').indexOf('禁止】写死任何样例答案') >= 0);
    // 暴力解提示词必须**精简**：它的唯一目标是把题意直译成正确的枚举，
    // 塞复杂度/优化/隔离理由等无关信息只会稀释注意力（实测：暴力解反而比题解更慢更易错）
    const bs = harness.bruteSystem('python');
    check('暴力解提示词精简（< 700 字，且明确"不要讨论/优化复杂度"）',
      bs.length < 700 && bs.indexOf('不要】讨论或优化复杂度') >= 0, bs.length);
    check('暴力解提示词说明"数值由生成器控制在小范围"（并禁止按数值穷举）',
      bs.indexOf('生成器会把数值控制在小范围') >= 0 && bs.indexOf('绝不要按数值的取值范围去开数组或搜状态') >= 0, bs.slice(0, 400));
    check('生成器提示词带上数值上限约定，并警告"字符串字段别当数字改"（真实事故：00100010 → 16）',
      harness.genSystem().indexOf('sys.argv[2]') >= 0 && harness.genSystem().indexOf('原样输出字符串') >= 0,
      harness.genSystem().slice(0, 200));
    // 校准失败后的重写才会给样例——并且明令只许改逻辑
    const bruteRetry = harness.buildBruteUser({
      statement: pastedStatement,
      conv: { title: 'x' }
    }, harness.extractContract(pastedStatement), {
      retry: true, prevCode: 'print(0)', sampleReport: [{ index: 1, verdict: 'WA', input: '5\n4 2 9 7 3', expected: '2', actual: '0' }]
    });
    check('样例隔离：校准失败后的重写才给样例，且允许对齐格式但禁止写死答案',
      bruteRetry.indexOf('4 2 9 7 3') >= 0 && bruteRetry.indexOf('严禁把上面任何一个样例答案写进代码') >= 0
      && bruteRetry.indexOf('修正**算法与输出格式**') >= 0);
    check('样例隔离：题解 Agent 仍然拿到样例（它要保证输出格式与交付质量）',
      harness.buildSolutionUser({ statement: pastedStatement, samples: [{ input: '5\n4 2 9 7 3', output: '2' }], conv: {} },
        harness.extractContract(pastedStatement)).indexOf('4 2 9 7 3') >= 0);
    check('样例隔离：生成器本来就只看输入契约（不含样例数据/答案）',
      harness.buildGenUser(pastedContract).indexOf('4 2 9 7 3') < 0
      && harness.buildGenUser(pastedContract).indexOf('样例') < 0
      && harness.buildGenUser(pastedContract).indexOf('第一行一个整数 n') >= 0);

    // 同题缓存往返（暴力解/生成器在清理后仍可复用）
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
    workspace.setRoot(tmp2);
    workspace.writeFile('cf-1800C', 'sol.py', 'print(1)');
    workspace.cacheVerified('cf-1800C', { 'brute.py': 'print(2)', 'gen.py': 'print(3)' });
    workspace.clearScratch('cf-1800C', ['sol', 'meta.json']);
    check('同题缓存：清理临时区后仍能读回暴力解', workspace.readCache('cf-1800C', 'brute.py').indexOf('print(2)') >= 0);
    check('同题缓存：清理后缓冲区里没有暴力解', workspace.listFiles('cf-1800C').every((f) => f.name !== 'brute.py'));
    check('同题缓存：缓存目录独立可见', workspace.listCache('cf-1800C').some((f) => f.name === 'gen.py'), workspace.listCache('cf-1800C'));
    fs.rmSync(tmp2, { recursive: true, force: true });
  }

  /* ---------- 6. 代码沙箱接线（真的在拦 + 开关生效） ---------- */
  console.log('\n== 6. 代码沙箱 ==');
  {
    const outside = path.join(__dirname, '..', 'package.json').replace(/\\/g, '/');
    const st = runner.sandboxStatus();
    check('沙箱：Python/Node 守卫可用', st.python === true && st.js === true, st);
    check('沙箱：如实标注 C++ 无法限制', st.cpp === false);

    const rRead = await runner.runSamples({
      lang: 'python', code: 'print(open("' + outside + '").read()[:10])', samples: [{ input: '', output: 'x' }]
    });
    check('沙箱：Python 越权读被拦截', rRead.results[0].verdict === 'RE'
      && (/sitecustomize|PermissionError/.test(rRead.results[0].err || '') || /沙箱/.test(rRead.results[0].err || '')),
      rRead.results[0]);

    const rInside = await runner.runSamples({
      lang: 'python', code: 'open("ok.txt","w").write("hi"); print(open("ok.txt").read().strip())', samples: [{ input: '', output: 'hi' }]
    });
    check('沙箱：沙箱目录内读写正常（不误伤）', rInside.allPass === true, rInside.results[0]);

    const rNet = await runner.runSamples({
      lang: 'js', code: 'try { require("net").connect(80, "example.com"); console.log("OPEN"); } catch (e) { console.log("blocked"); }',
      samples: [{ input: '', output: 'blocked' }]
    });
    check('沙箱：Node 网络访问被拦截', rNet.allPass === true, rNet.results[0]);

    const rCalc = await runner.runSamples({
      lang: 'python', code: 'import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))', samples: [{ input: '1 2 3', output: '6' }]
    });
    check('沙箱：正常解题代码不受影响', rCalc.allPass === true, rCalc.results[0]);

    // 关掉开关 → 放开（证明设置真的生效，不是摆设）
    runner.setSandbox({ enabled: false });
    const rOff = await runner.runSamples({
      lang: 'python', code: 'print(open("' + outside + '", encoding="utf-8", errors="ignore").read().strip()[:1])',
      samples: [{ input: '', output: 'x' }]
    });
    check('沙箱：关闭后不再拦截（开关生效）',
      rOff.results[0].verdict !== 'RE' && !/sitecustomize|PermissionError/.test(rOff.results[0].err || ''), rOff.results[0]);
    runner.setSandbox({ enabled: true });
  }

  /* ---------- 7. 富讲解文档：校验与包装 ---------- */
  console.log('\n== 7. 富讲解文档（图文模式） ==');
  {
    const richdoc = require('../lib/richdoc.js');

    const bad = '<div class="wrap"><script>alert(1)</script><p>test</p></div>';
    const vBad = richdoc.validate(bad);
    check('富文档：拒绝 <script>', !vBad.ok && vBad.errors.some((e) => /script/.test(e)), vBad.errors);

    const ext = '<div class="wrap"><img src="https://evil.example/x.png"><figure class="diagram"><svg viewBox="0 0 10 10"></svg></figure></div>';
    const vExt = richdoc.validate(ext);
    check('富文档：拒绝外部 URL', vExt.errors.some((e) => /外部 URL/.test(e)), vExt.errors);

    const onAttr = '<div class="wrap"><p onclick="alert(1)">x</p><figure class="diagram"><svg viewBox="0 0 10 10"></svg></figure></div>';
    check('富文档：拒绝内联事件', richdoc.validate(onAttr).errors.some((e) => /内联事件/.test(e)));

    const unclosed = '<div class="wrap"><section class="chapter"><h2>a</h2></div>';
    check('富文档：发现未闭合标签', richdoc.validate(unclosed).errors.some((e) => /未闭合/.test(e)), richdoc.validate(unclosed).errors);

    const good = '<div class="wrap"><div class="hero"><h1>标题</h1></div>'
      + '<section class="chapter"><h2><span class="num">1</span>题意</h2></section>'
      + '<section class="chapter"><h2><span class="num">2</span>思路</h2></section>'
      + '<section class="chapter"><h2><span class="num">3</span>复杂度</h2></section>'
      + '<figure class="diagram"><svg viewBox="0 0 200 60"><line x1="10" y1="30" x2="190" y2="30"/><text x="60" y="30">a</text></svg><figcaption>图1</figcaption></figure>'
      + '<figure class="diagram"><svg viewBox="0 0 200 60"><line x1="10" y1="30" x2="190" y2="30"/><text x="60" y="30">b</text></svg><figcaption>图2</figcaption></figure>'
      + '<div class="anim-box" data-anim="sequence"><span class="tok">1</span></div>'
      + '<div class="callout key"><span class="ttl">核心</span>要点</div></div>';
    const vGood = richdoc.validate(good);
    check('富文档：合格文档通过校验', vGood.ok === true, vGood.errors);
    check('富文档：统计（章节/图/交互）', vGood.stats.chapters >= 3 && vGood.stats.figures >= 2 && vGood.stats.anims >= 1, vGood.stats);

    const overflow = '<div class="wrap"><figure class="diagram"><svg viewBox="0 0 100 50"><text x="300" y="20">出界</text></svg></figure>'
      + '<figure class="diagram"><svg viewBox="0 0 100 50"><text x="10" y="20">ok</text></svg></figure>'
      + '<div class="anim-box" data-anim="sequence"></div></div>';
    check('富文档：SVG 文字越界给出告警', richdoc.validate(overflow).warnings.some((w) => /超出 viewBox/.test(w)),
      richdoc.validate(overflow).warnings);

    const wrapped = richdoc.wrap(good, { theme: 'dark', css: '.x{}', js: 'void 0;', title: 't' });
    check('富文档：包装含 CSP 与主题', /Content-Security-Policy/.test(wrapped) && /data-theme="dark"/.test(wrapped)
      && wrapped.indexOf(good) >= 0, wrapped.slice(0, 120));
    check('富文档：内置设计系统文件就位', fs.existsSync(path.join(__dirname, '..', 'public', 'rich', 'rich.css'))
      && fs.existsSync(path.join(__dirname, '..', 'public', 'rich', 'rich.js')));

    /* ---- 机械净化 + 挽救（"生不出图"的真正防线）----
     * 模型写图文文档最常犯的三类毛病，都不该让整份文档作废、回落到没有图的 Markdown：
     *   夹带 <script>/外链、末尾少 </div>、图解没写成 <figure class="diagram">（图其实画了）。 */
    const messy = '<div class="wrap"><section class="chapter"><h2>1</h2><p>x</p>'
      + '<div class="card"><svg viewBox="0 0 760 300"><line x1="10" y1="40" x2="700" y2="40"/><text x="10" y="20">a</text></svg></div>'
      + '<div class="card"><svg viewBox="0 0 600 200"><line x1="10" y1="40" x2="560" y2="40"/><text x="10" y="20">b</text></svg></div>'
      + '<div class="anim-box" data-anim="sequence"><span class="tok">1</span></div>'
      + '<script>alert(1)</script><img src="https://evil.example/x.png">'
      + '<a href="http://evil.example">外链</a><p onclick="steal()">带内联事件</p>';
    const vMessy0 = richdoc.validate(messy);
    check('富文档：脏文档先被校验拦下（<script>/外链/内联事件）',
      !vMessy0.ok && vMessy0.errors.length >= 3, vMessy0.errors);
    const clean = richdoc.sanitize(messy);
    check('富文档：净化去掉 <script>/外链/内联事件，且如实记录改动',
      clean.html.indexOf('<script') < 0 && clean.html.indexOf('evil.example') < 0
      && !/onclick/i.test(clean.html) && clean.changes.length >= 3, clean.changes);
    const vMessy1 = richdoc.validate(clean.html);
    check('富文档：净化后通过校验（图解保留下来，不再"一张图都没有"）',
      vMessy1.ok === true && vMessy1.stats.figures >= 2 && richdoc.diagramSvgs(clean.html).length === 2,
      { errors: vMessy1.errors, stats: vMessy1.stats });

    const noClose = '<div class="wrap"><section class="chapter"><h2>1</h2><p>x</p>'
      + '<figure class="diagram"><svg viewBox="0 0 500 200"><line x1="10" y1="60" x2="480" y2="60"/><text x="10" y="20">a</text></svg></figure>'
      + '<figure class="diagram"><svg viewBox="0 0 500 200"><line x1="10" y1="60" x2="480" y2="60"/><text x="10" y="20">b</text></svg></figure>';
    const fixedClose = richdoc.sanitize(noClose);
    check('富文档：末尾缺闭合标签 → 机械补齐（而不是整份作废）',
      richdoc.validate(noClose).ok === false && richdoc.validate(fixedClose.html).ok === true
      && fixedClose.changes.some((c) => /补齐/.test(c)), fixedClose.changes);

    // 图解没用 figure.diagram：模型常写成 <div class="card"><svg/></div> —— 图确实画了，不能判不合格
    const altMarkup = '<div class="wrap"><section class="chapter"><h2>1</h2></section>'
      + '<section class="chapter"><h2>2</h2></section><section class="chapter"><h2>3</h2></section>'
      + '<div class="card"><svg viewBox="0 0 760 240"><line x1="10" y1="40" x2="700" y2="40"/><text x="10" y="20">a</text></svg></div>'
      + '<div class="card"><svg viewBox="0 0 760 240"><line x1="10" y1="40" x2="700" y2="40"/><text x="10" y="20">b</text></svg></div>'
      + '<div class="anim-box" data-anim="bars"><div class="bars"></div></div></div>';
    const vAlt = richdoc.validate(altMarkup);
    check('富文档：图解写成 <div class="card"><svg> 也算数（宽容计数，不因 class 名而废掉图）',
      vAlt.ok === true && vAlt.stats.figures >= 2, { errors: vAlt.errors, stats: vAlt.stats });

    // 没有图 → **判失败**（图文讲解是核心形态，一张图都没有就不是"图文"）。
    // 曾经的弯路：为了不逼模型凑图，把这条降级成提醒 —— 那是把问题修错了地方。
    // 凑图是"必要性判断"的问题，解法是在提示词里教"哪里值得画"（见 lib/harness.js 的 richGuide），
    // 而不是撤掉交付条件。所以这里恢复硬断言。
    const noFigure = '<div class="wrap"><section class="chapter"><h2>1</h2><p>只有文字</p></section></div>';
    const vNoFig = richdoc.validate(noFigure);
    check('富文档：确实没有图 → 判失败（图文讲解不接受"一张图都没有"）',
      vNoFig.ok === false && vNoFig.errors.some((e) => /没有任何真正的 SVG 图解/.test(e)),
      { errors: vNoFig.errors, warnings: vNoFig.warnings });

    // 只有 1 张图 → 通过，但要提醒"通常 2 张"（提醒不判失败：第二张只在真的还有一处说不清时才画）
    const oneFigure = '<div class="wrap"><section class="chapter"><h2>1</h2><p>文字</p>'
      + '<figure class="diagram"><svg viewBox="0 0 760 240"><line x1="10" y1="40" x2="700" y2="40"/><text x="10" y="20">a</text></svg>'
      + '<figcaption><b>图 1</b>｜状态怎么变</figcaption></figure></section></div>';
    const vOneFig = richdoc.validate(oneFigure);
    check('富文档：只有 1 张图 → 通过，但提醒还可以有第二张（不强制凑图）',
      vOneFig.ok === true && vOneFig.warnings.some((e) => /只有 1 张图解/.test(e)),
      { errors: vOneFig.errors, warnings: vOneFig.warnings });

    // 小图标不算图解（16px 的箭头不该被当成"图"）
    const iconOnly = '<div class="wrap"><section class="chapter"><h2>1</h2></section>'
      + '<svg viewBox="0 0 16 16"><path d="M0 0 L8 8"/></svg></div>';
    check('富文档：16px 小图标不算图解', richdoc.diagramSvgs(iconOnly).length === 0);

    // 截断识别（用于给出"压缩篇幅重写"的修复指令）
    const truncated = '<div class="wrap"><section class="chapter"><h2>1</h2><p>写到一半';
    check('富文档：识别被截断的输出', richdoc.looksTruncated(truncated) === true      && richdoc.looksTruncated(good) === false);

    /* ---- LaTeX / Markdown 残渣：图文文档里没有公式渲染器，必须机械翻译成可读写法 ----
     * 真实事故（用户截图）：文档里 141 处 $...$ 与 16 个 LaTeX 命令原样显示，
     * 学员看到的是 `$s_i=\texttt{1}$` 这种公式源码 —— 反馈"怎么又有代码直接暴露出来了"。 */
    const texDoc = '<div class="wrap"><section class="chapter"><h2>1</h2>'
      + '<p>复杂度 $O(\\sum n)$，手算 $n=5,\\ s=\\texttt{"01"}$，下界 $\\lfloor n/2 \\rfloor \\le n$。</p>'
      + '<p>$$T(n)=\\sum_{i=1}^{n} a_i$$</p>'
      + '<p>```python print(1) ```</p>'
      + '<div class="card"><svg viewBox="0 0 700 220"><line x1="10" y1="40" x2="680" y2="40"/><text x="10" y="20">a</text></svg></div>'
      + '<div class="card"><svg viewBox="0 0 640 200"><line x1="10" y1="40" x2="600" y2="40"/></svg></div>'
      + '<div class="anim-box" data-anim="sequence"></div></section></div>';
    check('富文档：LaTeX 会被校验器点名（给出"改用 .formula"的修复提醒）',
      richdoc.validate(texDoc).warnings.some((w) => /LaTeX/.test(w)), richdoc.validate(texDoc).warnings);
    const texFixed = richdoc.sanitize(texDoc);
    check('富文档：机械翻译 LaTeX → 可读文本（不留 $…$ 与反斜杠命令）',
      !/\$[^$\n]{2,}\$/.test(texFixed.html) && !/\\[a-zA-Z]{2,}/.test(texFixed.html)
      && texFixed.changes.some((c) => /LaTeX/.test(c)),
      { changes: texFixed.changes, sample: texFixed.html.slice(0, 200) });
    check('富文档：\\le → ≤、\\lfloor → ⌊、\\texttt{X} → <code>X</code>、\\sum → Σ',
      texFixed.html.indexOf('≤') >= 0 && texFixed.html.indexOf('⌊') >= 0
      && texFixed.html.indexOf('<code>') >= 0 && texFixed.html.indexOf('Σ') >= 0,
      texFixed.html.slice(0, 300));
    check('富文档：行间公式变成设计系统的 .formula 组件',
      /class="formula"/.test(texFixed.html), texFixed.html.slice(0, 300));
    check('富文档：Markdown 代码围栏被清掉（不会当纯文本露出来）',
      texFixed.html.indexOf('```') < 0, texFixed.html.slice(0, 200));
    check('富文档：翻译后仍能通过校验（不留失败的尾巴）',
      richdoc.validate(texFixed.html).ok === true, richdoc.validate(texFixed.html).errors);

    /* ---- 正文引子绝不能漏 HTML（真实事故：消息里整段 &lt;div class="wrap"&gt;）---- */
    const docBody = '<div class="wrap">\n  <div class="hero"><h1>x</h1></div>\n  <section class="chapter"><h2>1</h2></section>\n</div>';
    const lead1 = harness.stripDocFromText('这是一份可以直接读的图文讲解：先讲思路。\n\n```html\n' + docBody + '\n```');
    check('正文防漏：闭合围栏被剥掉，只留引子',
      lead1.indexOf('<div') < 0 && lead1.indexOf('```') < 0 && /这是一份可以直接读的图文讲解/.test(lead1), lead1);
    const lead2 = harness.stripDocFromText('先讲思路。\n\n```html\n' + docBody.slice(0, 60));
    check('正文防漏：**未闭合**围栏（输出被截断）也不会把文档留在正文里',
      lead2.indexOf('<div') < 0 && lead2.indexOf('```') < 0, lead2);
    const lead3 = harness.stripDocFromText('先讲思路。\n' + docBody);
    check('正文防漏：裸 HTML（没有围栏）同样被砍掉',
      lead3.indexOf('<div') < 0 && lead3.indexOf('hero') < 0 && /先讲思路/.test(lead3), lead3);
    const lead4 = harness.stripDocFromText('&lt;div class=&quot;wrap&quot;&gt;&lt;h1&gt;x&lt;/h1&gt;');
    check('正文防漏：已经是转义实体的 HTML 也会被清成文字',
      lead4.indexOf('&lt;') < 0 && lead4.indexOf('div') < 0, JSON.stringify(lead4));
    const lead5 = harness.stripDocFromText('一'.repeat(500));
    check('正文防漏：引子限长（不会把整篇讲解塞进消息）', lead5.length <= 320, lead5.length);
  }

  /* ---------- 性能闸 / 生成器去退化 / "部分验证"口径（2026-10 止血三件套） ----------
   * 背景（两机消融 + 14 题与参考解对照）：我们丢的一整类原因是"算法对、最大规模超时"
   * （2247D2 实测 7.33× 于 oracle；2250C 交付的代码连样例都超时；2247F 的 TLE 被尺子记成
   * diff-WA），另一整类是假自信（5 格 assert=true 而 scope=false）。三件套就是治这两类。 */
  {
    // 1) 题面时限解析：只认官方口径，拿不到就返回 null（宁可不做，也不拿自己编的时限当判据）
    check('性能闸：解析 "time limit per test: 2 seconds"',
      harness.parseTimeLimitMs('time limit per test: 2 seconds') === 2000);
    check('性能闸：解析 "Time limit per test 1.5 seconds"',
      harness.parseTimeLimitMs('Time limit per test 1.5 seconds') === 1500);
    check('性能闸：毫秒写法 "time limit per test: 1500 milliseconds"',
      harness.parseTimeLimitMs('time limit per test: 1500 milliseconds') === 1500);
    check('性能闸：题面没有时限 → null（宁可不做，也不拿编的时限判失败）',
      harness.parseTimeLimitMs('输入一行 n，输出答案。') === null
      && harness.parseTimeLimitMs('') === null && harness.parseTimeLimitMs(undefined) === null);

    // 2) 开关与阈值：默认开、factor=2、maxN=200000；env 可覆盖（集成测试靠 maxN 把规模缩小）
    const oldGate = process.env.CFCOACH_PERF_GATE;
    const oldFactor = process.env.CFCOACH_PERF_GATE_FACTOR;
    const oldMaxN = process.env.CFCOACH_PERF_GATE_MAXN;
    delete process.env.CFCOACH_PERF_GATE;
    delete process.env.CFCOACH_PERF_GATE_FACTOR;
    delete process.env.CFCOACH_PERF_GATE_MAXN;
    const pgDefault = harness.perfGateConfig();
    check('性能闸：默认开启，factor 2、maxN 200000、墙钟 60s',
      pgDefault.on === true && pgDefault.factor === 2 && pgDefault.maxN === 200000 && pgDefault.wallMs === 60000, pgDefault);
    process.env.CFCOACH_PERF_GATE = '0';
    check('性能闸：CFCOACH_PERF_GATE=0 可关掉', harness.perfGateConfig().on === false);
    process.env.CFCOACH_PERF_GATE = '1';
    process.env.CFCOACH_PERF_GATE_FACTOR = '3';
    process.env.CFCOACH_PERF_GATE_MAXN = '500';
    const pgEnv = harness.perfGateConfig();
    check('性能闸：env 可覆盖倍数与规模档',
      pgEnv.on === true && pgEnv.factor === 3 && pgEnv.maxN === 500, pgEnv);
    if (oldGate === undefined) delete process.env.CFCOACH_PERF_GATE; else process.env.CFCOACH_PERF_GATE = oldGate;
    if (oldFactor === undefined) delete process.env.CFCOACH_PERF_GATE_FACTOR; else process.env.CFCOACH_PERF_GATE_FACTOR = oldFactor;
    if (oldMaxN === undefined) delete process.env.CFCOACH_PERF_GATE_MAXN; else process.env.CFCOACH_PERF_GATE_MAXN = oldMaxN;

    // 2b) 同语言性能优化（默认开、上限 1 次）与语言闸（默认关）
    //     用户口径 2026-10-10：交付的语言必须就是被要求的那门 ⇒ Python 超时要在 Python 里修算法，
    //     "换 C++"只是把"这份代码在这门语言里慢"藏起来 ⇒ 语言闸降级成显式 A/B 旋钮。
    const oldRepair = process.env.CFCOACH_PERF_REPAIR;
    const oldRepairMax = process.env.CFCOACH_PERF_REPAIR_MAX;
    const oldSw = process.env.CFCOACH_LANG_SWITCH;
    delete process.env.CFCOACH_PERF_REPAIR;
    delete process.env.CFCOACH_PERF_REPAIR_MAX;
    delete process.env.CFCOACH_LANG_SWITCH;
    const prDefault = harness.perfRepairConfig();
    check('同语言优化：默认开启、整轮上限 1 次',
      prDefault.on === true && prDefault.max === 1, prDefault);
    check('语言闸：默认关闭（交付的语言就是被要求的那门）',
      harness.langSwitchEnabled() === false);
    process.env.CFCOACH_PERF_REPAIR = '0';
    check('同语言优化：CFCOACH_PERF_REPAIR=0 可关掉', harness.perfRepairConfig().on === false);
    process.env.CFCOACH_PERF_REPAIR = '1';
    process.env.CFCOACH_PERF_REPAIR_MAX = '3';
    check('同语言优化：上限可用 CFCOACH_PERF_REPAIR_MAX 覆盖',
      harness.perfRepairConfig().on === true && harness.perfRepairConfig().max === 3);
    process.env.CFCOACH_LANG_SWITCH = '1';
    check('语言闸：CFCOACH_LANG_SWITCH=1 才打开（A/B 用）',
      harness.langSwitchEnabled() === true);
    if (oldRepair === undefined) delete process.env.CFCOACH_PERF_REPAIR; else process.env.CFCOACH_PERF_REPAIR = oldRepair;
    if (oldRepairMax === undefined) delete process.env.CFCOACH_PERF_REPAIR_MAX; else process.env.CFCOACH_PERF_REPAIR_MAX = oldRepairMax;
    if (oldSw === undefined) delete process.env.CFCOACH_LANG_SWITCH; else process.env.CFCOACH_LANG_SWITCH = oldSw;

    // 3) 生成器去退化：写死的随机种子让"对拍 N 组"变成同一组用例跑 N 遍
    const d1 = harness.dedupeGenSeed('import random\nrandom.seed(123456789)\nprint(random.randint(0, 9))');
    check('生成器去退化：random.seed(数字) → random.seed()',
      d1.changed === true && d1.code.indexOf('random.seed()') >= 0 && !/seed\(\s*\d/.test(d1.code), d1.code);
    const d2 = harness.dedupeGenSeed('random . seed( 7 )');
    check('生成器去退化：容忍空格写法', d2.changed === true && !/seed\(\s*\d/.test(d2.code), d2.code);
    const bare = 'random.seed()  # 时间种子\nrandom.seed(seed_var)\nrandom.seed(n % 10)';
    const d3 = harness.dedupeGenSeed(bare);
    check('生成器去退化：random.seed() 与变量/表达式种子都不动（只治写死的常量）',
      d3.changed === false && d3.code === bare, d3.code);

    /* 3.5) 按官方样例定向修复的开关与上限（2026-10-09 批次①）。
     * 取证：本机库 14/52 格题解没过官方样例，其中 9 格是"修一次、重写版仍不过样例 → 拒绝并停止"，
     * 而这些格子只花了 10–12 次调用（预算档允许 50–130）。官方样例是唯一带官方背书的反例，
     * 所以"一次就放弃"要改成"带着这组权威反例修到通过或撞上限（整轮共享、默认 3 次）"。 */
    const oldSf = process.env.CFCOACH_SAMPLE_FIX;
    const oldSfMax = process.env.CFCOACH_SAMPLE_FIX_MAX;
    delete process.env.CFCOACH_SAMPLE_FIX;
    delete process.env.CFCOACH_SAMPLE_FIX_MAX;
    const sfDefault = harness.sampleFixConfig();
    check('官方样例定向修复：默认开启、整轮上限 3 次',
      sfDefault.on === true && sfDefault.max === 3, sfDefault);
    process.env.CFCOACH_SAMPLE_FIX = '0';
    check('官方样例定向修复：CFCOACH_SAMPLE_FIX=0 可关掉', harness.sampleFixConfig().on === false);
    process.env.CFCOACH_SAMPLE_FIX = '1';
    process.env.CFCOACH_SAMPLE_FIX_MAX = '5';
    const sfEnv = harness.sampleFixConfig();
    check('官方样例定向修复：env 可覆盖上限（集成测试靠它把次数缩小）',
      sfEnv.on === true && sfEnv.max === 5, sfEnv);
    if (oldSf === undefined) delete process.env.CFCOACH_SAMPLE_FIX; else process.env.CFCOACH_SAMPLE_FIX = oldSf;
    if (oldSfMax === undefined) delete process.env.CFCOACH_SAMPLE_FIX_MAX; else process.env.CFCOACH_SAMPLE_FIX_MAX = oldSfMax;

    // 3.6) 官方样例反例段确实进了"修题解"的提示词（含期望答案 + 实际输出 + 禁止硬编码）
    const suSample = harness.buildSolutionUser(
      { statement: '题面', samples: [] }, { inputSpec: 'n', outputSpec: 'ans' },
      { retry: true, prevCode: 'print(0)', sampleFailing: [{ index: 1, verdict: 'WA', input: '1\n2', expected: '3', actual: '0' }] });
    check('官方样例反例段：写清样例序号/输入/官方答案/实际输出，并禁止硬编码',
      /官方样例未通过/.test(suSample) && suSample.indexOf('3') >= 0 && suSample.indexOf('样例 1：WA') >= 0
      && /严禁/.test(suSample), suSample.slice(-400));

    // 4) 讲解 Agent 的"部分验证"口径：status=ok 但 claimVerified=false 时绝不能说"已经通过验证"
    const vPartial = {
      status: 'ok', claimVerified: false, scopeComplete: false,
      scopeNote: '⚠️ 交付前最大规模计时没过：题解在最大规模档（n≈200000）耗时 7000ms，超过题面时限 2000ms 的 2 倍'
    };
    const sysPartial = harness.explainerSystem('full', 'cpp', false, 'L3', vPartial);
    check('部分验证：讲解系统提示词禁止说"已经在本机通过验证"',
      sysPartial.indexOf('已经在本机通过验证') < 0 && /部分验证/.test(sysPartial)
      && /最大规模用例上会超时/.test(sysPartial), sysPartial.slice(0, 160));
    const vFull = { status: 'ok', claimVerified: true, scopeComplete: true, scopeNote: '官方样例通过；随机对拍 60 组一致；已按题面上限计时' };
    const sysFull = harness.explainerSystem('full', 'cpp', false, 'L3', vFull);
    check('完整验证：仍然照旧（可以说"已经在本机通过验证"）',
      sysFull.indexOf('已经在本机通过验证') >= 0 && !/部分验证/.test(sysFull));
    const sysOld = harness.explainerSystem('full', 'cpp', false, 'L3', { status: 'ok' });
    check('老记录（没有 claimVerified 字段）不被误判成"部分验证"',
      sysOld.indexOf('已经在本机通过验证') >= 0 && !/部分验证/.test(sysOld));
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) {
    console.log('失败清单：');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
