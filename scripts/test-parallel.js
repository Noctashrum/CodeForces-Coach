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
   *   ② 修正轮数：原来 8–16 轮 → 现在硬顶 3 轮
   *   ③ 题解过了官方样例、标尺却没校准/大数值跑不动时，仲裁说"题解错"也不改题解（止损） */
  console.log('parallel: 成本止血（重试额度 / 轮数上限 / 证据不足不改题解）');
  ok('轮数上限：任何难度都不超过 3 轮（原来 8–16 轮 × 每次数分钟）',
    harness.solFixBudget(1200) <= 3 && harness.solFixBudget(2000) <= 3
    && harness.solFixBudget(2600) <= 3 && harness.solFixBudget(3400) <= 3,
    [harness.solFixBudget(1200), harness.solFixBudget(2000), harness.solFixBudget(2600), harness.solFixBudget(3400)]);
  const bud = harness.makeBudget(2400);
  ok('预算：调用上限 40 次 / 时长 20 分钟（推理型模型单次 3–5 分钟，45 分钟等于没上限）',
    bud.maxAgentCalls === 40 && bud.maxWallMs === 20 * 60 * 1000, { calls: bud.maxAgentCalls, wall: bud.maxWallMs });

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


  console.log('\nparallel: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
})().catch((e) => { console.error('并行测试异常: ' + (e && e.stack || e)); process.exit(1); });
