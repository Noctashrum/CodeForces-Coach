'use strict';
/**
 * 并行化验证：题解 / 暴力 / 生成器三个 Agent 现在**并发**生成（原来串行）。
 *
 * 为什么必须验证：并发最容易踩的两类坑 ——
 *  ① 三个调用共享上下文里的可变状态（预算计数 / 轨迹 / 文件写入）被交错破坏；
 *  ② 服务商限流导致某一路失败（要有"串行重试一次"的兜底，不能因此丢产物）。
 * 这里用假的 callAgent（可控延迟）跑一次完整 runPipeline，断言：
 *  · 三份产物都拿到、验证通过；
 *  · **墙钟时间接近最慢那一路**而不是三者之和（并发真的生效）；
 *  · 三路各自的调用都能被计数（互不覆盖）。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.CHATBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-parallel-'));
const workspace = require('../lib/workspace');
workspace.setRoot(path.join(process.env.CHATBOX_DATA_DIR, 'workspace'));
const harness = require('../lib/harness');
const explaindoc = require('../lib/explaindoc');
const runner = require('../lib/runner');

let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { console.error('  \u2717 ' + name + (extra == null ? '' : '\n    ' + JSON.stringify(extra))); process.exitCode = 1; }
}

const STATEMENT = [
  '给定 n 张牌，每张牌有一个非负整数。遇到 0 时可以取走此前未被取走的最大正数牌，求能取得的最大总和。',
  '',
  '输入格式',
  '第一行 t（1 ≤ t ≤ 10）。',
  '每个测试用例第一行 n（1 ≤ n ≤ 8），第二行 n 个整数。',
  '',
  '输出格式',
  '每个测试用例输出一行整数。',
  '',
  '样例输入',
  '2',
  '3',
  '3 3 0',
  '2',
  '5 0',
  '',
  '样例输出',
  '3',
  '5'
].join('\n');

const SOL = [
  'import sys, heapq',
  'd = sys.stdin.read().split()',
  'p = 0; t = int(d[p]); p += 1; out = []',
  'for _ in range(t):',
  '    n = int(d[p]); p += 1',
  '    h = []; s = 0',
  '    for _ in range(n):',
  '        x = int(d[p]); p += 1',
  '        if x > 0: heapq.heappush(h, -x)',
  '        elif h: s += -heapq.heappop(h)',
  '    out.append(str(s))',
  'print("\\n".join(out))'
].join('\n');

const BRUTE = [
  'import sys',
  'from itertools import permutations',
  'd = sys.stdin.read().split()',
  'p = 0; t = int(d[p]); p += 1; out = []',
  'for _ in range(t):',
  '    n = int(d[p]); p += 1',
  '    a = [int(d[p + i]) for i in range(n)]; p += n',
  '    best = 0',
  '    def rec(i, taken, total):',
  '        global best',
  '        if i == n:',
  '            best = max(best, total); return',
  '        if a[i] > 0: rec(i + 1, taken, total); return',
  '        for j in range(i):',
  '            if a[j] > 0 and j not in taken: rec(i + 1, taken | {j}, total + a[j])',
  '        rec(i + 1, taken, total)',
  '    rec(0, set(), 0)',
  '    out.append(str(best))',
  'print("\\n".join(out))'
].join('\n');

const GEN = [
  'import random, sys',
  'm = int(sys.argv[1]) if len(sys.argv) > 1 else 8',
  'n = random.randint(1, max(1, min(m, 8)))',
  'print(1)',
  'print(n)',
  'print(*[random.randint(0, 6) for _ in range(n)])'
].join('\n');

const SLOW_MS = 900;   // 三路各自的"思考时间"：串行 ≈ 2.7s，并发 ≈ 0.9s

const callAgent = async (opts) => {
  const sys = String(opts.system || '');
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  if (sys.indexOf('【题解 Agent】') >= 0) { await delay(SLOW_MS); return '思路：大根堆贪心。\n\n```python\n' + SOL + '\n```'; }
  if (sys.indexOf('【暴力 Agent】') >= 0) { await delay(SLOW_MS * 1.2); return '暴力枚举。\n\n```python\n' + BRUTE + '\n```'; }
  if (sys.indexOf('【数据生成 Agent】') >= 0) { await delay(SLOW_MS * 0.5); return '```python\n' + GEN + '\n```'; }
  if (sys.indexOf('【讲解 Agent】') >= 0) { await delay(30); return '## 题面拆解\nx\n## 关键观察\nx\n## 为什么\nx\n## 手算演示\n拿 n=2 举例\n<viz-steps title="t"><viz-step title="第 1 步">a</viz-step></viz-steps>\n## 算法\nx\n## 复杂度分析\n$O(n\\log n)$\n<viz-formula title="复杂度" fx="$T(n)=O(n\\log n)$" legend="n" why="堆"/>\n## 代码\n```python\n' + SOL + '\n```\n## 讲解\nx\n## 易错点\nx\n<viz-callout type="danger" title="易错">x</viz-callout>\n## 验证\n官方样例通过。'; }
  return '{}';
};

(async () => {
  console.log('parallel: 三个代码 Agent 并发生成');
  const t0 = Date.now();
  const res = await harness.runPipeline({
    conv: { id: 'parallel-test', title: '并发测试' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'parallel-test',
    callAgent, tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  const elapsed = Date.now() - t0;

  ok('三份产物都生成成功（sol/brute/gen）', !!(res.solCode && res.bruteCode && res.genCode),
    { sol: !!res.solCode, brute: !!res.bruteCode, gen: !!res.genCode });
  ok('验证通过（并发没有破坏流水线）', res.verification && res.verification.status === 'ok',
    res.verification && res.verification);

  // 串行 = 2.7s（0.9+1.08+0.45）；并发应当明显小于它
  // 判据不看整条流水线的墙钟（里面还有编译/对拍/讲解等固定开销），而是看**三个调用的时间窗是否重叠**
  const three = (res.trace || []).filter((t) => ['solution', 'brute', 'gen'].indexOf(t.role) >= 0 && t.ok);
  const starts = three.map((t) => t.at);
  const ends = three.map((t) => t.at + t.ms);
  const latestStart = Math.max.apply(null, starts);
  const earliestEnd = Math.min.apply(null, ends);
  ok('三个 Agent 的调用时间窗互相重叠（并发真的生效，不是串行）',
    three.length === 3 && latestStart < earliestEnd,
    { calls: three.map((t) => ({ role: t.role, at: t.at, ms: t.ms })), latestStart, earliestEnd });
  ok('并发下总耗时明显小于"三路之和"', (earliestEnd - Math.min.apply(null, starts)) < SLOW_MS * (1 + 1.2 + 0.5) * 0.8,
    { windowMs: earliestEnd - Math.min.apply(null, starts), serialMs: Math.round(SLOW_MS * 2.7) });

  const roles = (res.trace || []).map((t) => t.role);
  ['solution', 'brute', 'gen'].forEach((r) => {
    ok('调用计数包含 ' + r + '（并发下没有互相覆盖）', roles.indexOf(r) >= 0, roles);
  });

  // 并发失败 → 串行重试兜底：暴力解第一次调用直接抛错（模拟 429），之后应恢复
  console.log('parallel: 并发失败时的串行重试兜底');
  let bruteFails = 0;
  const callAgent2 = async (opts) => {
    const sys = String(opts.system || '');
    if (sys.indexOf('【暴力 Agent】') >= 0) {
      bruteFails++;
      if (bruteFails === 1) { const e = new Error('429 Too Many Requests'); e.status = 429; throw e; }
      return '暴力枚举。\n\n```python\n' + BRUTE + '\n```';
    }
    return callAgent(opts);
  };
  const res2 = await harness.runPipeline({
    conv: { id: 'parallel-test2', title: '并发重试' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'parallel-test2',
    callAgent: callAgent2, tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  ok('某一路 429 后自动重试，暴力解仍然拿到',
    !!res2.bruteCode && res2.verification && res2.verification.status === 'ok',
    { brute: !!res2.bruteCode, v: res2.verification && res2.verification.status });
  // 重试有两层：agent() 内部对"调用出错/空回复"最多重试 2 次；并发这一层再兜一层串行重试。
  // 这里断言"确实重试过"——证据是 trace 里出现了第 2 次调用（标签带"第 2 次"）或轨迹里有 parallel-retry
  const retried = (res2.trace || []).some((t) => /第 2 次/.test(t.label || ''))
    || (res2.trajectory || []).some((t) => t.kind === 'parallel-retry');
  ok('失败的那一路被重试过（可诊断：trace 第 2 次 / 轨迹 parallel-retry）', retried,
    { trace: (res2.trace || []).map((t) => t.label), traj: (res2.trajectory || []).map((t) => t.kind) });

  // 用户点「停止」：信号必须真的贯穿整条链路 —— 在下一个步骤边界立刻退栈，不再发起模型调用，
  // 更不能把"跑到一半的对拍"记成验证通过（否则界面一直转圈 + 白烧 token，实测反馈过这个症状）
  console.log('parallel: 用户点停止 → 立刻退栈');
  const pre = new AbortController();
  pre.abort();
  let preCalls = 0;
  let preErr = null;
  try {
    await harness.runPipeline({
      conv: { id: 'cancel-pre', title: '停止测试' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: 'cancel-pre', signal: pre.signal,
      callAgent: async (o) => { preCalls++; return callAgent(o); },
      tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
  } catch (e) { preErr = e; }
  ok('停止：开始前就已取消 → 一次模型调用都不发', preCalls === 0, { calls: preCalls });
  ok('停止：抛「已取消」立刻退栈（不会当成功返回）',
    !!(preErr && /已取消/.test(String(preErr.message || ''))), preErr ? preErr.message : 'not thrown');
  const metaPre = workspace.loadMeta('cancel-pre');
  ok('停止：不留下"验证通过"的假记录',
    !(metaPre && metaPre.verification && metaPre.verification.status === 'ok'),
    metaPre && metaPre.verification);

  // 中途停止：第一路调用一返回就点停止（三路是并发的，所以另两路已经在飞——这正好检验
  // "已经在飞的不管，但绝不再发起新调用"）。后续步骤（witness / 讲解 / 各种修正轮）都不该再发调用。
  const mid = new AbortController();
  let midCalls = 0;
  let midErr = null;
  let midRes = null;
  let stoppedOnce = false;
  try {
    midRes = await harness.runPipeline({
      conv: { id: 'cancel-mid', title: '中途停止' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: 'cancel-mid', signal: mid.signal,
      callAgent: async (o) => {
        midCalls++;
        const t = await callAgent(o);
        if (!stoppedOnce) { stoppedOnce = true; mid.abort(); }
        return t;
      },
      tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
  } catch (e) { midErr = e; }
  const fullCalls = (res.trace || []).length;
  ok('停止：中途停止后不再发起新调用（只跑完已经在飞的那几路）',
    midCalls > 0 && midCalls < fullCalls, { midCalls, fullCalls });
  ok('停止：中途停止也是抛「已取消」退栈',
    !!(midErr && /已取消/.test(String(midErr.message || ''))), midErr ? midErr.message : 'not thrown');
  ok('停止：中途停止不会被当成"验证通过"',
    !(midRes && midRes.verification && midRes.verification.status === 'ok'),
    midRes ? midRes.verification : (midErr && midErr.message));
  ok('停止：已取消的那几路不再串行重试（省调用次数）',
    !(midRes && (midRes.trajectory || []).some((t) => t.kind === 'parallel-retry')),
    midRes && (midRes.trajectory || []).map((t) => t.kind));

  // 富讲解结构容错：**图确实画了**，只是没写成 <figure class="diagram">、末尾还少个 </div>。
  // 这不该整份作废——作废就会回落到"一张图都没有"的 Markdown，学员看到的就是"富讲解生不出图"。
  console.log('parallel: 富讲解结构容错（把带图文档救回来）');
  const SOFT_RICH = [
    '<div class="wrap">',
    '  <div class="hero"><h1>牌堆贪心</h1></div>',
    '  <section class="chapter"><h2><span class="num">1</span>思路</h2><p>大根堆贪心。</p>',
    // 图解要**真的是一张图**：richdoc 现在要求 svg 里有连线/箭头（"表格不算图"），
    // 所以夹具里也得有 line —— 只放 rect+text 的那种网格已经不被算作图解了。
    '    <div class="card"><svg viewBox="0 0 700 220"><line x1="20" y1="120" x2="660" y2="120" stroke="#6b7899"/><text x="20" y="40">正数入堆</text></svg><p>图 1｜扫描</p></div>',
    '  </section>',
    '  <section class="chapter"><h2><span class="num">2</span>复杂度</h2>',
    '    <div class="card"><svg viewBox="0 0 640 200"><line x1="20" y1="120" x2="600" y2="120" stroke="#6b7899"/><text x="20" y="40">O(n log n)</text></svg><p>图 2｜对比</p></div>',
    '  </section>',
    '  <section class="chapter"><h2><span class="num">3</span>代码</h2><pre class="code">heapq</pre></section>'
    // 故意不写收尾的 </div>
  ].join('\n');
  const callAgentRich = async (opts) => {
    const sys = String(opts.system || '');
    if (sys.indexOf('【讲解 Agent】') >= 0) return '图文讲解如下。\n\n```html\n' + SOFT_RICH + '\n```';
    return callAgent(opts);
  };
  const res3 = await harness.runPipeline({
    conv: { id: 'rich-soft', title: '富讲解容错' },
    lang: 'python', intent: 'full', rich: true, statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'rich-soft',
    callAgent: callAgentRich, tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  const richSvgs = ((res3.richDoc || '').match(/<svg/gi) || []).length;
  ok('富讲解容错：交付了带图文档（svg ≥2，不是回落的纯文字）',
    !!res3.richDoc && richSvgs >= 2, { hasDoc: !!res3.richDoc, svgs: richSvgs });
  ok('富讲解容错：轨迹里留下机械修正记录（可诊断）',
    (res3.trajectory || []).some((t) => t.kind === 'richdoc-sanitized'),
    (res3.trajectory || []).map((t) => t.kind));
  ok('富讲解容错：没有走"回落 Markdown"',
    !(res3.trajectory || []).some((t) => t.kind === 'richdoc-fallback'),
    (res3.trajectory || []).map((t) => t.kind));
  /* 图文路径也要带「系统实测」附录（验证范围由验证链写入，不靠模型转述）：
   * 注入点在 richdoc.validate 之后 —— 校验的是模型写的内容，附录是我们自己生成的。 */
  ok('图文交付物：末尾带「系统实测」一章（验证范围由验证链写入）',
    /系统实测（验证链写入，不是模型转述）/.test(String(res3.richDoc || ''))
    && /验证范围（机器记录）/.test(String(res3.richDoc || ''))
    && (res3.trajectory || []).some((t) => t.kind === 'explain-appendix'),
    { hasAppendix: /系统实测/.test(String(res3.richDoc || '')), kinds: (res3.trajectory || []).map((t) => t.kind).filter((k) => /explain/.test(k)) });
  ok('图文交付物：附录在模型文档之后（正文仍然是自己那份，不被顶掉）',
    String(res3.richDoc || '').indexOf('heapq') < String(res3.richDoc || '').indexOf('系统实测（验证链写入'),
    { at: String(res3.richDoc || '').indexOf('系统实测（验证链写入') });

  /* ---------------- 工作台时机：每个 Agent 的 chip 必须自己跑完就收 ----------------
   * 实测反馈："agent 确实并行了，但三个 chip 是一起结束的，提前跑完的也一直显示正在工作"。
   * 判据：三路耗时不同（题解 600ms / 暴力 300ms / 生成器 120ms），它们 chip 的 toolResult
   * 到达时间必须跟着各自的完成时间走，而不是统统挤在最后。 */
  console.log('parallel: 每个 Agent 的 chip 各自收尾（不一起结束）');
  const chipEvents = [];
  const tChip = Date.now();
  const delayMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const callAgentChip = async (opts) => {
    const sys = String(opts.system || '');
    if (sys.indexOf('【题解 Agent】') >= 0) { await delayMs(600); return '```python\n' + SOL + '\n```'; }
    if (sys.indexOf('【暴力 Agent】') >= 0) { await delayMs(300); return '```python\n' + BRUTE + '\n```'; }
    if (sys.indexOf('【数据生成 Agent】') >= 0) { await delayMs(120); return '```python\n' + GEN + '\n```'; }
    return callAgent(opts);
  };
  await harness.runPipeline({
    conv: { id: 'chip-timing', title: 'chip 时机' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'chip-timing',
    callAgent: callAgentChip, tiers: [4, 6], perTier: 2,  bruteTimeoutMs: 5000,
    emit: (ev) => {
      if (ev.type !== 'toolResult') return;
      (ev.results || []).forEach((r) => {
        if (['agent_solution', 'agent_brute', 'agent_gen'].indexOf(r.name) >= 0) {
          chipEvents.push({ name: r.name, at: Date.now() - tChip });
        }
      });
    },
    log: () => {}
  });
  const at = (n) => { const e = chipEvents.find((x) => x.name === n); return e ? e.at : -1; };
  const tGen = at('agent_gen');
  const tBrute = at('agent_brute');
  const tSol = at('agent_solution');
  ok('chip：三路都各自收尾了（不是一直转圈）',
    tGen >= 0 && tBrute >= 0 && tSol >= 0, chipEvents);
  ok('chip：生成器（最快那路）明显早于题解（最慢那路）收尾，不是一起结束',
    tGen >= 0 && tSol >= 0 && (tSol - tGen) >= 250 && tGen < 400,
    { tGen, tBrute, tSol });

  /* ---------------- 标尺有罪时，绝不能反过来改题解 ----------------
   * 实测事故（真实的 G 题）：暴力解用错算法 → 对拍不一致 → 仲裁判定"标尺错" → 重写标尺后又没过样例
   * → 旧逻辑居然"回退为改题解"，把**通过官方样例的正确题解**重写了一遍，还把坏尺子量出来的
   *   expected 当成教学反例交给讲解 Agent。这里把这条链路钉死。 */
  console.log('parallel: 标尺有罪 → 不改题解（不拿坏尺子当期望输出）');
  // 第一版暴力解：输出"最大正数"——能过官方样例（3/5），但在别的数据上是错的
  const WRONG_BRUTE = [
    'import sys',
    'd = sys.stdin.read().split()',
    'p = 0; t = int(d[p]); p += 1; out = []',
    'for _ in range(t):',
    '    n = int(d[p]); p += 1',
    '    a = [int(d[p + i]) for i in range(n)]; p += n',
    '    out.append(str(max([x for x in a if x > 0] or [0])))',
    'print("\\n".join(out))'
  ].join('\n');
  const BAD_BRUTE = 'import sys\nprint("0")';   // 重写后的暴力解：连样例都过不了
  let solCalls = 0;
  let bruteCalls = 0;
  let adjudicateCalls = 0;
  const callAgentRuler = async (opts) => {
    const sys = String(opts.system || '');
    const label = String(opts.label || '');
    if (sys.indexOf('【题解 Agent】') >= 0) {
      solCalls++;
      return '思路：大根堆贪心。\n\n```python\n' + SOL + '\n```';
    }
    if (sys.indexOf('【暴力 Agent】') >= 0) {
      bruteCalls++;
      return '暴力。\n\n```python\n' + (bruteCalls === 1 ? WRONG_BRUTE : BAD_BRUTE) + '\n```';
    }
    if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + GEN + '\n```';
    if (sys.indexOf('错因仲裁') >= 0 || label.indexOf('仲裁') >= 0) {
      adjudicateCalls++;
      return '{"wrong":"brute","reason":"暴力解按最大值取，忽略了每个 0 各取一张的规则"}';
    }
    if (sys.indexOf('【讲解 Agent】') >= 0) return '## 题面拆解\nx\n## 关键观察\nx\n## 为什么\nx\n## 手算演示\nn=1\n<viz-steps title="t"><viz-step title="1">a</viz-step></viz-steps>\n## 算法\nx\n## 复杂度分析\n$O(n\\log n)$\n<viz-formula title="c" fx="$O(n)$" legend="n" why="x"/>\n## 代码\n```python\n' + SOL + '\n```\n## 讲解\nx\n## 易错点\nx\n<viz-callout type="danger" title="e">x</viz-callout>\n## 验证\nx';
    return '{}';
  };
  const resRuler = await harness.runPipeline({
    conv: { id: 'ruler-fault', title: '标尺有罪' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'ruler-fault',
    callAgent: callAgentRuler, tiers: [4, 6], perTier: 4,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  // 定位到"标尺有罪"有三条合法路径（都属机械/仲裁判定，而不是去改题解）：
  //   ① 体检探针发现暴力解在更大档"退化"（sanity-brute-degenerate）
  //   ② 对拍不一致 + 机械判定输出退化（brute-degenerate）
  //   ③ 对拍不一致 + 错因仲裁判 brute（adjudicate）
  const blamedRuler = (resRuler.trajectory || []).some((t) => t.kind === 'sanity-brute-degenerate'
    || t.kind === 'brute-degenerate'
    || (t.kind === 'adjudicate' && /brute/.test(String(t.note || ''))));
  ok('标尺有罪：错因定位到标尺（体检探针 / 机械判定 / 仲裁）', blamedRuler,
    { adjudicateCalls, traj: (resRuler.trajectory || []).map((t) => t.kind) });
  ok('标尺有罪：题解**没有被重写**（只跑了最初那一次）', solCalls === 1, { solCalls, bruteCalls });
  ok('标尺有罪：结论是 no-bruler（没有可信标尺），不是拿坏尺子改题解',
    resRuler.status === 'no-bruler' || resRuler.verification.status === 'no-bruler',
    { status: resRuler.status, v: resRuler.verification && resRuler.verification.status });
  ok('标尺有罪：轨迹如实记下"重写后的暴力解没过样例"',
    (resRuler.trajectory || []).some((t) => t.kind === 'brute-recal-fail'),
    (resRuler.trajectory || []).map((t) => t.kind));
  ok('标尺有罪：不把坏尺子量出的 expected 当反例交给讲解（没有最小反例）',
    !resRuler.minimalCase || !resRuler.minimalCase.input, resRuler.minimalCase);
  ok('标尺有罪：题解保持原样（没有被坏尺子的期望值改动）',
    String(resRuler.solCode || '').indexOf('heapq') >= 0, String(resRuler.solCode || '').slice(0, 80));

  /* ---------------- 多解题（答案不唯一）：本地判不了就不改题解、不烧仲裁 ----------------
   * 实测事故（2026-10 消融报告 2267B）：题面写明"输出任意一个合法答案"，官方样例只是其中**一个**
   * 合法答案 → 题解与暴力解给出不同的合法答案 → 旧逻辑当成"题解错" → 两次重写都被长度上限截断
   * → 20 分钟总时长上限烧穿、正文 0 字节、连文档都没生成。这里把"判不了"这条闸门钉死。 */
  console.log('parallel: 多解题（答案不唯一）→ 判不了就不改题解');
  // 题：输出 1..n 的任意排列（题面明说多解）。样例给的是顺序 1 2 3。
  const MA_SOL = [
    'import sys',
    'd = sys.stdin.read().split()',
    'n = int(d[0])',
    'print(" ".join(str(i) for i in range(n, 0, -1)))'   // 逆序：合法但与样例不同
  ].join('\n');
  const MA_BRUTE = [
    'import sys',
    'd = sys.stdin.read().split()',
    'n = int(d[0])',
    'print(" ".join(str(i) for i in range(1, n + 1)))'   // 顺序：与样例逐字相同
  ].join('\n');
  const MA_GEN = [
    'import random, sys',
    'm = int(sys.argv[1]) if len(sys.argv) > 1 else 8',
    'print(random.randint(2, max(2, min(m, 8))))'
  ].join('\n');
  const MA_STATEMENT = STATEMENT
    + '\nYou may print the numbers in any order. If there are multiple valid answers, output any one of them.';
  let maSolCalls = 0;
  let maBruteCalls = 0;
  let maAdjCalls = 0;
  const callAgentMulti = async (opts) => {
    const sys = String(opts.system || '');
    const label = String(opts.label || '');
    if (sys.indexOf('【题解 Agent】') >= 0) { maSolCalls++; return '思路：任意排列即可。\n\n```python\n' + MA_SOL + '\n```'; }
    if (sys.indexOf('【暴力 Agent】') >= 0) { maBruteCalls++; return '暴力。\n\n```python\n' + MA_BRUTE + '\n```'; }
    if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + MA_GEN + '\n```';
    if (sys.indexOf('错因仲裁') >= 0 || label.indexOf('仲裁') >= 0) { maAdjCalls++; return '{"wrong":"sol","reason":"输出与样例不同"}'; }
    if (sys.indexOf('【讲解 Agent】') >= 0) return '## 题面拆解\n多解题：任意排列都合法。\n## 验证\n与样例不同不代表错。';
    return '{}';
  };
  const resMA = await harness.runPipeline({
    conv: { id: 'multi-answer', title: '多解题' },
    lang: 'python', intent: 'full', statement: MA_STATEMENT,
    samples: [{ input: '3', output: '1 2 3' }],
    workspace, wsKey: 'multi-answer',
    callAgent: callAgentMulti, tiers: [4, 6], perTier: 6, bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  const maTraj = (resMA.trajectory || []).map((t) => t.kind);
  ok('多解题：样例与题解字面不同 → 不判题解错、不改写题解（sol 只跑一次）',
    maSolCalls === 1 && maBruteCalls === 1, { sol: maSolCalls, brute: maBruteCalls });
  ok('多解题：样例关不作判错依据（轨迹记下 special-judge，而不是 sol-samples-fail）',
    maTraj.indexOf('sol-samples-special-judge') >= 0 && maTraj.indexOf('sol-samples-fail') < 0,
    { traj: maTraj.join(',') });
  ok('多解题：对拍不一致 → 停止改写、不花仲裁调用（本地判不了就不判）',
    maAdjCalls === 0 && maTraj.indexOf('multi-answer-undecidable') >= 0,
    { adj: maAdjCalls, traj: maTraj.join(',') });
  ok('多解题：结论如实标成 multi-answer，覆盖范围**不是**完整验证',
    resMA.status === 'multi-answer' && resMA.verification.status === 'multi-answer'
    && resMA.verification.multiAnswer === true && resMA.verification.scopeComplete === false,
    { status: resMA.status, v: resMA.verification && resMA.verification.status,
      multi: resMA.verification && resMA.verification.multiAnswer,
      scope: resMA.verification && resMA.verification.scopeComplete });
  ok('多解题：不把"两边都合法"的差异当教学反例交给讲解（没有最小反例）',
    !resMA.minimalCase || !resMA.minimalCase.input, resMA.minimalCase);
  ok('多解题：提醒里说明"和样例不同不等于错、样例通关也不是正确性证明"',
    (resMA.notes || []).join('').indexOf('多解题') >= 0
    && (resMA.notes || []).join('').indexOf('不等于') >= 0,
    { notes: (resMA.notes || []).join(' | ').slice(0, 200) });

  /* ---------------- 多解题 + **本地 checker**：判得动就照判，判不动才停 ----------------
   * 批次②（2026-10-10）：离线尺子已经证明"按题面写一份 checker"能把多解题从"不可判"变成真判词
   * （2250F / 2257C / 2267B 三题 24 条记录 15 条 ★CF-AC）。这里钉住产品侧接线后的三条语义：
   *   ① checker 判题解**合法** → 这条"不一致"不成立：不改写题解、不花仲裁调用，仍然如实标 multi-answer；
   *   ② checker 判题解**不合法** → 这才是有背书的真反例，走正常"修题解"，并且喂给它的是 **checker 判词**
   *      而不是"暴力解输出（期望）" —— 多解题上把另一份合法答案当期望，等于诱导它去逐字凑暴力解；
   *   ③ checker 本身不可信（自检不过 / 弃权 / 超时）→ 与改造前完全一致：停下，如实说"本地判不了"。
   * 两个夹具各用独立的工作区 key：checker 源码会落到 `<工作区>/checker/checker.py`（好让它活过
   * clearScratch 的临时区清理、下一轮直接复用），共用 key 会让两个夹具互相污染。 */
  console.log('parallel: 多解题 + 本地 checker（判得动就照判，判不动才停）');
  // 排列 checker：只判"是不是 1..n 的一个排列"，与标准答案逐字比较无关（这正是多解题需要的判据）
  const CK_PERM_PY = [
    'import sys',
    'a = open(sys.argv[1]).read().split()',
    'b = open(sys.argv[2]).read().split()',
    'n = int(a[0])',
    'try:',
    '    v = [int(x) for x in b]',
    'except Exception:',
    '    print("输出里出现了非整数"); sys.exit(2)',
    'if len(v) != n:',
    '    print("应输出 %d 个数，实际 %d 个" % (n, len(v))); sys.exit(1)',
    'if sorted(v) != list(range(1, n + 1)):',
    '    print("输出的不是 1..%d 的排列：%s" % (n, " ".join(b))); sys.exit(1)',
    'sys.exit(0)'
  ].join('\n');
  // 故意"苛刻"的 checker：要求恰好是 1 2 3 …（题面其实允许多解）。它**能通过官方样例自检**
  // （样例就是 1 2 3），所以会被采信 —— 用来验证"checker 判不合法 → 带判词走修题解"这条路。
  const CK_ORDER_PY = [
    'import sys',
    'a = open(sys.argv[1]).read().split()',
    'b = open(sys.argv[2]).read().split()',
    'n = int(a[0])',
    'want = " ".join(str(i) for i in range(1, n + 1))',
    'got = " ".join(b).strip()',
    'if got != want:',
    '    print("必须是 %s，实际是 %s" % (want, got)); sys.exit(1)',
    'sys.exit(0)'
  ].join('\n');
  const runMA = async (agent, key, samples) => harness.runPipeline({
    conv: { id: key, title: '多解题+checker' },
    lang: 'python', intent: 'full',
    statement: MA_STATEMENT,
    samples: samples || [{ input: '3', output: '1 2 3' }],
    workspace, wsKey: key,
    callAgent: agent, tiers: [4, 6], perTier: 6, bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });

  // ① checker 判"题解输出合法" → 不算不一致：不改题解、不仲裁，结论仍然如实标 multi-answer
  {
    const key = 'multi-answer-ck-ok';
    let ckOkSol = 0;
    let ckOkAdj = 0;
    let ckOkCalls = 0;
    const agentCkOk = async (opts) => {
      const sys = String(opts.system || '');
      const label = String(opts.label || '');
      if (sys.indexOf('【checker Agent】') >= 0) { ckOkCalls++; return '```python\n' + CK_PERM_PY + '\n```'; }
      if (sys.indexOf('【题解 Agent】') >= 0) { ckOkSol++; return '思路：任意排列。\n\n```python\n' + MA_SOL + '\n```'; }
      if (sys.indexOf('【暴力 Agent】') >= 0) return '暴力。\n\n```python\n' + MA_BRUTE + '\n```';
      if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + MA_GEN + '\n```';
      if (sys.indexOf('错因仲裁') >= 0 || label.indexOf('仲裁') >= 0) { ckOkAdj++; return '{"wrong":"sol","reason":"输出与样例不同"}'; }
      if (sys.indexOf('【讲解 Agent】') >= 0) {
        return '## 题面拆解\n多解题：1..n 的任意排列都合法。\n## 验证\n与暴力解输出不同**不等于**错；本轮**不能**声称已验证。';
      }
      return '{}';
    };
    const resCkOk = await runMA(agentCkOk, key);
    const tCkOk = (resCkOk.trajectory || []).map((t) => t.kind);
    ok('多解+checker：写出的 checker 通过官方样例自检后才被采信（轨迹 checker-trusted）',
      ckOkCalls === 1 && tCkOk.indexOf('checker-trusted') >= 0, { calls: ckOkCalls, traj: tCkOk.join(',') });
    ok('多解+checker：判题解输出**合法** → 这条不一致不成立（checker-ac；不再走"本地判不了"停手）',
      tCkOk.indexOf('checker-ac') >= 0 && tCkOk.indexOf('multi-answer-undecidable') < 0, tCkOk.join(','));
    ok('多解+checker：判合法就不改写题解、不花仲裁调用',
      ckOkSol === 1 && ckOkAdj === 0, { sol: ckOkSol, adj: ckOkAdj });
    ok('多解+checker：结论仍然如实标 multi-answer，且**不**声称已验证',
      resCkOk.status === 'multi-answer' && resCkOk.verification.status === 'multi-answer'
      && resCkOk.verification.multiAnswer === true && resCkOk.verification.claimVerified === false
      && resCkOk.verification.scopeComplete === false,
      { status: resCkOk.status, v: resCkOk.verification && resCkOk.verification.status,
        claim: resCkOk.verification && resCkOk.verification.claimVerified });
    ok('多解+checker：evidence 里写明"本地 checker 判题解输出合法 N 次"',
      String(resCkOk.verification.scopeNote || '').indexOf('判题解输出合法 1 次') >= 0,
      String(resCkOk.verification.scopeNote || '').slice(0, 240));
    ok('多解+checker：提醒里说明"不同来自多解性本身、不能声称已验证"',
      (resCkOk.notes || []).join('').indexOf('本地 checker') >= 0
      && (resCkOk.notes || []).join('').indexOf('合法答案') >= 0
      && (resCkOk.notes || []).join('').indexOf('不能') >= 0,
      { notes: (resCkOk.notes || []).join(' | ').slice(0, 200) });
    ok('多解+checker：checker 源码落在 <工作区>/checker/checker.py（下一轮直接复用、不用再花调用）',
      fs.existsSync(path.join(workspace.convDir(key), 'checker', 'checker.py')), workspace.convDir(key));
  }

  // ② checker 判"题解输出**不合法**" → 有背书的真反例：带 checker 判词走修题解（**不给**"暴力解期望"）
  {
    const key = 'multi-answer-ck-wa';
    let ckWaSol = 0;
    let ckWaCk = 0;
    const ckWaSolUsers = [];
    const agentCkWa = async (opts) => {
      const sys = String(opts.system || '');
      const label = String(opts.label || '');
      if (sys.indexOf('【checker Agent】') >= 0) { ckWaCk++; return '```python\n' + CK_ORDER_PY + '\n```'; }
      if (sys.indexOf('【题解 Agent】') >= 0) {
        ckWaSol++;
        ckWaSolUsers.push(String(opts.user || ''));
        return '```python\n' + (ckWaSol === 1 ? MA_SOL : MA_BRUTE) + '\n```';
      }
      if (sys.indexOf('【暴力 Agent】') >= 0) return '```python\n' + MA_BRUTE + '\n```';
      if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + MA_GEN + '\n```';
      if (sys.indexOf('错因仲裁') >= 0 || label.indexOf('仲裁') >= 0) return '{"wrong":"sol","reason":"输出与样例不同"}';
      if (sys.indexOf('【讲解 Agent】') >= 0) return '## 题面拆解\n按 checker 的判词改。\n## 验证\n已按题面上限计时。';
      return '{}';
    };
    const resCkWa = await runMA(agentCkWa, key);
    const tCkWa = (resCkWa.trajectory || []).map((t) => t.kind);
    ok('多解+checker：判题解输出**不合法** → 记下有背书的真反例（checker-wa，而不是"判不了"停手）',
      ckWaCk === 1 && tCkWa.indexOf('checker-wa') >= 0 && tCkWa.indexOf('multi-answer-undecidable') < 0,
      { ck: ckWaCk, traj: tCkWa.join(',') });
    ok('多解+checker：带着这根反例去修题解（题解 Agent 被再叫一次）',
      ckWaSol >= 2, { sol: ckWaSol });
    ok('多解+checker：修题解的提示词给的是 **checker 判词**，**不是**"暴力解输出（期望）"',
      ckWaSolUsers.length >= 2
      && ckWaSolUsers[1].indexOf('checker 的判词') >= 0
      && ckWaSolUsers[1].indexOf('必须是 1 2') >= 0
      && ckWaSolUsers[1].indexOf('暴力解输出（期望）') < 0,
      { rewriteHasJudge: ckWaSolUsers.length >= 2 && ckWaSolUsers[1].indexOf('checker 的判词') >= 0,
        rewriteHasBruteExpect: ckWaSolUsers.length >= 2 && ckWaSolUsers[1].indexOf('暴力解输出（期望）') >= 0 });
    ok('多解+checker：修好后对拍通过（checker 判不合法的那一版被真的修掉了）',
      resCkWa.status === 'ok', { status: resCkWa.status, reason: resCkWa.reason });
    ok('多解+checker：即使最后对拍通过，"与标尺逐字一致"这条判据对多解题仍不成立 → 不声称已验证',
      resCkWa.verification.multiAnswer === true && resCkWa.verification.claimVerified === false,
      { multi: resCkWa.verification && resCkWa.verification.multiAnswer,
        claim: resCkWa.verification && resCkWa.verification.claimVerified });
  }

  // ③ checker 自己不可信（自检不过）→ 必须回落到改造前行为：停下、如实说"本地判不了"
  {
    const key = 'multi-answer-ck-bad';
    let badAdj = 0;
    const agentCkBad = async (opts) => {
      const sys = String(opts.system || '');
      const label = String(opts.label || '');
      // 这份 checker 对**官方样例自己**都判 1 → 自检不过 → 绝不采信
      if (sys.indexOf('【checker Agent】') >= 0) {
        return '```python\nimport sys\nprint("永远拒绝")\nsys.exit(1)\n```';
      }
      if (sys.indexOf('【题解 Agent】') >= 0) return '```python\n' + MA_SOL + '\n```';
      if (sys.indexOf('【暴力 Agent】') >= 0) return '```python\n' + MA_BRUTE + '\n```';
      if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + MA_GEN + '\n```';
      if (sys.indexOf('错因仲裁') >= 0 || label.indexOf('仲裁') >= 0) { badAdj++; return '{"wrong":"sol","reason":"输出与样例不同"}'; }
      if (sys.indexOf('【讲解 Agent】') >= 0) return '## 题面拆解\n多解题。\n## 验证\n与样例不同不等于错。';
      return '{}';
    };
    const resCkBad = await runMA(agentCkBad, key);
    const tCkBad = (resCkBad.trajectory || []).map((t) => t.kind);
    ok('多解+checker：连官方样例都判错的 checker → 不采信（checker-untrusted，绝不拿没背书的判据改题解）',
      tCkBad.indexOf('checker-untrusted') >= 0 && tCkBad.indexOf('checker-trusted') < 0, tCkBad.join(','));
    ok('多解+checker：不可信就回落到改造前的"本地判不了"（multi-answer-undecidable、不花仲裁）',
      tCkBad.indexOf('multi-answer-undecidable') >= 0 && badAdj === 0 && resCkBad.status === 'multi-answer',
      { adj: badAdj, status: resCkBad.status, traj: tCkBad.join(',') });
  }

  /* ---------------- 数值范围：**只提醒，绝不改数据** ----------------
   * 曾经以为"机械缩放数值"是代码层的稳妥解法，结果把二进制串字段 00100010 改成 16，
   * 把整轮带沟里（仲裁判生成器有罪、白重写 3 次）。现在改成：把上限告诉生成器（argv[2]），
   * 并在"暴力解在最小档跑不动"时带着**最大数值**这条证据去提醒它收窄范围。 */
  console.log('parallel: 数值范围只提醒不改数据');
  // 生成器吐 1e9（数值超限，且**每次随机**，避免被"生成器必须每次不同"的体检重写）
  // 暴力解在最小档超时 → 带着"最大数值"这条证据让生成器收窄范围（而不是悄悄改它的数据）
  const BIG_GEN = [
    'import random, sys',
    'big = lambda: random.randint(10**8, 10**9)',
    'print(1)',
    'print(3)',
    'print(big(), big(), big())',
    'print(big(), big(), big())',
    'print(1, 2)',
    'print(2, 3)'
  ].join('\n');
  const SMALL_GEN = [
    'import random, sys',
    'print(1)',
    'print(3)',
    'print(random.randint(0,2), random.randint(0,2), random.randint(0,2))',
    'print(random.randint(1,2), random.randint(1,2), random.randint(1,2))',
    'print(1, 2)',
    'print(2, 3)'
  ].join('\n');
  // 数值大就"跑不动"的暴力解（小数值时是正确的贪心实现）——模拟"穷举型暴力被大数值拖死"
  const VALUE_SENSITIVE_BRUTE = BRUTE.replace(
    'd = sys.stdin.read().split()',
    'd = sys.stdin.read().split()\nimport time\nif any(len(x) > 4 and x.isdigit() for x in d): time.sleep(12)');
  let genCallsBig = 0;
  const callAgentBig = async (opts) => {
    const sys = String(opts.system || '');
    if (sys.indexOf('【数据生成 Agent】') >= 0) {
      genCallsBig++;
      return '```python\n' + (genCallsBig === 1 ? BIG_GEN : SMALL_GEN) + '\n```';
    }
    if (sys.indexOf('【暴力 Agent】') >= 0) return '```python\n' + VALUE_SENSITIVE_BRUTE + '\n```';
    return callAgent(opts);
  };
  const resBig = await harness.runPipeline({
    conv: { id: 'gen-big', title: '大数值数据' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'gen-big',
    callAgent: callAgentBig, tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  const bigTraj = (resBig.trajectory || []).map((t) => t.kind + ':' + String(t.note || '')).join(' | ');
  ok('数值超限：带着"最大数值"这条证据提醒生成器收窄范围（不是悄悄改数据）',
    genCallsBig >= 2 && /最大数值是 \d{6,}/.test(bigTraj) && /字符串字段/.test(bigTraj),
    { genCallsBig, traj: bigTraj.slice(0, 300) });
  ok('数值超限：生成器改小数值后对拍照常完成',
    resBig.verification && resBig.verification.status === 'ok',
    resBig.verification && { status: resBig.verification.status, reason: resBig.verification.reason });
  ok('数据完整性：整个流程里没有"机械缩放"字样（那条歧路已删除）',
    !(resBig.notes || []).some((n) => /机械缩放/.test(n)), (resBig.notes || []).slice(-3));

  /* ---------------- 预算与反复跑：真实一轮跑了 42 分钟、56 万 token 的止血 ----------------
   * 三个止血点（都有真实数据支撑）：
   *   ① 空回复重试：原来 2 次/调用 × 每次 5 分钟 → 现在 1 次/调用 + 整轮 3 次封顶
   *   ② 修正轮数：原来 8–16 轮 → 现在按难度分档兜底（4/5/6/8 轮）；真正的停手条件是
   *      lib/loopguard.js 的死循环特征（重复产物 / 来回震荡 / 连续无进展），次数只是兜底
   *   ③ 题解过了官方样例、标尺却没校准/大数值跑不动时，仲裁说"题解错"也不改题解（止损） */
  console.log('parallel: 成本止血（重试额度 / 轮数上限 / 证据不足不改题解）');
  ok('轮数上限：按难度分档封顶（低难度 4 / 2000+ 5 / 2400+ 6 / 2800+ 8，不再"一刀切 3 轮"）',
    harness.solFixBudget(1200) === 4 && harness.solFixBudget(2000) === 5
    && harness.solFixBudget(2600) === 6 && harness.solFixBudget(3400) === 8,
    [harness.solFixBudget(1200), harness.solFixBudget(2000), harness.solFixBudget(2600), harness.solFixBudget(3400)]);
  const bud = harness.makeBudget(2400);
  ok('预算：2400+ 100 次调用 / 55 分钟（2000+ 80 次/40 分钟；低难度 50 次/25 分钟）',
    bud.maxAgentCalls === 100 && bud.maxWallMs === 55 * 60 * 1000
    && harness.makeBudget(2100).maxAgentCalls === 80 && harness.makeBudget(2100).maxWallMs === 40 * 60 * 1000
    && harness.makeBudget(1200).maxAgentCalls === 50 && harness.makeBudget(1200).maxWallMs === 25 * 60 * 1000,
    { calls: bud.maxAgentCalls, wall: bud.maxWallMs });
  ok('暴力解重写：兜底次数是 2（策略停在 loopguard，不停在次数）',
    harness.makeBudget(1200).maxBruteFix === 2, { maxBruteFix: harness.makeBudget(1200).maxBruteFix });

  // 空回复风暴：每次都返回空 → 必须很快停下来（不是 2 次/调用 × N 个调用地烧）
  let emptyCalls = 0;
  const callAgentEmpty = async (opts) => {
    const sys = String(opts.system || '');
    if (sys.indexOf('【题解 Agent】') >= 0) { emptyCalls++; return ''; }
    return callAgent(opts);
  };
  const resEmpty = await harness.runPipeline({
    conv: { id: 'empty-storm', title: '空回复' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'empty-storm',
    callAgent: callAgentEmpty, tiers: [4, 6], perTier: 2,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  ok('空回复：单次调用最多重试 1 次（题解 2 次调用就收手，不是 3 次）', emptyCalls <= 2, { emptyCalls });
  ok('空回复：留档如实（trace 里"空回复"条目不超过 2 条，不是每个调用都连发 3 次）',
    (resEmpty.trace || []).filter((t) => /空回复|被截断/.test(t.label || '')).length <= 2,
    (resEmpty.trace || []).map((t) => t.label));

  /* ---------------- 死循环特征：同一版暴力解被反复"重写" → 特征检测先停手 ----------------
   * 用户复盘点出的病根：真正贵的那条路不是"重写次数上限不够"，而是**重写本身没有新信息**
   * （同一版代码又交一遍）。所以停手条件换成 lib/loopguard.js 的特征检测，次数/时间退回兜底：
   * 这一条验的就是"特征检测比次数上限先到"。 */
  console.log('parallel: 死循环特征检测（重写没有新信息就停，不烧到次数上限）');
  {
    const SAME_WRONG_BRUTE = ['import sys', 'print(0)'].join('\n');   // 永远不改的一个错解
    let bruteRewriteCalls = 0;
    const callAgentSameBrute = async (opts) => {
      const sys = String(opts.system || '');
      if (sys.indexOf('【暴力 Agent】') >= 0) {
        bruteRewriteCalls++;
        return '```python\n' + SAME_WRONG_BRUTE + '\n```';
      }
      return callAgent(opts);
    };
    const resLoop = await harness.runPipeline({
      conv: { id: 'loop-guard', title: '死循环特征' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: 'loop-guard',
      callAgent: callAgentSameBrute, tiers: [4, 6], perTier: 2,  bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
    const loopTraj = (resLoop.trajectory || []).filter((t) => t.kind === 'loop-guard');
    ok('死循环特征：同一版暴力解被重写 → 轨迹留档 loop-guard（写明是特征停手、不是次数上限）',
      loopTraj.length >= 1 && /死循环特征/.test(String(loopTraj[0].note || '')),
      { traj: (resLoop.trajectory || []).map((t) => t.kind).join(','), note: loopTraj[0] && loopTraj[0].note });
    ok('死循环特征：比次数上限先到（暴力解只调了 2 次，不是 maxBruteFix+2 次）',
      bruteRewriteCalls === 2 && harness.makeBudget(1500).maxBruteFix === 2,
      { bruteRewriteCalls, maxBruteFix: harness.makeBudget(1500).maxBruteFix });
    ok('死循环特征：提醒里也如实写了停手原因（不是静默放弃标尺）',
      (resLoop.notes || []).some((n) => /停手/.test(String(n))), (resLoop.notes || []).slice(-4));
  }

  // 证据不足不改题解：题解过样例 ✓；标尺**在样例的大数值上超时**、小数据上还算错
  // → 仲裁说"题解错"也不能拿它改题解（真实事故：这样连改 5 遍、28 分钟、56 万 token）
  const BIG_SAMPLE = '2\n3\n3 3 0\n2\n1000000000 0';
  const SLOW_BRUTE = [
    'import sys, time',
    'd = sys.stdin.read().split()',
    'p = 0; t = int(d[p]); p += 1; out = []',
    'for _ in range(t):',
    '    n = int(d[p]); p += 1',
    '    a = [int(d[p + i]) for i in range(n)]; p += n',
    '    if a and max(a) > 1000: time.sleep(12)   # 大数值样例上"慢死"（TLE），小数据很快',
    '    out.append(str(sum(x for x in a if x > 0)))   # 逻辑是错的（每个 0 只该取一张），但输出随输入变化',
    'print("\\n".join(out))'
  ].join('\n');
  let solCallsGate = 0;
  let adjCallsGate = 0;
  const callAgentGate = async (opts) => {
    const sys = String(opts.system || '');
    const label = String(opts.label || '');
    if (sys.indexOf('【题解 Agent】') >= 0) { solCallsGate++; return '```python\n' + SOL + '\n```'; }
    if (sys.indexOf('【暴力 Agent】') >= 0) return '```python\n' + SLOW_BRUTE + '\n```';
    if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + GEN + '\n```';
    if (sys.indexOf('错因仲裁') >= 0 || label.indexOf('仲裁') >= 0) {
      adjCallsGate++;
      return '{"wrong":"sol","reason":"题解低估了可达和"}';
    }
    return callAgent(opts);
  };
  const resGate = await harness.runPipeline({
    conv: { id: 'evidence-gate', title: '证据门' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: BIG_SAMPLE, output: '3\n1000000000' }],
    workspace, wsKey: 'evidence-gate',
    callAgent: callAgentGate, tiers: [4, 6], perTier: 3,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  const gateTraj = (resGate.trajectory || []).map((t) => t.kind).join(',');
  ok('证据门：题解样例结果被机械检查并留档（新增的最便宜证据）',
    /sol-samples-(pass|fail)/.test(gateTraj), gateTraj);
  ok('证据门：标尺大数值跑不动 → 不再反复重写（轨迹有 brute-big-value-skip）',
    /brute-big-value-skip/.test(gateTraj), gateTraj);
  ok('证据门：仲裁说"题解错"但证据不足 → 题解只跑最初那一次（不改）',
    solCallsGate === 1, { solCallsGate, adjCallsGate });
  ok('证据门：如实降级（不宣称验证通过），并说明"证据不足以判定题解错"',
    !(resGate.verification && resGate.verification.status === 'ok')
    && /证据不足以判定题解错/.test(String((resGate.verification || {}).reason || '')),
    { v: resGate.verification && resGate.verification.status, reason: (resGate.verification || {}).reason });

  /* ---------------- 生成器的数据必须**原样**进入对拍 ----------------
   * 真实事故：曾经在对拍前"机械把大数值缩放成小数值"，结果把二进制串字段 00100010 改成了 16，
   * 数据结构被悄悄改坏 → 仲裁判"生成器有罪" → 白白重写生成器 3 次、整轮 unverified，
   * 而生成器其实完全正确。这条不变量必须钉死：竞技场绝不修改生成器的输出。 */
  console.log('parallel: 生成器输出不得被改写（真实事故回归）');
  const BIN_GEN = [
    'import sys',
    'n = int(sys.argv[1]) if len(sys.argv) > 1 else 4',
    'print(1)',
    'print(n)',
    'print(" ".join(["0"] * n))',
    'print("00100010")'          // 长度固定为 8 的二进制串：任何"数值缩放"都会把它改坏
  ].join('\n');
  const arenaBin = await runner.openArena({
    sol: { lang: 'python', code: 'import sys\nprint(sys.stdin.read().strip().split("\\n")[-1])' },
    gen: { lang: 'python', code: BIN_GEN }
  });
  const gBin = await arenaBin.genCase(4, 20000, 6);
  arenaBin.close();
  ok('生成器输出：竞技场原样返回（二进制串 00100010 一个字符都不许改）',
    String(gBin.input || '').trim().endsWith('00100010'),
    { input: JSON.stringify(String(gBin.input || '').slice(-40)), maxTok: runner.maxNumericToken ? 'n/a' : 'n/a' });
  ok('生成器输出：超限只做"报告"（maxNumericToken 是纯读操作，不回写数据）',
    typeof runner.maxNumericToken !== 'function' || runner.maxNumericToken('00100010 7') === 100010,
    typeof runner.maxNumericToken === 'function' ? runner.maxNumericToken('00100010 7') : 'no fn');

  /* ---------------- 被截断要"换一种问法"，而且绝不给空消息 ----------------
   * 真实事故（2500 分题）：题解连续两次被长度上限截断（0 字正文、各 320 秒），
   * 链路直接 return → 消息里只剩一句"（本轮未生成文本内容）"，学员完全不知道发生了什么。
   * 两个不变量：① 截断重试必须换问法（只要代码 + 更大的输出上限），不能原样重发；
   *             ② 早期失败也必须给一段机械摘要（零 token），消息永不为空。 */
  console.log('parallel: 截断重试换问法 + 失败绝不给空消息');
  let solAsks = [];
  const callAgentTruncated = async (opts) => {
    const sys = String(opts.system || '');
    if (sys.indexOf('【题解 Agent】') >= 0) {
      solAsks.push({ user: String(opts.user || ''), maxTokens: opts.maxTokens || null });
      if (opts.onMeta) opts.onMeta({ finishReason: 'length' });   // 模拟：输出预算全花在思考上，正文被截断
      return '';
    }
    // 暴力解也拿不到代码：这条用例专门验"**没有任何可交付物**时也不许给空消息"
    // （有暴力解可交付的情况由下面"降级交付"那条用例覆盖）
    if (sys.indexOf('【暴力 Agent】') >= 0) return '';
    return callAgent(opts);
  };
  const resTrunc = await harness.runPipeline({
    conv: { id: 'trunc-fail', title: '截断失败' },
    lang: 'python', intent: 'full', statement: STATEMENT,
    samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    workspace, wsKey: 'trunc-fail',
    callAgent: callAgentTruncated, tiers: [4, 6], perTier: 2,  bruteTimeoutMs: 5000,
    emit: () => {}, log: () => {}
  });
  ok('截断：第一次按原问法，第二次换成"只要代码"的极简问法',
    solAsks.length >= 2 && !/【本次只要代码】/.test(solAsks[0].user) && /【本次只要代码】/.test(solAsks[1].user),
    solAsks.map((a) => ({ head: a.user.slice(0, 20), maxTokens: a.maxTokens })));
  ok('截断：重试时显式要一个更大的输出上限（服务商不接受会自动去掉）',
    solAsks.length >= 2 && solAsks[1].maxTokens >= 16384, solAsks.map((a) => a.maxTokens));
  ok('截断：题解拿不到代码 → 如实判失败（不假装成功）',
    resTrunc.status === 'failed' || (resTrunc.verification && resTrunc.verification.status !== 'ok'),
    { status: resTrunc.status });
  ok('截断：失败时也给一段**非空**的机械摘要（消息不会只剩一句占位）',
    typeof resTrunc.explainerText === 'string' && resTrunc.explainerText.length > 80
    && /卡在哪/.test(resTrunc.explainerText) && /可以这样做/.test(resTrunc.explainerText),
    { len: String(resTrunc.explainerText || '').length, head: String(resTrunc.explainerText || '').slice(0, 60) });
  ok('截断：机械摘要里说明"没有额外调用模型"（成本透明）',
    /没有额外调用模型/.test(String(resTrunc.explainerText || '')));

  /* ---------------- P0-② 降级交付：题解被截断，但同一轮已经生成了能过样例的暴力解 ----------------
   * 实测（2026-10 消融报告，2267B / 2267F2 / 2268A）：题解两次都被长度上限截断 → 原来直接 return 交白卷
   * （0 字节正文 + 连文档都不生成），而同一轮里**明明有暴力解**。降级口径：交付暴力解，
   * 并把"这是慢解 / 没做随机对拍 / 不是已验证的最优解"如实写进状态、轨迹与提醒。 */
  console.log('parallel: 题解被截断 → 降级交付暴力解（不许交白卷）');
  {
    let truncSolCalls = 0;
    const callAgentTruncSolOnly = async (opts) => {
      const sys = String(opts.system || '');
      if (sys.indexOf('【题解 Agent】') >= 0) {
        truncSolCalls++;
        if (opts.onMeta) opts.onMeta({ finishReason: 'length' });
        return '';
      }
      return callAgent(opts);
    };
    const resDeg = await harness.runPipeline({
      conv: { id: 'trunc-degrade', title: '截断降级' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: 'trunc-degrade',
      callAgent: callAgentTruncSolOnly, tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
    ok('降级：题解重试后仍无代码 → 交付同轮的暴力解（不交白卷）',
      truncSolCalls >= 2 && String(resDeg.solCode || '').trim() === String(BRUTE).trim(),
      { calls: truncSolCalls, head: String(resDeg.solCode || '').slice(0, 60), want: BRUTE.slice(0, 60) });
    ok('降级：验证状态如实标成 degraded-brute / unverified（绝不写 ok）',
      !!resDeg.verification && resDeg.verification.status !== 'ok' && resDeg.verification.degraded === 'brute',
      { status: resDeg.verification && resDeg.verification.status, degraded: resDeg.verification && resDeg.verification.degraded });
    ok('降级：轨迹、提醒与覆盖范围都写明"这是暴力解、没有做随机对拍"',
      (resDeg.trajectory || []).some((t) => t.kind === 'sol-truncated-fallback-brute')
      && (resDeg.notes || []).join('').indexOf('暴力解') >= 0
      && /降级/.test(String((resDeg.verification || {}).scopeNote || '')),
      { traj: (resDeg.trajectory || []).map((t) => t.kind).join(','), scope: String((resDeg.verification || {}).scopeNote || '').slice(0, 60) });
    ok('降级：消息里仍然有正文（讲解 Agent 拿到的是这份慢解）',
      typeof resDeg.explainerText === 'string' && resDeg.explainerText.length > 80,
      { len: String(resDeg.explainerText || '').length });
  }


  /* ---------------- 落码抢救：截断的根因是"想得停不下来"，把思考喂回去 + 关思考 ----------------
   * 实测（.probe/probe-sol-unblock.js / probe-salvage-quality.js，2268C/2268D/2268F）：
   * 推理模型在无上限的首轮会把 65,536 输出 token 全烧在思考上、正文 0 字符（182848 那批 7/9 = 78%）；
   * 预填代码骨架、"先写一行注释"的提示词都拽不动它，唯一有效的是关思考（reasoning_effort='none'），
   * 而"把上一轮思考的尾巴当输入喂回去 + 关思考"才能保住它已经想好的做法
   * （2268D r2600：考 4096 + 落码 4528 → 真解，样例与差分双 AC，¥0.179/题）。
   * ⚠️ 2026-10-07 重跑该探针**未复现**这条：2268C/2268D 两道都 WA（差分 AC 0/2）。而且这个探针的
   * A 步用的是**生产环境当时的题解提示词**（后来被改成"只交代码"），所以它测的是"当时的问法 + 抢救"，
   * 不能当现状依据。见 docs/retry-bottleneck-2026-10.md §5.2。 */
  console.log('parallel: 题解被截断 → 落码抢救（喂回思考 + 关思考）');
  {
    const TAIL = 'THINKING-TAIL-42：用 Trie 维护前缀集合，离线反向建图求最长路';
    const PROSE_TAIL = 'THINKING-TAIL-77：讲解要先做手算演示，再给算法与复杂度';
    const salvageAsks = [];
    const proseAsks = [];
    const seenRoles = [];
    // 机械类非代码角色（讲解提纲 / 手算锚点 / 错因仲裁）与"写交付物"的讲解 Agent 要分开看：
    // 前者压预算，后者是产品本身，压了就毁交付物。**必须在跑完之后再算**（seenRoles 是逐次调用累积的）。
    const mechRoles = () => seenRoles.filter((r) => r.role !== '讲解 Agent' && r.role.indexOf('题解') < 0
      && r.role.indexOf('暴力') < 0 && r.role.indexOf('数据生成') < 0);
    const callAgentSalvage = async (opts) => {
      const sys = String(opts.system || '');
      const m = sys.match(/【([^】]+)】/);
      seenRoles.push({ role: m ? m[1] : 'unknown', maxTokens: opts.maxTokens || null, effort: opts.reasoningEffort || null });
      if (sys.indexOf('【讲解 Agent】') >= 0) {
        // 非代码角色同样会"想得停不下来"：第一次预算全花在思考上、正文 0 字符
        proseAsks.push({ user: String(opts.user || ''), maxTokens: opts.maxTokens || null, effort: opts.reasoningEffort || null });
        if (proseAsks.length === 1) {
          if (opts.onMeta) opts.onMeta({ finishReason: 'length', reasoningTail: PROSE_TAIL });
          return '';
        }
        return '## 题面拆解\n把材料写成文。\n## 验证\n官方样例通过。';
      }
      if (sys.indexOf('【题解 Agent】') >= 0) {
        salvageAsks.push({ user: String(opts.user || ''), maxTokens: opts.maxTokens || null, effort: opts.reasoningEffort || null });
        if (salvageAsks.length === 1) {
          // 第一次：预算全花在思考上、正文为空，但**思考尾巴拿到了**（这就是抢救的输入）
          if (opts.onMeta) opts.onMeta({ finishReason: 'length', reasoningTail: TAIL });
          return '';
        }
        return '想好了，落成代码。\n\n```python\n' + SOL + '\n```';
      }
      return callAgent(opts);
    };
    const resSalv = await harness.runPipeline({
      conv: { id: 'salvage', title: '落码抢救' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: 'salvage',
      callAgent: callAgentSalvage, tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
    ok('落码抢救：被截断的代码角色，第二次尝试把上一轮思考喂回去（提示词里带着思考尾巴）',
      salvageAsks.length >= 2 && salvageAsks[1].user.indexOf(TAIL) >= 0,
      salvageAsks.map((a) => ({ tail: a.user.indexOf(TAIL) >= 0, maxTokens: a.maxTokens, effort: a.effort })));
    ok('落码抢救：第二次尝试关掉思考（reasoning_effort=none，实测唯一有效的手段；不传就只是换个问法）',
      salvageAsks.length >= 2 && salvageAsks[1].effort === 'none' && !salvageAsks[0].effort,
      salvageAsks.map((a) => a.effort));
    ok('落码抢救：仍然叠加"【本次只要代码】"的极简问法（两层约束同时生效）',
      salvageAsks.length >= 2 && /【本次只要代码】/.test(salvageAsks[1].user));
    ok('成本：代码类角色首轮就带上限 8192（首轮给太大 = 想不完就被截断，尾巴是半截推导），抢救时才给到 65536',
      salvageAsks.length >= 2 && salvageAsks[0].maxTokens === 8192 && salvageAsks[1].maxTokens === 65536,
      salvageAsks.map((a) => a.maxTokens));
    ok('成本：非代码角色有自己的预算（首轮 16384、抢救 32768），绝不会拿到代码角色的 8192/65536',
      mechRoles().length >= 1 && mechRoles().every((r) => r.maxTokens === 16384 || r.maxTokens === 32768),
      mechRoles());
    ok('成本：写交付物的讲解 Agent 首轮拿到 131072 的天花板（服务商默认只给 65,536，实测给够上限后一次写完 92,007 token；'
      + '不给够就会 65,536 截断 → 抢救 → 回落重写，实测烧到 178K 还把交付物退化成 Markdown）',
      proseAsks.length >= 2 && proseAsks[0].maxTokens === 131072 && proseAsks[1].maxTokens === 32768,
      proseAsks.map((a) => a.maxTokens));
    ok('落文抢救：非代码角色被截断也走同一条路（喂回思考尾巴 + 关思考，否则 65,536 全是白烧）',
      proseAsks.length >= 2 && proseAsks[1].user.indexOf(PROSE_TAIL) >= 0 && proseAsks[1].effort === 'none',
      proseAsks.map((a) => ({ tail: a.user.indexOf(PROSE_TAIL) >= 0, effort: a.effort })));
    // 讲解的**机械修复**（修讲解结构 / 修图文文档 / Markdown 回落）是"按校验错误把文档重写一遍"，
    // 实测关思考 15-19 秒就写出 5.7K-11.8K 字符的合格文档，而带思考的同一角色单次要 30-65K 输出 token。
    ok('成本：讲解的机械修复/回落重写用关思考 + 16384（不是再烧一次 30-65K 的思考）',
      proseAsks.length >= 3 && proseAsks.slice(2).every((a) => a.maxTokens === 16384 && a.effort === 'none'),
      proseAsks.map((a) => ({ maxTokens: a.maxTokens, effort: a.effort, len: a.user.length })));
    ok('落码抢救：拿到代码 → 这一轮算成功，不再降级交付暴力解',
      String(resSalv.solCode || '').trim() === SOL.trim()
      && !(resSalv.verification && resSalv.verification.degraded === 'brute'),
      { head: String(resSalv.solCode || '').slice(0, 40), status: resSalv.verification && resSalv.verification.status });
    ok('落码抢救：轨迹写清楚"这一版是抢救回来的"（事后能看出钱花在哪）',
      (resSalv.trace || []).some((t) => /落码抢救/.test(t.label))
      && (resSalv.trace || []).some((t) => /落码抢救/.test(String(t.note || ''))),
      (resSalv.trace || []).map((t) => t.label).join(' | '));
    ok('落文抢救：非代码角色的抢救同样在轨迹里留痕（讲解这类角色的花销也要能事后对账）',
      (resSalv.trace || []).some((t) => /落文抢救/.test(t.label))
      && (resSalv.trace || []).some((t) => /落文抢救/.test(String(t.note || ''))),
      (resSalv.trace || []).map((t) => t.label).join(' | '));
  }

  /* ---------------- 实验旋钮 docEffort：让写交付物的角色也关思考 ----------------
   * 实测（.probe/probe-doc-cost.js）：关思考写一份合格图文文档只要 3.5-5K 输出 token、15-19 秒，
   * 带思考的同一角色单次要 30-65K。代价是"想得少"，所以默认关，只有跑分的人显式
   * `ablation/run.js --doc-effort none` 才打开 —— 这里锁住它真的生效（这类"旋钮写了但没接线"
   * 的 bug 已经栽过一次：探针里把 reasoning_effort 写错键名，结果"关思考"那一路其实开着思考）。 */
  console.log('parallel: 讲解关思考的实验旋钮（--doc-effort none）');
  {
    const docAsks = [];
    const callAgentDocEffort = async (opts) => {
      const sys = String(opts.system || '');
      if (sys.indexOf('【讲解 Agent】') >= 0) {
        docAsks.push({ maxTokens: opts.maxTokens || null, effort: opts.reasoningEffort || null });
        return '## 题面拆解\n材料写成文。\n## 验证\n官方样例通过。';
      }
      return callAgent(opts);
    };
    await harness.runPipeline({
      conv: { id: 'doceffort', title: '讲解关思考' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: 'doceffort', docEffort: 'none',
      callAgent: callAgentDocEffort, tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
    ok('实验旋钮：docEffort=none 时讲解 Agent 首轮就关思考并拿 16384（默认臂是带思考 + 131072；'
      + '探针实测关思考文档 3.5-5K token，带思考 30-65K）',
      docAsks.length >= 1 && docAsks[0].effort === 'none' && docAsks[0].maxTokens === 16384,
      docAsks);
  }

  /* ---------------- 实验旋钮 codeEffort：让代码角色首轮也关思考 ----------------
   * 依据（`.probe/probe-sol-arms.js`，真判分 = 官方样例 + 与 oracle 200 组差分）：
   * 带思考的题解角色把 8192 全烧在思考上、正文 0 字符（思考 26K-31K 字符被切断，靠"落码抢救"
   * 把半截推导落成代码），而**同一问法关思考直接出码**只要 6259/4586 输出 token（带思考 9538/12804），
   * 判分一点不更差（2268D 两臂都过样例、都差分 WA；2268C 两臂都 WA）⇒ 截断家族里唯一便宜的杠杆。
   * 旋钮默认关（不传 codeEffort 就是老行为），这里把两端都钉住。 */
  console.log('\nparallel: 题解关思考的实验旋钮（--code-effort none）');
  {
    const asks = [];
    const bruteAsks = [];
    const mkEffAgent = (tag) => async (opts) => {
      const sys = String(opts.system || '');
      if (sys.indexOf('【题解 Agent】') >= 0) {
        asks.push({ tag, effort: opts.reasoningEffort || null, maxTokens: opts.maxTokens || null });
      } else if (sys.indexOf('【暴力 Agent】') >= 0) {
        bruteAsks.push({ tag, effort: opts.reasoningEffort || null });
      }
      return callAgent(opts);
    };
    const runEffort = (codeEffort, key) => harness.runPipeline({
      conv: { id: key, title: '题解关思考' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: key, codeEffort,
      callAgent: mkEffAgent(codeEffort || 'default'), tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });
    const rEffOn = await runEffort('none', 'codeeffort-on');
    const onFirst = asks.filter((a) => a.tag === 'none')[0] || null;
    ok('实验旋钮：codeEffort=none 时题解 Agent 首轮就关思考并拿 8192（探针实测关思考 6259/4586 '
      + '输出 token vs 带思考 9538/12804，判分不更差）',
      !!onFirst && onFirst.effort === 'none' && onFirst.maxTokens === 8192, { onFirst, asks });
    const rEffOff = await runEffort('', 'codeeffort-off');
    const offFirst = asks.filter((a) => a.tag === 'default')[0] || null;
    ok('对照：不传 codeEffort 时题解 Agent 首轮照旧带思考（老行为一个字都不改）',
      !!offFirst && !offFirst.effort, { offFirst, asks });
    ok('两条臂的题解代码一致（这条旋钮只改"想不想"，不改交付物本身）',
      !!(rEffOn.solCode && rEffOff.solCode) && String(rEffOn.solCode).trim() === String(rEffOff.solCode).trim(),
      { on: String(rEffOn.solCode || '').slice(0, 40), off: String(rEffOff.solCode || '').slice(0, 40) });
    const bruteOn = bruteAsks.filter((a) => a.tag === 'none')[0] || null;
    ok('收窄：codeEffort=none 只关**题解角色**的思考，暴力解（尺子）照旧带思考'
      + '（2026-10-10 实测踩到过"连尺子一起关"的三变量混淆）',
      !!bruteOn && !bruteOn.effort, { bruteOn, bruteAsks });
  }

  /* ---------------- 交付前性能闸：算法对但最大规模超时的题，不许说"已验证" ----------------
   * 真实丢分（两机消融 + 14 题对照）：2247D2 与 oracle 逐 token 相同但最大档 7.33× 于 oracle、
   * 2250C 交付的代码连样例都超时；我们的链只在小规模对拍，从不按题面真实上限计时。
   * 这里用一条**写着官方时限**的题面 + 一个"只在大 n 慢"的题解验证两条：
   *   ① 超时 → claimVerified=false + 轨迹 perf-gate-slow；② 不超时 → perf-gate-pass + 仍为 true。 */
  console.log('\nparallel: 交付前性能闸（按题面上限计时一次）');
  {
    const oldGateMaxN = process.env.CFCOACH_PERF_GATE_MAXN;
    const oldGateFactor = process.env.CFCOACH_PERF_GATE_FACTOR;
    process.env.CFCOACH_PERF_GATE_MAXN = '200';   // 真实上限 2·10^5，测试里缩到 200（秒级完成）
    process.env.CFCOACH_PERF_GATE_FACTOR = '2';
    try {
      const GATE_STATEMENT = STATEMENT + '\n\ntime limit per test: 1 second\nmemory limit per test: 256 megabytes';
      // 生成器按 argv[1]（规模档）产数据：性能闸会拿 maxN=200 要一组数据。
      // 注意：大规模档必须**确定性地**给满规模（否则"最大规模超时"这条断言会随机不触发）。
      const GATE_GEN = [
        'import random, sys',
        'm = int(sys.argv[1]) if len(sys.argv) > 1 else 8',
        'n = m if m > 8 else random.randint(1, max(1, m))',
        'print(1)',
        'print(n)',
        'print(*[random.randint(0, 6) for _ in range(n)])'
      ].join('\n');
      // 只在大 n 慢（小数据完全正确）——"算法对、最大规模超时"的最小复现
      const GATE_SLOW_SOL = SOL
        .replace('import sys, heapq', 'import sys, heapq, time')
        .replace('    n = int(d[p]); p += 1', '    n = int(d[p]); p += 1\n    if n > 50: time.sleep(6)');
      const mkGateAgent = (sol) => async (opts) => {
        const sys = String(opts.system || '');
        if (sys.indexOf('【题解 Agent】') >= 0) return '```python\n' + sol + '\n```';
        if (sys.indexOf('【暴力 Agent】') >= 0) return '```python\n' + BRUTE + '\n```';
        if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + GATE_GEN + '\n```';
        return callAgent(opts);
      };
      const runGate = (wsKey, sol) => harness.runPipeline({
        conv: { id: wsKey, title: '性能闸' },
        lang: 'python', intent: 'full', statement: GATE_STATEMENT,
        samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
        workspace, wsKey,
        callAgent: mkGateAgent(sol), tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
        emit: () => {}, log: () => {}
      });
      const resSlow = await runGate('perfgate-slow', GATE_SLOW_SOL);
      const trajSlow = (resSlow.trajectory || []).map((t) => t.kind).join(',');
      const vSlow = resSlow.verification || {};
      ok('性能闸：最大规模超时 → 轨迹留证 perf-gate-slow，且不许声称"已验证"',
        /perf-gate-slow/.test(trajSlow) && vSlow.status === 'ok'
        && vSlow.claimVerified === false && vSlow.scopeComplete === false,
        { traj: trajSlow, status: vSlow.status, claim: vSlow.claimVerified, scope: vSlow.scopeComplete });
      ok('性能闸：覆盖范围如实写明"最大档计时没过"（讲解据此降级）',
        /最大档计时没过/.test(String(vSlow.scopeNote || '')) && /超过|超时/.test(String(vSlow.scopeNote || '')),
        String(vSlow.scopeNote || '').slice(0, 200));
      // 口径来源必须记账：题面是中文全角括号（解析不出），env 又是显式覆盖 ⇒ 只能说是"A/B 指定的档"，
      // 绝不许写成"按题面上限计时"（那正是 2250C 假已验证的病根）。
      ok('性能闸：env 显式覆盖时，记录与文案都说清是"A/B 指定的最大档"（不冒充题面上限）',
        vSlow.perfGate && vSlow.perfGate.source === 'override' && vSlow.perfGate.n === 200
        && vSlow.perfGate.maxV === 1000000000
        && /A\/B 指定的最大档/.test(String(vSlow.scopeNote || ''))
        && !/按题面解析出的上限/.test(String(vSlow.scopeNote || '')),
        { gate: vSlow.perfGate, note: String(vSlow.scopeNote || '').slice(0, 220) });
      /* 多档抽取（§6.9）：第一份就超时 ⇒ 停手（那已经是判据），不再白抽后面两份。
       * 反过来也说明"抽得多"不会把失败的格子拖成 3 倍时长。 */
      ok('多档抽取：第一份就超时 ⇒ 只抽了 1 份（早停，别白烧时间）',
        !!(vSlow.perfGate && vSlow.perfGate.cases === 1 && vSlow.perfGate.msEach.length === 1
          && vSlow.perfGate.timedOut === true),
        vSlow.perfGate);

      const resFast = await runGate('perfgate-pass', SOL);
      const trajFast = (resFast.trajectory || []).map((t) => t.kind).join(',');
      const vFast = resFast.verification || {};
      ok('性能闸：不超时 → 轨迹 perf-gate-pass，claimVerified 仍为 true',
        /perf-gate-pass/.test(trajFast) && vFast.status === 'ok'
        && vFast.claimVerified === true && vFast.scopeComplete === true,
        { traj: trajFast, status: vFast.status, claim: vFast.claimVerified, scope: vFast.scopeComplete });
      ok('性能闸：通过的格子也把口径来源记进 perfGate（source/n/maxV）',
        vFast.perfGate && vFast.perfGate.source === 'override' && vFast.perfGate.n === 200
        && vFast.perfGate.maxV === 1000000000,
        vFast.perfGate);
      /* 多档抽取（§6.9）：一份随机数据只是一次抽样 ⇒ 不超时的格子必须**抽满** N 份取最慢，
       * 而且这件事要写在覆盖范围里（"实测 200ms"是"最慢那一份 200ms"，不是"这一份 200ms"）。 */
      ok('多档抽取：不超时的格子抽满 3 份最大档数据取最慢，并逐份记账',
        !!(vFast.perfGate && vFast.perfGate.cases === 3 && Array.isArray(vFast.perfGate.msEach)
          && vFast.perfGate.msEach.length === 3
          && vFast.perfGate.ms === Math.max.apply(null, vFast.perfGate.msEach)),
        vFast.perfGate);
      ok('多档抽取：覆盖范围写明"抽了 3 份数据取最慢：…"，不把一次抽样说成结论',
        /抽了 3 份数据取最慢：\d+\/\d+\/\d+ms/.test(String(vFast.scopeNote || '')),
        String(vFast.scopeNote || '').slice(0, 260));

      /* 第三种：**实测已经超过题面时限、但还在 2× 容差内**通过。
       * 这就是 2250C 的现役现场：闸实测 2072ms / 时限 2000ms ⇒ 记 ok=true，而 CF-AC 尺子判 slow。
       * 容差是给机器快慢留的，这种格子不算失败，但**不许只写"已验证"了事**，必须把实测超时限说出来。 */
      const GATE_EDGE_SOL = SOL
        .replace('import sys, heapq', 'import sys, heapq, time')
        .replace('    n = int(d[p]); p += 1', '    n = int(d[p]); p += 1\n    if n > 50: time.sleep(1.2)');
      const resEdge = await runGate('perfgate-overtl', GATE_EDGE_SOL);
      const trajEdge = (resEdge.trajectory || []).map((t) => t.kind).join(',');
      const vEdge = resEdge.verification || {};
      ok('性能闸：实测已超题面时限但在容差内 → 仍算通过，但必须留下 overTl 证据',
        /perf-gate-pass/.test(trajEdge) && vEdge.claimVerified === true
        && !!(vEdge.perfGate && vEdge.perfGate.ok === true && vEdge.perfGate.overTl === true
          && vEdge.perfGate.ms > vEdge.perfGate.tlMs),
        { traj: trajEdge, gate: vEdge.perfGate });
      ok('性能闸：容差内超时限时，覆盖范围与讲解备注都照实说"已经超过题面时限"',
        /已经超过题面时限/.test(String(vEdge.scopeNote || ''))
        && /已经超过题面时限/.test((resEdge.notes || []).join('\n')),
        { note: String(vEdge.scopeNote || '').slice(0, 240), notes: (resEdge.notes || []).length });
    } finally {
      if (oldGateMaxN === undefined) delete process.env.CFCOACH_PERF_GATE_MAXN;
      else process.env.CFCOACH_PERF_GATE_MAXN = oldGateMaxN;
      if (oldGateFactor === undefined) delete process.env.CFCOACH_PERF_GATE_FACTOR;
      else process.env.CFCOACH_PERF_GATE_FACTOR = oldGateFactor;
    }
  }

  /* ---------------- 性能闸的口径：必须按**题面解析出的上限**计时 ------------------
   * 病根（2026-10-10 真实 A/B 撞出来的活例子，docs/why-we-lag-2026-10-09.md §6.7）：
   *   2250C 题面是 n ≤ 5000、a_i ≤ 1e9，可闸拿自造的 n=200000 + valueCapFor=200 跑出 134ms
   *   就写了 claimVerified（文案还写"按题面上限计时"）；CF-AC 尺子在真实上限上是 3.8s > TL2000。
   * 这里用**英文题面**（正则要 ASCII 括号）走通两条：
   *   ① 解析得出 n 与值域 → perfGate 记 source=parsed/n=5000/maxV=1e9，文案敢说"题面解析出的上限"；
   *   ② 只解析得出 n → source=partial（值域兜底 1e9），文案必须自己写明"兜底"。 */
  console.log('\nparallel: 性能闸按题面解析出的上限计时（口径不许自造）');
  {
    const oldMaxN = process.env.CFCOACH_PERF_GATE_MAXN;
    const oldMaxV = process.env.CFCOACH_PERF_GATE_MAXV;
    const oldFactor2 = process.env.CFCOACH_PERF_GATE_FACTOR;
    delete process.env.CFCOACH_PERF_GATE_MAXN;   // 不覆盖 ⇒ 题面解析说了算（生产路径就是这个形状）
    delete process.env.CFCOACH_PERF_GATE_MAXV;
    process.env.CFCOACH_PERF_GATE_FACTOR = '2';
    try {
      const EN_PARSED = [
        'You are given n cards, each with a non-negative integer.',
        'When you meet a 0, you may take the largest positive card you have not taken yet; maximize the total you take.',
        '',
        'Input',
        'The first line contains t (1 <= t <= 10).',
        'Each test case starts with n (1 <= n <= 5000), then n integers a_i (1 <= a_i <= 10^9).',
        '',
        'Output',
        'For each test case print one integer.',
        '',
        'time limit per test: 2 seconds',
        'memory limit per test: 256 megabytes'
      ].join('\n');
      const EN_PARTIAL = [
        'You are given n cards, each with a non-negative integer.',
        '',
        'Input',
        'The first line is t (1 <= t <= 10). Each test case: n (1 <= n <= 100) then n integers.',
        '',
        'Output',
        'One integer per test case.',
        '',
        'time limit per test: 2 seconds'
      ].join('\n');
      const EN_GEN = [
        'import random, sys',
        'm = int(sys.argv[1]) if len(sys.argv) > 1 else 8',
        'n = m if m > 8 else random.randint(1, max(1, m))',
        'print(1)',
        'print(n)',
        'print(*[random.randint(0, 6) for _ in range(n)])'
      ].join('\n');
      const EN_SLOW_SOL = SOL
        .replace('import sys, heapq', 'import sys, heapq, time')
        .replace('    n = int(d[p]); p += 1', '    n = int(d[p]); p += 1\n    if n > 50: time.sleep(6)');
      const mkEnAgent = async (opts) => {
        const sys = String(opts.system || '');
        if (sys.indexOf('【题解 Agent】') >= 0) return '```python\n' + EN_SLOW_SOL + '\n```';
        if (sys.indexOf('【暴力 Agent】') >= 0) return '```python\n' + BRUTE + '\n```';
        if (sys.indexOf('【数据生成 Agent】') >= 0) return '```python\n' + EN_GEN + '\n```';
        return callAgent(opts);
      };
      const runEnGate = (wsKey, statement) => harness.runPipeline({
        conv: { id: wsKey, title: '性能闸口径' },
        lang: 'python', intent: 'full', statement,
        samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
        workspace, wsKey,
        callAgent: mkEnAgent, tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
        emit: () => {}, log: () => {}
      });

      const rEn = await runEnGate('perfgate-parsed', EN_PARSED);
      const vEn = rEn.verification || {};
      const noteEn = String(vEn.scopeNote || '');
      const trajEn = (rEn.trajectory || []).map((t) => t.kind).join(',');
      ok('性能闸口径：题面解析出的上限被真的用上（perfGate source=parsed、n=5000、maxV=1e9）',
        !!(vEn.perfGate && vEn.perfGate.source === 'parsed' && vEn.perfGate.n === 5000
          && vEn.perfGate.maxV === 1000000000),
        vEn.perfGate);
      ok('性能闸口径：覆盖范围敢写"按题面解析出的上限"（含 n≈5000、值≤1e9）',
        /按题面解析出的上限/.test(noteEn) && /n≈5000/.test(noteEn) && /值≤1e9/.test(noteEn),
        noteEn.slice(0, 220));
      ok('性能闸口径：真实上限上超时 → perf-gate-slow（不再被自造的小档放过），claimVerified=false',
        /perf-gate-slow/.test(trajEn) && vEn.claimVerified === false && vEn.scopeComplete === false,
        { traj: trajEn, claim: vEn.claimVerified });
      ok('性能闸口径：题面解析出的上限也进了证据字段（scaleNotes 有解析痕迹）',
        !!(vEn.perfGate && Array.isArray(vEn.perfGate.scaleNotes)),
        vEn.perfGate && vEn.perfGate.scaleNotes);

      const rPa = await runEnGate('perfgate-partial', EN_PARTIAL);
      const vPa = rPa.verification || {};
      const notePa = String(vPa.scopeNote || '');
      ok('性能闸口径：只解析得出 n → source=partial、n=100、值域兜底 1e9',
        !!(vPa.perfGate && vPa.perfGate.source === 'partial' && vPa.perfGate.n === 100
          && vPa.perfGate.maxV === 1000000000),
        vPa.perfGate);
      ok('性能闸口径：部分解析时文案写明"兜底"（不把兜底的值域说成题面给的）',
        /兜底/.test(notePa) && !/按题面解析出的上限/.test(notePa),
        notePa.slice(0, 220));
    } finally {
      if (oldMaxN === undefined) delete process.env.CFCOACH_PERF_GATE_MAXN;
      else process.env.CFCOACH_PERF_GATE_MAXN = oldMaxN;
      if (oldMaxV === undefined) delete process.env.CFCOACH_PERF_GATE_MAXV;
      else process.env.CFCOACH_PERF_GATE_MAXV = oldMaxV;
      if (oldFactor2 === undefined) delete process.env.CFCOACH_PERF_GATE_FACTOR;
      else process.env.CFCOACH_PERF_GATE_FACTOR = oldFactor2;
    }
  }

  /**
   * 多题并行 = 不同题号真的同时跑 + 同一道题绝不并发改同一批文件。
   * 这两条由两个底座保证：lib/serialqueue.js（串行队列）与 workspace.withKeyLock（按 key 分链）。
   */
  console.log('\nparallel: 串行队列（CF 抓取窗口与工作区锁的底座）');
  {
    const { createSerialQueue } = require('../lib/serialqueue');
    const q = createSerialQueue();
    let running = 0;
    let maxRunning = 0;
    const order = [];
    const mk = (id, ms, boom) => () => new Promise((res, rej) => {
      running++; maxRunning = Math.max(maxRunning, running);
      order.push('start' + id);
      setTimeout(() => {
        running--; order.push('end' + id);
        if (boom) rej(new Error('boom' + id)); else res(id);
      }, ms);
    });
    const r = await Promise.allSettled([q.push(mk(1, 60)), q.push(mk(2, 20, true)), q.push(mk(3, 10))]);
    ok('串行队列：严格按入队顺序执行、绝不重叠（共享窗口的前提）',
      maxRunning === 1 && order.join(',') === 'start1,end1,start2,end2,start3,end3', { maxRunning, order });
    ok('串行队列：返回值按各自的 promise 交给调用方', r[0].value === 1 && r[2].value === 3,
      r.map((x) => x.status));
    ok('串行队列：中间一个抛错原样上报，且不卡住后面的任务',
      r[1].status === 'rejected' && /boom2/.test(String((r[1].reason && r[1].reason.message) || '')),
      r.map((x) => x.status));
    ok('串行队列：排空后 pending 归零', q.pending === 0, q.pending);

    // 工作区锁：同一道题（同 key）串行、不同题（不同 key）并行
    let same = 0;
    let maxSame = 0;
    let all = 0;
    let maxAll = 0;
    const task = (key, id, ms) => workspace.withKeyLock(key, async () => {
      all++; maxAll = Math.max(maxAll, all);
      if (key === 'cf-1000A') { same++; maxSame = Math.max(maxSame, same); }
      await new Promise((res) => setTimeout(res, ms));
      all--; if (key === 'cf-1000A') same--;
      return id;
    });
    const got = await Promise.all([task('cf-1000A', 'a', 80), task('cf-1000A', 'b', 20), task('cf-1000B', 'c', 60)]);
    ok('工作区锁：同一道题串行（两个会话不会同时改同一批文件）', maxSame === 1, { maxSame });
    ok('工作区锁：不同的题并行（另一道题不被前一道题挡住）', maxAll >= 2, { maxAll });
    ok('工作区锁：返回值原样透传', got.join(',') === 'a,b,c', got);
    ok('工作区锁：排空后不留下残留队列（不留内存增长）', workspace.lockedKeys().length === 0, workspace.lockedKeys());
  }


  /* ---------- 官方样例定向修复（2026-10-09 批次①） ----------
   * 取证：本机库 14/52 格题解没过官方样例，其中 9 格是"修一次、重写版仍不过样例 → 拒绝并停止"
   * （终局原因原文"题解的一次重写没有通过官方样例（WA）→ 已拒绝这次重写并停止"），而这些格子
   * 只花了 10–12 次调用（预算档允许 50–130 次）。官方样例是唯一带官方背书的反例。
   * 这里用"第一版算错、第二次才对"的假模型验证两件事：
   *  · 样例失败 → 带着这组官方反例定向修一次 → 通过 → 链条继续跑完并给出"已验证"；
   *  · 修不动时次数被**整轮上限**卡住（不会无上限烧调用），且验证口径如实降级。 */
  {
    // 错法：把"遇到 0 取走最大正数牌"做成了"把所有正数加起来"（依赖输入，不是硬编码常量）
    const SOL_WRONG = [
      'import sys',
      'd = sys.stdin.read().split()',
      'p = 0; t = int(d[p]); p += 1; out = []',
      'for _ in range(t):',
      '    n = int(d[p]); p += 1',
      '    s = 0',
      '    for _ in range(n):',
      '        x = int(d[p]); p += 1',
      '        if x > 0: s += x',
      '    out.append(str(s))',
      'print("\\n".join(out))'
    ].join('\n');
    const EXPLAINER = '## 题面拆解\nx\n## 关键观察\nx\n## 为什么\nx\n## 手算演示\n拿 n=2 举例\n'
      + '<viz-steps title="t"><viz-step title="第 1 步">a</viz-step></viz-steps>\n'
      + '## 算法\nx\n## 复杂度分析\n$O(n\\log n)$\n'
      + '<viz-formula title="复杂度" fx="$T(n)=O(n\\log n)$" legend="n" why="堆"/>\n'
      + '## 代码\n```python\n' + SOL + '\n```\n## 讲解\nx\n## 易错点\nx\n'
      + '<viz-callout type="danger" title="易错">x</viz-callout>\n## 验证\n官方样例通过。';
    const mkAgent = (solFor) => {
      let n = 0;
      const f = async (opts) => {
        const sys = String(opts.system || '');
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        if (sys.indexOf('【题解 Agent】') >= 0) { n++; await delay(20); return '```python\n' + solFor(n) + '\n```'; }
        if (sys.indexOf('【暴力 Agent】') >= 0) { await delay(20); return '```python\n' + BRUTE + '\n```'; }
        if (sys.indexOf('【数据生成 Agent】') >= 0) { await delay(10); return '```python\n' + GEN + '\n```'; }
        if (sys.indexOf('【讲解 Agent】') >= 0) { await delay(10); return EXPLAINER; }
        return '{}';
      };
      f.solCalls = () => n;
      return f;
    };
    const runFix = async (agent, key) => harness.runPipeline({
      conv: { id: key, title: '样例修复测试' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: key,
      callAgent: agent, tiers: [4, 6], perTier: 3, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });

    console.log('parallel: 官方样例失败 → 带着官方反例定向修题解');
    delete process.env.CFCOACH_SAMPLE_FIX;
    delete process.env.CFCOACH_SAMPLE_FIX_MAX;
    const aFix = mkAgent((n) => (n === 1 ? SOL_WRONG : SOL));
    const rFix = await runFix(aFix, 'sample-fix-ok');
    const kFix = (rFix.trajectory || []).map((t) => t.kind);
    ok('样例修复：第一版真的没通过官方样例（记了 sol-samples-fail）',
      kFix.indexOf('sol-samples-fail') >= 0, kFix);
    ok('样例修复：定向修一次后通过（sol-sample-fix-ok）',
      kFix.indexOf('sol-sample-fix-ok') >= 0
      && /修复 1 次后通过/.test(String(((rFix.trajectory || []).find((t) => t.kind === 'sol-sample-fix-ok') || {}).note || '')),
      (rFix.trajectory || []).filter((t) => /sol-sample-fix/.test(t.kind)));
    ok('样例修复：这次修复真的花了一次题解调用（可审计）',
      aFix.solCalls() === 2
      && (rFix.trace || []).filter((t) => t.role === 'solution' && /官方样例/.test(String(t.label || ''))).length === 1,
      { solCalls: aFix.solCalls(), labels: (rFix.trace || []).filter((t) => t.role === 'solution').map((t) => t.label) });
    ok('样例修复：修好之后链条继续跑完，验证结论是"已验证"（没有被样例失败掐断）',
      !!rFix.verification && rFix.verification.status === 'ok'
      && rFix.verification.solSamplesPass === true && rFix.verification.claimVerified === true,
      rFix.verification);
    /* 交付物自带「系统实测」附录：反例与验证范围由验证链写入，不靠模型转述。
     * 实测（.probe/counterexample-census.js）：19 个带最小反例的格子里只有 1 格在正文引用了它。 */
    const bodyFix = String(rFix.explainerText || '');
    ok('交付物自带「系统实测」附录（验证范围由验证链写入，不是模型转述）',
      bodyFix.indexOf(explaindoc.APPENDIX_HEAD) >= 0 && /验证范围（机器记录）/.test(bodyFix)
      && kFix.indexOf('explain-appendix') >= 0,
      { kinds: kFix.filter((k) => /explain/.test(k)), tail: bodyFix.slice(-120) });
    ok('交付物：附录在模型正文之后（正文照旧走结构校验）',
      bodyFix.indexOf('## 题面拆解') >= 0
      && bodyFix.indexOf('## 题面拆解') < bodyFix.indexOf(explaindoc.APPENDIX_HEAD),
      { head: bodyFix.slice(0, 40), at: bodyFix.indexOf(explaindoc.APPENDIX_HEAD) });
    ok('交付物：附录里的结论与链条口径一致（已验证 / 部分验证都不是模型说了算）',
      /结论：(已验证|部分验证|未验证通过)/.test(bodyFix),
      bodyFix.slice(bodyFix.indexOf(explaindoc.APPENDIX_HEAD)).slice(0, 300));

    console.log('parallel: 修不动时次数被整轮上限卡住');
    process.env.CFCOACH_SAMPLE_FIX_MAX = '2';
    const aCap = mkAgent(() => SOL_WRONG);
    const rCap = await runFix(aCap, 'sample-fix-cap');
    const kCap = (rCap.trajectory || []).map((t) => t.kind);
    const fails = kCap.filter((k) => k === 'sol-sample-fix-fail').length;
    ok('样例修复上限：修不动的次数刚好是上限 2 次（不是无上限重试）', fails === 2,
      { fails, kinds: kCap.filter((k) => /sol-sample-fix/.test(k)) });
    ok('样例修复上限：额度用尽时明确记一条"不再重试"，并如实降级（不声称已验证）',
      (kCap.indexOf('sol-sample-fix-exhausted') >= 0 || kCap.indexOf('sol-sample-fix-cap') >= 0)
      && (!rCap.verification || rCap.verification.status !== 'ok'),
      { kinds: kCap.filter((k) => /sol-sample-fix/.test(k)), v: rCap.verification && rCap.verification.status });
    delete process.env.CFCOACH_SAMPLE_FIX_MAX;

    /* 2026-10-10：同一句"拒绝这一版，但**不要停手**"也要管住**题解在对拍里运行失败**那个站点
       （`lib/harness.js` 的"修题解（题解运行失败）"）。取证：10-07 那批 12–13 格终局原因
       "题解的一次重写没有通过官方样例（WA）→ 已拒绝这次重写并停止"里，属于这个站点的格子
       只花了 1–2 次调用就停（预算档允许 50–130 次）。

       夹具设计（要确定性，不能是概率性 flaky）：
         · 第一版题解**过官方样例**（样例是 t=2 组），但在随机数据上**必崩** —— 生成器固定只
           产出 t=1 组，于是"崩"是确定的；
         · 第二次重写（=被样例闸拦下的那一版）故意写成错解 → 必须被拒绝（纪律：不许拿没过
           官方样例的题解继续跑）；
         · 第三次才对。
       期望：终局原因不再是"已拒绝这次重写并停止"，链条继续修完并给出"已验证"；题解调用数
       从旧行为的 2 变成 3（可审计地证明"多给了一次机会"）。 */
    console.log('parallel: 题解在对拍里运行失败 → 重写被样例拒绝后仍然继续修（不停手）');
    {
      const SOL_CRASH = [
        'import sys, heapq',
        'd = sys.stdin.read().split()',
        'p = 0; t = int(d[p]); p += 1; out = []',
        'if t == 1:',
        '    raise SystemExit(3)',      // 生成器固定 t=1 → 对拍必崩；官方样例 t=2 → 样例必过
        'for _ in range(t):',
        '    n = int(d[p]); p += 1',
        '    h = []; s = 0',
        '    for _ in range(n):',
        '        x = int(d[p]); p += 1',
        '        if x > 0: heapq.heappush(h, -x)',
        '        elif h: s += -heapq.heappop(h)',
        '    out.append(str(s))',
        'print("\\n".join(out))'
      ].join('\n');
      const aRun = mkAgent((n) => (n === 1 ? SOL_CRASH : (n === 2 ? SOL_WRONG : SOL)));
      const rRun = await runFix(aRun, 'sol-runerror-sample-reject');
      const kRun = (rRun.trajectory || []).map((t) => t.kind);
      const vRun = rRun.verification || {};
      ok('运行失败站点：重写版没过官方样例 → 照样拒绝这一版（纪律不变，记住 sol-rewrite-sample-fail）',
        kRun.indexOf('sol-rewrite-sample-fail') >= 0, { kinds: kRun.filter((k) => /rewrite|sample/.test(k)) });
      ok('运行失败站点：拒绝之后**没有停手**（终局原因里不再有"已拒绝这次重写并停止"）',
        !/已拒绝这次重写并停止/.test(String(vRun.reason || '')),
        { reason: String(vRun.reason || '').slice(0, 200), kinds: kRun.filter((k) => /rewrite|sample/.test(k)) });
      ok('运行失败站点：真的多修了一轮（题解调用 2 → 3）并最终给出"已验证"',
        aRun.solCalls() === 3 && vRun.status === 'ok' && vRun.claimVerified === true,
        { solCalls: aRun.solCalls(), status: vRun.status, claim: vRun.claimVerified, reason: String(vRun.reason || '').slice(0, 160) });
    }
  }

  /* ========== 语言闸（批次③）：算法对、语言慢 → 只换语言、不改算法。
     2026-10-10 用户口径之后这条路径**默认关闭**（交付的语言必须就是被要求的那门），
     所以这里显式 CFCOACH_LANG_SWITCH=1 把它当 A/B 旋钮验证，并关掉同语言优化以免两条路径互相干扰。 ========== */
  {
    console.log('parallel: 语言闸（显式打开 A/B 开关）—— Python 在最大规模档太慢 → 换成 C++（只换语言）');
    const envSaved = {
      gate: process.env.CFCOACH_PERF_GATE,
      factor: process.env.CFCOACH_PERF_GATE_FACTOR,
      maxn: process.env.CFCOACH_PERF_GATE_MAXN,
      sw: process.env.CFCOACH_LANG_SWITCH,
      repair: process.env.CFCOACH_PERF_REPAIR
    };
    process.env.CFCOACH_PERF_GATE = '1';
    process.env.CFCOACH_PERF_GATE_FACTOR = '1';
    process.env.CFCOACH_PERF_GATE_MAXN = '6';
    process.env.CFCOACH_LANG_SWITCH = '1';    // 默认关 ⇒ 要显式打开
    process.env.CFCOACH_PERF_REPAIR = '0';    // 隔离：这个块只验证"换语言"那条 A/B 路径

    // 生成器：永远出 n=m 的数据（这样"最大规模档"一定落在 n=6 上，慢不慢可复现）
    const GEN_FULL = [
      'import random, sys',
      'm = int(sys.argv[1]) if len(sys.argv) > 1 else 6',
      'print(1)',
      'print(m)',
      'print(*[random.randint(0, 6) for _ in range(m)])'
    ].join('\n');
    // 正确但**故意慢**的 Python 版：n>=6 时先睡 0.8s（模拟"算法对、语言慢"）
    const SOL_SLOW = SOL.replace('d = sys.stdin.read().split()',
      'import time\nd = sys.stdin.read().split()\nif int(d[1]) >= 6: time.sleep(0.8)');
    const SOL_CPP = [
      '#include <bits/stdc++.h>',
      'using namespace std;',
      'int main() {',
      '  int t; if (!(cin >> t)) return 0;',
      '  while (t--) {',
      '    int n; cin >> n;',
      '    priority_queue<int> pq; long long s = 0;',
      '    for (int i = 0; i < n; i++) { int x; cin >> x; if (x > 0) pq.push(x); else if (!pq.empty()) { s += pq.top(); pq.pop(); } }',
      '    cout << s << "\\n";',
      '  }',
      '  return 0;',
      '}'
    ].join('\n');
    // 换语言后**没过官方样例**的 C++ 版（用来验证"不成立就回退"）
    const SOL_CPP_BAD = [
      '#include <bits/stdc++.h>',
      'int main() { printf("0\\n"); return 0; }'
    ].join('\n');
    const EXPLAINER_ANY = '## 题面拆解\nx\n## 关键观察\nx\n## 为什么\nx\n## 手算演示\n拿 n=2 举例\n'
      + '<viz-steps title="t"><viz-step title="第 1 步">a</viz-step></viz-steps>\n'
      + '## 算法\nx\n## 复杂度分析\n$O(n\\log n)$\n'
      + '<viz-formula title="复杂度" fx="$T(n)=O(n\\log n)$" legend="n" why="堆"/>\n'
      + '## 代码\n```cpp\n' + SOL_CPP + '\n```\n## 讲解\nx\n## 易错点\nx\n'
      + '<viz-callout type="danger" title="易错">x</viz-callout>\n## 验证\n官方样例通过。';
    // 换语言那一步的 system 提示里语言是 C++23，用它把"再解一次"与"只换语言"区分开
    const mkLangAgent = (cppCode) => async (opts) => {
      const sys = String(opts.system || '');
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      if (sys.indexOf('【讲解 Agent】') >= 0) { await delay(10); return EXPLAINER_ANY; }
      if (sys.indexOf('【题解 Agent】') >= 0) {
        await delay(10);
        if (sys.indexOf('C++23') >= 0) return '```cpp\n' + cppCode + '\n```';
        return '```python\n' + SOL_SLOW + '\n```';
      }
      if (sys.indexOf('【暴力 Agent】') >= 0) { await delay(10); return '```python\n' + BRUTE + '\n```'; }
      if (sys.indexOf('【数据生成 Agent】') >= 0) { await delay(10); return '```python\n' + GEN_FULL + '\n```'; }
      return '{}';
    };
    const runLang = (agent, key) => harness.runPipeline({
      conv: { id: key, title: '语言闸测试' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: key, timeLimitMs: 200,
      callAgent: agent, tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });

    const rSw = await runLang(mkLangAgent(SOL_CPP), 'lang-switch-ok');
    const kSw = (rSw.trajectory || []).map((t) => t.kind);
    ok('语言闸：Python 版被判太慢（真有 perf-gate-slow 的前一步：lang-switch-ok + perf-gate-pass）',
      kSw.indexOf('lang-switch-ok') >= 0 && kSw.indexOf('perf-gate-pass') >= 0 && kSw.indexOf('perf-gate-slow') < 0,
      (rSw.trajectory || []).slice(-8));
    ok('语言闸：交付的是换语言后的 C++（solLang=cpp，代码里含 #include）',
      rSw.solLang === 'cpp' && /#include/.test(String(rSw.solCode || '')),
      { solLang: rSw.solLang, head: String(rSw.solCode || '').slice(0, 40) });
    ok('语言闸：换语言后重新对拍通过 → 仍然算"完整验证"（claimVerified=true，不是降级交付）',
      !!(rSw.verification && rSw.verification.status === 'ok' && rSw.verification.claimVerified === true),
      rSw.verification && { status: rSw.verification.status, claim: rSw.verification.claimVerified, scope: rSw.verification.scopeNote });
    ok('语言闸：性能闸记下了"换过语言"（perfGate.lang=cpp + switchedFrom.lang=python）',
      !!(rSw.verification && rSw.verification.perfGate && rSw.verification.perfGate.ok === true
        && rSw.verification.perfGate.lang === 'cpp'
        && rSw.verification.perfGate.switchedFrom && rSw.verification.perfGate.switchedFrom.lang === 'python'),
      rSw.verification && rSw.verification.perfGate);
    ok('语言闸：工作区里只剩 sol.cpp（过期的 sol.py 必须删掉，否则上层按语言读会读到旧版）',
      !!workspace.readFile('lang-switch-ok', 'sol.cpp')
      && workspace.readFile('lang-switch-ok', 'sol.py') == null
      && workspace.readSolFile('lang-switch-ok', 'python').lang === 'cpp',
      { cpp: !!workspace.readFile('lang-switch-ok', 'sol.cpp'), py: !!workspace.readFile('lang-switch-ok', 'sol.py') });

    console.log('parallel: 语言闸 —— 换语言后没过官方样例 → 原样回退，照样不声称已验证');
    const rBad = await runLang(mkLangAgent(SOL_CPP_BAD), 'lang-switch-bad');
    const kBad = (rBad.trajectory || []).map((t) => t.kind);
    ok('语言闸回退：记了 lang-switch-reject + perf-gate-slow，没有 lang-switch-ok',
      kBad.indexOf('lang-switch-reject') >= 0 && kBad.indexOf('perf-gate-slow') >= 0 && kBad.indexOf('lang-switch-ok') < 0,
      kBad.filter((k) => /lang-switch|perf-gate/.test(k)));
    ok('语言闸回退：交付的还是原来的 Python 版（solLang=python，代码没变）',
      rBad.solLang === 'python' && /heapq/.test(String(rBad.solCode || '')),
      { solLang: rBad.solLang, head: String(rBad.solCode || '').slice(0, 40) });
    ok('语言闸回退：结论仍是"不许声称已验证"（claimVerified=false + 性能闸 ok=false）',
      !!(rBad.verification && rBad.verification.claimVerified === false
        && rBad.verification.perfGate && rBad.verification.perfGate.ok === false),
      rBad.verification && { claim: rBad.verification.claimVerified, gate: rBad.verification.perfGate });
    ok('语言闸回退：工作区里只有 sol.py（被拒的 C++ 版不许留在工作区）',
      !!workspace.readFile('lang-switch-bad', 'sol.py') && workspace.readFile('lang-switch-bad', 'sol.cpp') == null,
      { py: !!workspace.readFile('lang-switch-bad', 'sol.py'), cpp: !!workspace.readFile('lang-switch-bad', 'sol.cpp') });

    console.log('parallel: 语言闸 —— 开关关掉（默认状态）时一个字都不换');
    process.env.CFCOACH_LANG_SWITCH = '0';
    const rOff = await runLang(mkLangAgent(SOL_CPP), 'lang-switch-off');
    const kOff = (rOff.trajectory || []).map((t) => t.kind);
    ok('语言闸开关：默认关（CFCOACH_LANG_SWITCH=0）→ 完全不换语言（没有 lang-switch-* 轨迹）',
      kOff.filter((k) => /lang-switch/.test(k)).length === 0 && rOff.solLang === 'python'
      && kOff.indexOf('perf-gate-slow') >= 0,
      kOff.filter((k) => /lang-switch|perf-gate/.test(k)));

    if (envSaved.gate === undefined) delete process.env.CFCOACH_PERF_GATE; else process.env.CFCOACH_PERF_GATE = envSaved.gate;
    if (envSaved.factor === undefined) delete process.env.CFCOACH_PERF_GATE_FACTOR; else process.env.CFCOACH_PERF_GATE_FACTOR = envSaved.factor;
    if (envSaved.maxn === undefined) delete process.env.CFCOACH_PERF_GATE_MAXN; else process.env.CFCOACH_PERF_GATE_MAXN = envSaved.maxn;
    if (envSaved.sw === undefined) delete process.env.CFCOACH_LANG_SWITCH; else process.env.CFCOACH_LANG_SWITCH = envSaved.sw;
    if (envSaved.repair === undefined) delete process.env.CFCOACH_PERF_REPAIR; else process.env.CFCOACH_PERF_REPAIR = envSaved.repair;
  }

  /* ========== 同语言性能优化（2026-10-10 用户口径）：太慢就在**同一门语言**里修快 ========== */
  {
    console.log('parallel: 同语言优化 —— Python 在最大规模档太慢 → 还是 Python，只把算法/常数改快');
    const envSaved2 = {
      gate: process.env.CFCOACH_PERF_GATE,
      factor: process.env.CFCOACH_PERF_GATE_FACTOR,
      maxn: process.env.CFCOACH_PERF_GATE_MAXN,
      sw: process.env.CFCOACH_LANG_SWITCH,
      repair: process.env.CFCOACH_PERF_REPAIR
    };
    process.env.CFCOACH_PERF_GATE = '1';
    process.env.CFCOACH_PERF_GATE_FACTOR = '1';
    process.env.CFCOACH_PERF_GATE_MAXN = '6';
    delete process.env.CFCOACH_LANG_SWITCH;    // 默认 = 关：不许换语言
    delete process.env.CFCOACH_PERF_REPAIR;    // 默认 = 开

    const GEN_FULL2 = [
      'import random, sys',
      'm = int(sys.argv[1]) if len(sys.argv) > 1 else 6',
      'print(1)',
      'print(m)',
      'print(*[random.randint(0, 6) for _ in range(m)])'
    ].join('\n');
    // 正确但**故意慢**的 Python 版（与语言闸夹具同一手法：n>=6 时睡 0.8s）
    const SOL_SLOW2 = SOL.replace('d = sys.stdin.read().split()',
      'import time\nd = sys.stdin.read().split()\nif int(d[1]) >= 6: time.sleep(0.8)');
    // "优化"了但**还是一样慢**的版本（文本不同 ⇒ 不会被"逐字相同"那条守卫挡掉，必须靠重新计时识破）
    const SOL_SLOW_ALT = SOL.replace('d = sys.stdin.read().split()',
      'import time\nd = sys.stdin.read().split()\nif int(d[1]) >= 6:\n    time.sleep(0.8)  # 优化了个寂寞');
    // 快但**答案是错的**版本（用来验证"速度不能靠牺牲正确性换"）
    const SOL_WRONG_FAST = [
      'import sys',
      'd = sys.stdin.buffer.read().split()',
      't = int(d[0])',
      'out = []',
      'for _ in range(t):',
      '    n = int(d[1])',
      '    out.append(str(n))',
      "sys.stdout.write('\\n'.join(out) + '\\n')"
    ].join('\n');
    const mkExplainer2 = (code) => '## 题面拆解\nx\n## 关键观察\nx\n## 为什么\nx\n## 手算演示\n拿 n=2 举例\n'
      + '<viz-steps title="t"><viz-step title="第 1 步">a</viz-step></viz-steps>\n'
      + '## 算法\nx\n## 复杂度分析\n$O(n\\log n)$\n'
      + '<viz-formula title="复杂度" fx="$T(n)=O(n\\log n)$" legend="n" why="堆"/>\n'
      + '## 代码\n```python\n' + code + '\n```\n## 讲解\nx\n## 易错点\nx\n'
      + '<viz-callout type="danger" title="易错">x</viz-callout>\n## 验证\n官方样例通过。';
    /**
     * 假 agent：**题解角色**要分两类提问 —— 第一次是"解题"，之后那次是"把这份代码改快"。
     * 判据用 user 提示词里的"改快"（perfRepairUser 的抬头），system 两边都是【题解 Agent】。
     */
    const mkRepairAgent = (repairCode, onPrompt) => {
      let repairCalls = 0;
      let solCalls = 0;
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const f = async (opts) => {
        const sys = String(opts.system || '');
        const usr = String(opts.user || '');
        if (sys.indexOf('【讲解 Agent】') >= 0) { await delay(10); return mkExplainer2(repairCode); }
        if (sys.indexOf('【题解 Agent】') >= 0) {
          if (usr.indexOf('改快') >= 0) {
            repairCalls++;
            if (onPrompt) onPrompt(usr);
            await delay(10);
            return '```python\n' + repairCode + '\n```';
          }
          solCalls++;
          await delay(10);
          return '```python\n' + SOL_SLOW2 + '\n```';
        }
        if (sys.indexOf('【暴力 Agent】') >= 0) { await delay(10); return '```python\n' + BRUTE + '\n```'; }
        if (sys.indexOf('【数据生成 Agent】') >= 0) { await delay(10); return '```python\n' + GEN_FULL2 + '\n```'; }
        return '{}';
      };
      f.repairCalls = () => repairCalls;
      f.solCalls = () => solCalls;
      return f;
    };
    const runRepair = (agent, key) => harness.runPipeline({
      conv: { id: key, title: '同语言优化测试' },
      lang: 'python', intent: 'full', statement: STATEMENT,
      samples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
      workspace, wsKey: key, timeLimitMs: 200,
      callAgent: agent, tiers: [4, 6], perTier: 2, bruteTimeoutMs: 5000,
      emit: () => {}, log: () => {}
    });

    console.log('parallel: 同语言优化 —— 优化成功：同一门语言里改快 + 重新对拍 + 重新计时');
    const seenPrompt = [];
    const aOk = mkRepairAgent(SOL, (p) => seenPrompt.push(p));
    const rOk = await runRepair(aOk, 'perf-repair-ok');
    const kOk = (rOk.trajectory || []).map((t) => t.kind);
    ok('同语言优化：触发 perf-repair-ok + perf-gate-pass（没有 perf-gate-slow）',
      kOk.indexOf('perf-repair-ok') >= 0 && kOk.indexOf('perf-gate-pass') >= 0 && kOk.indexOf('perf-gate-slow') < 0,
      kOk.filter((k) => /perf|lang/.test(k)));
    ok('同语言优化：交付的仍然是 Python（solLang=python、代码里没有 #include）',
      rOk.solLang === 'python' && !/#include/.test(String(rOk.solCode || '')) && /heapq/.test(String(rOk.solCode || '')),
      { solLang: rOk.solLang, head: String(rOk.solCode || '').slice(0, 60) });
    ok('同语言优化：优化提问明令"语言不许换"，且题解 Agent 只被问了"解题 1 次 + 优化 1 次"',
      seenPrompt.length === 1 && seenPrompt[0].indexOf('语言不许换') >= 0
      && aOk.repairCalls() === 1 && aOk.solCalls() === 1,
      { prompts: seenPrompt.length, repair: aOk.repairCalls(), sol: aOk.solCalls(),
        head: String(seenPrompt[0] || '').slice(0, 100) });
    ok('同语言优化：优化版重新对拍 + 重新计时都过 → 仍算"完整验证"（claimVerified=true）',
      !!(rOk.verification && rOk.verification.status === 'ok' && rOk.verification.claimVerified === true
        && rOk.verification.perfGate && rOk.verification.perfGate.ok === true
        && rOk.verification.perfGate.lang === 'python'
        && rOk.verification.perfGate.repairedFrom && rOk.verification.perfGate.repairedFrom.ms > 0),
      rOk.verification && { status: rOk.verification.status, claim: rOk.verification.claimVerified, gate: rOk.verification.perfGate });
    ok('同语言优化：工作区里只有 sol.py（全程没换语言 ⇒ 不该出现 sol.cpp）',
      !!workspace.readFile('perf-repair-ok', 'sol.py') && workspace.readFile('perf-repair-ok', 'sol.cpp') == null,
      { py: !!workspace.readFile('perf-repair-ok', 'sol.py'), cpp: !!workspace.readFile('perf-repair-ok', 'sol.cpp') });

    console.log('parallel: 同语言优化 —— 优化了个寂寞（还是一样慢）→ 原样回退，照样不声称已验证');
    const aSlow = mkRepairAgent(SOL_SLOW_ALT);
    const rSlow = await runRepair(aSlow, 'perf-repair-slow');
    const kSlow = (rSlow.trajectory || []).map((t) => t.kind);
    ok('同语言优化回退：记了 perf-repair-reject + perf-gate-slow，没有 perf-gate-pass',
      kSlow.indexOf('perf-repair-reject') >= 0 && kSlow.indexOf('perf-gate-slow') >= 0
      && kSlow.indexOf('perf-repair-ok') < 0 && kSlow.indexOf('perf-gate-pass') < 0,
      kSlow.filter((k) => /perf|lang/.test(k)));
    ok('同语言优化回退：拒绝理由是"重新计时仍然超时"（不是逐字相同那条轻量守卫）',
      (rSlow.trajectory || []).some((t) => t.kind === 'perf-repair-reject' && /仍然超时/.test(String(t.note || ''))),
      (rSlow.trajectory || []).filter((t) => t.kind === 'perf-repair-reject').map((t) => t.note));
    ok('同语言优化回退：交付的还是原版 Python（被拒的"优化版"不许进交付物）',
      rSlow.solLang === 'python' && /time\.sleep\(0\.8\)/.test(String(rSlow.solCode || ''))
      && String(rSlow.solCode || '').indexOf('优化了个寂寞') < 0,
      { solLang: rSlow.solLang, head: String(rSlow.solCode || '').slice(0, 80) });
    ok('同语言优化回退：结论仍是"不许声称已验证"（claimVerified=false + 性能闸 ok=false）',
      !!(rSlow.verification && rSlow.verification.claimVerified === false
        && rSlow.verification.perfGate && rSlow.verification.perfGate.ok === false),
      rSlow.verification && { claim: rSlow.verification.claimVerified, gate: rSlow.verification.perfGate });
    ok('同语言优化回退：**不会退化成偷偷换语言**（默认没有 lang-switch-* 轨迹）',
      kSlow.filter((k) => /lang-switch/.test(k)).length === 0,
      kSlow.filter((k) => /lang-switch/.test(k)));

    console.log('parallel: 同语言优化 —— 快了但答案错了 → 用官方样例打回');
    const aWrong = mkRepairAgent(SOL_WRONG_FAST);
    const rWrong = await runRepair(aWrong, 'perf-repair-wrong');
    const kWrong = (rWrong.trajectory || []).map((t) => t.kind);
    ok('同语言优化：快而错不算优化（perf-repair-reject 的理由是"没通过官方样例"）',
      (rWrong.trajectory || []).some((t) => t.kind === 'perf-repair-reject' && /官方样例/.test(String(t.note || ''))),
      (rWrong.trajectory || []).filter((t) => t.kind === 'perf-repair-reject').map((t) => t.note));
    ok('同语言优化：交付物没被那次"快而错"污染（还是原版 + 仍然 perf-gate-slow + 不许声称已验证）',
      rWrong.solLang === 'python' && /time\.sleep\(0\.8\)/.test(String(rWrong.solCode || ''))
      && kWrong.indexOf('perf-gate-slow') >= 0 && kWrong.indexOf('perf-gate-pass') < 0
      && !!(rWrong.verification && rWrong.verification.claimVerified === false),
      { solLang: rWrong.solLang, kinds: kWrong.filter((k) => /perf|lang/.test(k)),
        claim: rWrong.verification && rWrong.verification.claimVerified });

    console.log('parallel: 同语言优化 —— 关掉开关（CFCOACH_PERF_REPAIR=0）时连试都不试');
    process.env.CFCOACH_PERF_REPAIR = '0';
    const aOff = mkRepairAgent(SOL);
    const rOff2 = await runRepair(aOff, 'perf-repair-off');
    const kOff2 = (rOff2.trajectory || []).map((t) => t.kind);
    ok('同语言优化开关：CFCOACH_PERF_REPAIR=0 → 一次优化提问都不发，直接就是 perf-gate-slow',
      aOff.repairCalls() === 0 && kOff2.indexOf('perf-gate-slow') >= 0
      && kOff2.filter((k) => /perf-repair/.test(k)).length === 0,
      { repair: aOff.repairCalls(), kinds: kOff2.filter((k) => /perf|lang/.test(k)) });

    if (envSaved2.gate === undefined) delete process.env.CFCOACH_PERF_GATE; else process.env.CFCOACH_PERF_GATE = envSaved2.gate;
    if (envSaved2.factor === undefined) delete process.env.CFCOACH_PERF_GATE_FACTOR; else process.env.CFCOACH_PERF_GATE_FACTOR = envSaved2.factor;
    if (envSaved2.maxn === undefined) delete process.env.CFCOACH_PERF_GATE_MAXN; else process.env.CFCOACH_PERF_GATE_MAXN = envSaved2.maxn;
    if (envSaved2.sw === undefined) delete process.env.CFCOACH_LANG_SWITCH; else process.env.CFCOACH_LANG_SWITCH = envSaved2.sw;
    if (envSaved2.repair === undefined) delete process.env.CFCOACH_PERF_REPAIR; else process.env.CFCOACH_PERF_REPAIR = envSaved2.repair;
  }

  console.log('\nparallel: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
})().catch((e) => { console.error('并行测试异常: ' + (e && e.stack || e)); process.exit(1); });
