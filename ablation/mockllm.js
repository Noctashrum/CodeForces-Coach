/**
 * 消融实验用的本地假模型（零 token 把整条链路跑通：L0 / L1 / 判分）。
 *
 * 它不是"评分用的模型"，只是**管线自测桩**：按脚本吐 tool_calls 与正文，
 * 用来证明 L0/L1/判分脚本本身是对的（题面进去了、工具真的被调用、代码真的落盘、
 * 判分真的能判对也能判错）。
 *
 * 单独启动：
 *   node ablation/mockllm.js --port 3999
 *   node ablation/run.js --base-url http://127.0.0.1:3999/v1 --api-key mock --model mock-gpt-4 --problems example-ab
 *
 * 脚本行为：
 *   · 请求里没有 tools（= L0）→ 直接给一段"正解 + 讲解"
 *   · 请求里有 tools（= L1）→ 按工具调用次数依次：写暴力解 → 写生成器 → 写正解 → 对拍 → 给最终回答
 *   · 题面里出现「错解」两个字 → 故意给一个错代码（用来验证判分**能判错**，不会一片绿）
 */
'use strict';

const http = require('http');

const SOLUTION = [
  'import sys',
  '',
  'def main():',
  '    data = sys.stdin.read().split()',
  '    a, b = int(data[0]), int(data[1])',
  '    print(a + b)',
  '',
  'main()'
].join('\n');

const WRONG = [
  'import sys',
  '',
  'def main():',
  '    data = sys.stdin.read().split()',
  '    a, b = int(data[0]), int(data[1])',
  '    print(a - b)',   // 故意错：判分必须抓到它
  '',
  'main()'
].join('\n');

const BRUTE = [
  'import sys',
  '',
  'data = sys.stdin.read().split()',
  'total = 0',
  'for x in data:',
  '    total += int(x)',
  'print(total)'
].join('\n');

const GEN = [
  'import random, sys',
  '# 对拍编排器会传 argv[1]=规模 N、argv[2]=数值上限（没传就用默认值）',
  'n = int(sys.argv[1]) if len(sys.argv) > 1 else 10',
  'cap = int(sys.argv[2]) if len(sys.argv) > 2 else 10',
  'cap = max(1, min(cap, 10 ** 9))',
  'print(random.randint(1, cap), random.randint(1, cap))'
].join('\n');

/* ---------- 讲解桩：必须**过校验器** ----------
 * 教训（探针实测）：桩给的讲解太简陋时，链路会在 explaindoc/richdoc 校验处失败，
 * 于是探针报的"失败"其实是"桩写坏了"，而不是链路有问题 —— 自测桩必须产出合规产物：
 *   · Markdown 版要满足 lib/explaindoc.js 的骨架（章节 + ≥3 个 viz 组件 + 手算演示 + 代码逐行保真）；
 *   · 图文版要满足 lib/richdoc.js（div.wrap + 标签闭合 + 至少 1 张有连线与标注的真 SVG）。
 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 图文模式（richGuide 要求：1–2 句引子 + 恰好一个 ```html 块，块内是正文片段） */
function richExplain(code) {
  const body = [
    '<div class="wrap">',
    '<header class="hero"><div class="kicker">A + B</div><h1>读入两个整数，输出它们的和</h1>',
    '<p class="oneliner">一行输入、一行输出：把 a 与 b 相加即可。</p></header>',
    '<section class="chapter"><h2><span class="num">1</span>题意拆解</h2>',
    '<p>输入一行两个整数 a、b，输出它们的和。没有多组询问，也没有取模。</p></section>',
    '<section class="chapter"><h2><span class="num">2</span>思路与手算</h2>',
    '<p>读入两个数，相加后输出。拿 a = 2、b = 3 走一遍：先读入，再相加得 5，最后输出 5。</p>',
    '<figure class="diagram"><svg viewBox="0 0 320 80" width="320" height="80">',
    '<line x1="12" y1="52" x2="86" y2="52" stroke="#8b5cf6" stroke-width="2">',
    '<line x1="112" y1="52" x2="186" y2="52" stroke="#8b5cf6" stroke-width="2">',
    '<line x1="212" y1="52" x2="286" y2="52" stroke="#22c55e" stroke-width="2">',
    '<text x="12" y="36">a = 2</text><text x="112" y="36">b = 3</text>',
    '<text x="212" y="36">a + b</text><text x="266" y="72">5</text>',
    '</svg><figcaption>数据流：读入 a、b → 相加 → 输出</figcaption></figure></section>',
    '<section class="chapter"><h2><span class="num">3</span>复杂度</h2>',
    '<div class="formula"><div class="fx">O(1)</div><div class="var">时间与空间都是常数</div></div></section>',
    '<section class="chapter"><h2><span class="num">4</span>代码</h2><pre><code>' + esc(code) + '</code></pre></section>',
    '<section class="chapter"><h2><span class="num">5</span>易错点</h2>',
    '<div class="callout danger"><div class="ttl">别算成 a - b</div>',
    '<p>题目要的是和；另外输入可能跨行，别只读一行。</p></div></section>',
    '<footer class="footer">本题由消融测试台的假模型生成，仅用于验证管线。</footer>',
    '</div>'
  ].join('\n');
  return '这次用图文文档讲解（正文在下面的文档里）。\n\n```html\n' + body + '\n```';
}

/** 普通 Markdown 版：章节骨架 + 3 个以上组件 + 手算演示 + 与已验证代码逐行一致的代码块 */
function mdExplain(code) {
  return [
    '## 题面拆解', '输入一行两个整数 a、b，输出它们的和；没有多组询问，也没有取模。', '',
    '## 思路', '读入两个整数，相加后输出。题面要的输出就是 a + b，不需要别的处理。', '',
    '## 为什么这样是对的', '因为输出定义就是两个输入之和：加法不会改变数值本身，按题意直接计算即可得到正确答案。', '',
    '## 复杂度分析', '时间复杂度 O(1)，空间复杂度 O(1)：只做一次加法。', '',
    '## 手算演示', '拿 a = 2、b = 3 走一遍：第 1 步读入 2 和 3，第 2 步相加得 5，第 3 步输出 5。',
    '<viz-steps>', '<viz-step>读入 a=2、b=3</viz-step>', '<viz-step>相加：2 + 3 = 5</viz-step>',
    '<viz-step>输出 5</viz-step>', '</viz-steps>',
    '<viz-formula>O(1)</viz-formula>',
    '<viz-callout type="danger">不要把 a - b 当成答案；输入可能跨行，别只读一行。</viz-callout>', '',
    '## 代码', '```python', code, '```', '',
    '## 易错点', '- 读入顺序不能反；- 别用减法；- 输出不需要额外文字。'
  ].join('\n');
}

/* ---------- L2（cf-coach 本体：多 Agent 链）的桩 ---------- */

/**
 * L2 的每一次调用都是"某个角色的 Agent"，靠系统提示词区分。
 * 这里只覆盖 A+B 这类"求和即正解"的题（示例题 example-ab 就是它）；
 * 换别的题请用真模型跑 L2 —— 桩的用途只是**零成本验证管线接得对**。
 */
function l2ScriptFor(system, userText, opts) {
  const s = String(system || '');
  const wrong = /错解/.test(userText) || opts.wrong;
  const code = wrong ? WRONG : SOLUTION;
  if (/【题解 Agent】/.test(s)) return { text: '```python\n' + code + '\n```' };
  if (/【暴力 Agent】/.test(s)) return { text: '```python\n' + BRUTE + '\n```' };
  if (/【数据生成 Agent】/.test(s)) return { text: '随机生成两个整数。\n\n```python\n' + GEN + '\n```' };
  // 测试台自己的角色（ablation/lib/mkgen.js）：照题面 + oracle 写生成器 —— 与链里的数据生成 Agent 是同一件事
  if (/【数据生成器 Agent】/.test(s)) return { text: '随机生成两个整数。\n\n```python\n' + GEN + '\n```' };
  if (/【手算锚点 Agent】/.test(s)) return { text: JSON.stringify({ cases: [{ input: '2 3', output: '5' }] }) };
  if (/【讲解提纲 Agent】/.test(s)) {
    return { text: JSON.stringify({
      core: '读入两个整数，输出它们的和',
      algorithm: '读入两个整数，直接相加后输出 —— 没有多组询问、没有取模，加法即为题意。',
      complexity: '时间 O(1)、空间 O(1)：只做一次加法，任何数据范围都够用。',
      why: '直接相加即可', steps: ['读入', '相加', '输出'], hand: '2 3 → 5', pitfalls: []
    }) };
  }
  if (/【错因仲裁 Agent】/.test(s)) return { text: JSON.stringify({ wrong: 'sol', reason: 'mock：题解与暴力解不一致，且暴力解已通过样例校准' }) };
  if (/【讲解 Agent】/.test(s)) {
    // 图文模式靠系统提示词认（richGuide 里写了"```html 代码块"）；回落到 Markdown 时 harness 会重新调一次
    const rich = /富讲解模式|```html/.test(s);
    return { text: rich ? richExplain(code) : mdExplain(code) };
  }
  return { text: '（mock L2）\n\n```python\n' + code + '\n```' };
}

function scriptFor(body, opts) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const msgs = body.messages || [];
  const userText = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const wrong = /错解/.test(userText) || opts.wrong;
  // L2（cf-coach 的 runPipeline）先认出来：它的请求同样"没有工具"，只能靠系统提示词里的角色标记区分
  const sysText = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (/【[^】]*Agent】|【路由判断器】/.test(sysText)) return l2ScriptFor(sysText, userText, opts);
  const code = wrong ? WRONG : SOLUTION;
  const steps = (body.messages || []).filter((m) => m.role === 'tool').length;
  const names = tools.map((t) => t.function && t.function.name).filter(Boolean);
  if (!names.length) {
    return { text: mdExplain(code) };
  }
  const has = (n) => names.indexOf(n) >= 0;
  if (opts.l1NoCode) {
    // 模拟 2268A 那次**真实**失败：模型一直写辅助脚本，正解从未落盘，正文也没给代码块。
    // 用途：验证 runL1 的收尾兜底（追问一次"只要最终代码"）真的能把交付物救回来。
    if (steps === 0 && has('write_file')) return { call: { name: 'write_file', args: { path: 'brute.py', content: BRUTE } } };
    return { text: '我先把枚举脚本和暴力解写好了，最终正解我还在整理，稍等一下。' };
  }
  if (steps === 0 && has('write_file')) return { call: { name: 'write_file', args: { path: 'brute.py', content: BRUTE } } };
  if (steps === 1 && has('write_file')) return { call: { name: 'write_file', args: { path: 'gen.py', content: GEN } } };
  if (steps === 2 && has('write_file')) return { call: { name: 'write_file', args: { path: 'solution.py', content: code } } };
  if (steps === 3 && has('stress_test')) {
    return { call: { name: 'stress_test', args: { solution: 'solution.py', brute: 'brute.py', gen: 'gen.py', iterations: 10 } } };
  }
  return { text: mdExplain(code) };
}

function sseHead(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
}

async function handle(req, res, opts) {
  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
  }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-gpt-4', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !/chat\/completions$/.test(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock(ablation): not found ' + url.pathname } }));
    return;
  }
  const plan = scriptFor(body, opts);
  // --delay MS：每次调用先睡一会儿。用来验证"并发跑题"是真并发（时间窗重叠），而不是日志看起来像。
  if (opts.delay > 0) await new Promise((r) => setTimeout(r, opts.delay));
  sseHead(res);
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const model = body.model || 'mock-gpt-4';
  const base = { id: 'mock-ablation', object: 'chat.completion.chunk', model };
  if (plan.call) {
    const id = 'call_' + Math.random().toString(36).slice(2, 8);
    send(Object.assign({}, base, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: plan.call.name, arguments: '' } }] }, finish_reason: null }] }));
    const argStr = JSON.stringify(plan.call.args);
    for (const piece of (argStr.match(/[\s\S]{1,40}/g) || [])) {
      send(Object.assign({}, base, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] }));
    }
    send(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 } }));
  } else {
    for (const piece of (plan.text.match(/[\s\S]{1,60}/g) || [])) {
      send(Object.assign({}, base, { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
    }
    send(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 220, total_tokens: 1420 } }));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 起一个假模型服务；返回 { url, port, close() } */
function startMockLlm(opt) {
  const opts = opt || {};
  const server = http.createServer((req, res) => { handle(req, res, opts).catch(() => { try { res.end(); } catch { /* ignore */ } }); });
  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: 'http://127.0.0.1:' + port + '/v1',
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

module.exports = { startMockLlm, SOLUTION, WRONG, BRUTE, GEN, scriptFor, l2ScriptFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  let port = 3999;
  const i = args.indexOf('--port');
  if (i >= 0) port = parseInt(args[i + 1], 10) || 3999;
  const wrong = args.indexOf('--wrong') >= 0;
  const l1NoCode = args.indexOf('--l1-nocode') >= 0;
  const di = args.indexOf('--delay');
  const delay = di >= 0 ? (parseInt(args[di + 1], 10) || 0) : 0;
  startMockLlm({ port, wrong, l1NoCode, delay }).then((s) => {
    console.log('[mock-ablation] listening on ' + s.url + (delay ? '（每次调用先睡 ' + delay + 'ms）' : ''));
    console.log('[mock-ablation] 用法示例：node ablation/run.js --base-url ' + s.url + ' --api-key mock --model mock-gpt-4 --level L0,L1 --problems example-ab');
  });
}
