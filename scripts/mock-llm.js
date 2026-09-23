/**
 * mock-llm.js — 本地模拟的 LLM 上游服务（用于离线开发/测试 ChatBox）
 * 同时模拟 OpenAI 兼容接口与 Anthropic 接口，含 SSE 流式输出。
 * 启动：node scripts/mock-llm.js   （默认端口 3999，可用 PORT 覆盖）
 */
'use strict';
const http = require('http');
const PORT = parseInt(process.env.PORT || '3999', 10);

// 客户端（被测服务端）在用户点「停止」时会**中途掐断连接**：这时候再往已断开的 socket
// 写 SSE 数据会抛 ECONNRESET / EPIPE / ERR_STREAM_WRITE_AFTER_END。
// mock 是测试夹具，绝不能因此整个崩掉——崩了后面所有用例会连环失败，看起来像被测代码的问题。
process.on('uncaughtException', (e) => {
  const code = String((e && e.code) || '');
  if (/ECONNRESET|EPIPE|ERR_STREAM|ERR_HTTP_HEADERS_SENT|ERR_SOCKET/.test(code)) {
    console.log('[mock-llm] 客户端中断连接（忽略）: ' + code);
    return;
  }
  console.error('[mock-llm] 未捕获异常: ' + ((e && e.stack) || e));
  process.exit(1);
});

const SAMPLE = [
  '你好！我是 **模拟助手**（Mock LLM），这是一条流式回复，用来验证 ChatBox 的完整链路。\n\n',
  '我支持这些格式：\n\n',
  '- Markdown **加粗**、*斜体*、`行内代码`\n',
  '- 数学公式：$E = mc^2$ 与块级公式\n\n',
  '$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n',
  '```python\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint(fib(10))  # 55\n```\n\n',
  '> 引用块测试。\n\n',
  '| 能力 | 状态 |\n| --- | --- |\n| 流式输出 | ✅ |\n| 代码高亮 | ✅ |\n| 公式渲染 | ✅ |\n\n',
  '结束。'
].join('');

const REASONING = [
  '用户提出了一个问题，我需要逐步分析。\n',
  '首先理解问题本身，然后组织一个结构化的回答，包含示例代码与公式。\n',
  '思考完成，开始输出正式回答。'
].join('');

function sse(res) {
  // 客户端中断 → 只吞掉 socket 错误，不要让 mock 进程挂掉
  try { res.on('error', () => {}); } catch (e) { /* ignore */ }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 收到的 chat 请求计数：e2e 用它验证"用户点停止后不再继续请求模型"（省 token 的关键）
let chatRequests = 0;
// "被输出上限截断且正文为空"的模拟次数（推理型模型把预算花在思考上的最坏情况）
let capEmptyServed = 0;

async function openaiChat(req, res, body) {
  const model = (body && body.model) || 'mock-gpt-4';
  const userText = extractUserText(body);
  const stream = !body || body.stream !== false;

  // mock-cap-empty：只要请求里带了 max_tokens，就**装作"预算被思考吃光"**——
  // finish_reason=length 且正文为空。用来验证服务端会自动"去掉上限重试一次"把正文救回来
  //（实测 deepseek-flash 带 max_tokens=16384 时就是这个表现：26058 token 的思考 + 0 字正文）。
  if (/mock-cap-empty/.test(model) && body && body.max_tokens) {
    capEmptyServed++;
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-cap', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: '（思考把预算用光了）' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: Number(body.max_tokens) }
      }));
      return;
    }
    sse(res);
    res.write('data: ' + JSON.stringify({ id: 'mock-cap', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { reasoning_content: '（思考把预算用光了）' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'mock-cap', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      usage: { prompt_tokens: 100, completion_tokens: Number(body.max_tokens) } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // ---- 学情分析师模拟（学员信息卡更新）：返回 JSON 卡片 ----
  const sysText = body && Array.isArray(body.messages)
    ? body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    : '';
  if (sysText.indexOf('学情分析师') >= 0) {
    const card = JSON.stringify({
      profileText: '整体位于 Expert 段位，贪心与构造题表现扎实，动态规划是当前主要短板。',
      strengths: ['贪心策略', '构造题', '代码实现'],
      weaknesses: ['动态规划', '状态定义'],
      focus: ['多解释状态定义与转移', '用图例说明贪心选择', '补充复杂度证明']
    });
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-prof', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: card }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 }
      }));
      return;
    }
    sse(res);
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    send({ id: 'mock-prof', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    const parts = card.match(/[\s\S]{1,24}/g) || [card];
    for (const p of parts) {
      await sleep(10);
      send({ id: 'mock-prof', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
    }
    send({ id: 'mock-prof', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // ---- 题目分类器模拟：返回 JSON 分类 ----
  if (sysText.indexOf('题目分类器') >= 0) {
    const cls = JSON.stringify({
      rating: 1500,
      knowledge: ['贪心', '数据结构'],
      summary: '贪心+堆维护可取最大值'
    });
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-cls', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: cls }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
      }));
      return;
    }
    sse(res);
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    send({ id: 'mock-cls', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: cls }, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (!stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-' + Date.now(), object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content: SAMPLE }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 120, total_tokens: 162 }
    }));
    return;
  }
  sse(res);
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  // ---- 多 Agent harness：按 system 提示词里的角色标记返回对应产物 ----
  const role = mockRole(sysText);
  if (role) {
    const text = mockAgentOutput(role, body, sysText);
    // mock-delay：按角色给固定延迟，用来**测量并发是否真的生效**
    // （题解 2.5s / 暴力 1.5s / 生成器 0.8s：真并发总时长≈2.6s，串行≈4.8s）
    if (/mock-delay/.test(model)) {
      const delays = { solution: 2500, brute: 1500, gen: 800, explainer: 100 };
      await sleep(delays[role] || 50);
    }
    // 先吐思考增量（真实推理模型就是这样：reasoning_content → 再正文），
    // 用来验证"思考过程实时可见"这条链路
    const think = ('先判断这是【' + role + '】角色。' + (role === 'brute' ? '注意：本次拿不到官方样例，只能按契约写。' : '')
      + '按要求组织输出：先结论，再依据，最后代码/结果。').match(/[\s\S]{1,20}/g) || [];
    for (const c of think) {
      await sleep(5);
      send({ id: 'mock-a', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta: { reasoning_content: c }, finish_reason: null }] });
    }
    const parts = text.match(/[\s\S]{1,64}/g) || [];
    for (const p of parts) {
      await sleep(6);
      send({ id: 'mock-a', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
    }
    send({ id: 'mock-a', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  send({ id: 'mock-' + Date.now(), object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  // 模拟思考过程
  const chunks = REASONING.match(/[\s\S]{1,12}/g) || [];
  for (const c of chunks) {
    await sleep(30);
    send({ id: 'mock-r', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { reasoning_content: c }, finish_reason: null }] });
  }
  const out = ('收到你的消息：' + JSON.stringify(userText) + '\n\n').slice(0, 120) + SAMPLE;
  const parts = out.match(/[\s\S]{1,16}/g) || [];
  for (const p of parts) {
    await sleep(25);
    send({ id: 'mock-' + Date.now(), object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
  }
  send({ id: 'mock-' + Date.now(), object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 120, total_tokens: 162 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function anthropicChat(req, res, body) {
  const model = (body && body.model) || 'mock-claude';
  const userText = extractUserText(body);
  const stream = !body || body.stream !== false;
  if (!stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: SAMPLE }], stop_reason: 'end_turn',
      usage: { input_tokens: 42, output_tokens: 120 }
    }));
    return;
  }
  sse(res);
  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  send('message_start', { type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 42 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  const th = REASONING.match(/[\s\S]{1,12}/g) || [];
  for (const c of th) { await sleep(30); send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: c } }); }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  const out = ('收到你的消息：' + JSON.stringify(userText) + '\n\n').slice(0, 120) + SAMPLE;
  const parts = out.match(/[\s\S]{1,16}/g) || [];
  for (const p of parts) { await sleep(25); send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } }); }
  send('content_block_stop', { type: 'content_block_stop', index: 1 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function extractUserText(body) {
  if (!body || !body.messages) return '';
  const last = body.messages[body.messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content.slice(0, 200);
  if (Array.isArray(last.content)) {
    return last.content.filter(p => p && p.type === 'text').map(p => p.text).join(' ').slice(0, 200);
  }
  return '';
}

/* ---------------- 教练模式工具调用模拟 ---------------- */

const MOCK_SOL_JS = `const fs = require('fs');
const input = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
let pos = 0, out = [];
const t = input[pos++];
for (let c = 0; c < t; c++) {
  const n = input[pos++];
  const avail = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const x = input[pos++];
    if (x > 0) { avail.push(x); avail.sort((a, b) => a - b); }
    else if (avail.length) total += avail.pop();
  }
  out.push(total);
}
console.log(out.join('\\n'));`;

const MOCK_BRUTE_JS = `const fs = require('fs');
const input = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
let pos = 0, out = [];
const t = input[pos++];
for (let c = 0; c < t; c++) {
  const n = input[pos++];
  const a = input.slice(pos, pos + n); pos += n;
  let best = 0;
  const used = new Array(n).fill(false);
  const rec = (i, total) => {
    if (i === n) { if (total > best) best = total; return; }
    if (a[i] > 0) { rec(i + 1, total); return; }
    for (let j = 0; j < i; j++) {
      if (a[j] > 0 && !used[j]) { used[j] = true; rec(i + 1, total + a[j]); used[j] = false; }
    }
    rec(i + 1, total);
  };
  rec(0, 0);
  out.push(best);
}
console.log(out.join('\\n'));`;

const MOCK_GEN_JS = `const n = 1 + Math.floor(Math.random() * 8);
const a = [];
for (let i = 0; i < n; i++) a.push(Math.floor(Math.random() * 6));
console.log('1\\n' + n + '\\n' + a.join(' '));`;

/* 按讲解语言准备的 Python 版本（教练会话默认 cpp/python，e2e 用 python） */

const MOCK_SOL_PY = `import sys, heapq

def main():
    data = sys.stdin.read().split()
    if not data:
        return
    p = 0
    t = int(data[p]); p += 1
    out = []
    for _ in range(t):
        n = int(data[p]); p += 1
        heap = []
        total = 0
        for _ in range(n):
            x = int(data[p]); p += 1
            if x > 0:
                heapq.heappush(heap, -x)
            elif heap:
                total += -heapq.heappop(heap)
        out.append(str(total))
    sys.stdout.write("\\n".join(out) + "\\n")

main()`;

const MOCK_BRUTE_PY = `import sys

def main():
    data = sys.stdin.read().split()
    if not data:
        return
    p = 0
    t = int(data[p]); p += 1
    out = []
    for _ in range(t):
        n = int(data[p]); p += 1
        a = [int(data[p + i]) for i in range(n)]; p += n
        best = 0
        used = [False] * n
        def rec(i, total):
            nonlocal best
            if i == n:
                if total > best:
                    best = total
                return
            if a[i] > 0:
                rec(i + 1, total)
                return
            for j in range(i):
                if a[j] > 0 and not used[j]:
                    used[j] = True
                    rec(i + 1, total + a[j])
                    used[j] = False
            rec(i + 1, total)
        rec(0, 0)
        out.append(str(best))
    sys.stdout.write("\\n".join(out) + "\\n")

main()`;

const MOCK_GEN_PY = `import random, sys
maxN = int(sys.argv[1]) if len(sys.argv) > 1 else 8
n = random.randint(1, max(1, min(maxN, 10)))   # 模拟：控制在暴力解跑得动的范围
print(1)
print(n)
print(*[random.randint(0, 6) for _ in range(n)])`;

/**
 * 打表产物（复刻 2264D 真实事故）：把小 n 的官方样例答案硬编码进代码 ——
 * 这是"能过样例但必然错"的典型，机械反作弊必须拦下它。
 */
const MOCK_CHEAT_SOL_PY = `# 小 n 直接输出样例答案，保证与官方样例完全一致
import sys

def main():
    data = sys.stdin.read().split()
    t = int(data[0])
    out = []
    for i in range(t):
        n = int(data[1 + i])
        if n == 1:
            out.append("1")
        elif n == 2:
            out.append("11")
        elif n == 3:
            out.append("101")
        elif n == 4:
            out.append("0101")
        elif n == 5:
            out.append("10101")
        elif n == 6:
            out.append("010100")
        else:
            out.append("0" * n)
    sys.stdout.write("\\n".join(out) + "\\n")

main()`;

const MOCK_CHEAT_BRUTE_PY = MOCK_CHEAT_SOL_PY;

/** 从 system 提示词判断这是哪个 agent 角色 */
function mockRole(sysText) {
  const s = String(sysText || '');
  if (s.indexOf('【题解 Agent】') >= 0) return 'solution';
  if (s.indexOf('【暴力 Agent】') >= 0) return 'brute';
  if (s.indexOf('【数据生成 Agent】') >= 0) return 'gen';
  if (s.indexOf('【讲解提纲 Agent】') >= 0) return 'plan';
  if (s.indexOf('【手算锚点 Agent】') >= 0) return 'witness';
  if (s.indexOf('【题面整理 Agent】') >= 0) return 'normalize';
  if (s.indexOf('【讲解 Agent】') >= 0) return 'explainer';
  if (s.indexOf('【路由判断器】') >= 0) return 'router';
  if (s.indexOf('【做法评估 Agent】') >= 0) return 'idea';
  return '';
}

/** 路由判断（模拟）：没听懂 / 解释型 / 针对具体代码或做法（→ 代码评估）/ 需要重跑 */
function mockRoute(userText) {
  const q = String(userText || '');
  if (/(没听懂|没懂|没理解|看不懂|不理解|太抽象|再基础|从零|换个说法|换种说法)/.test(q)) {
    return { mode: 'rethink', reason: '学员表示没听懂' };
  }
  if (/(能|可以|行不行|能不能).{0,12}(写|做|过|吗)|用.{0,10}(写|做).{0,6}(吗|行)/.test(q)) {
    return { mode: 'debug', reason: '针对具体做法提问' };
  }
  if (/(为什么|为何|怎么|如何|解释|讲讲|详细|why|how)/i.test(q)) {
    return { mode: 'explain', reason: '解释型追问' };
  }
  return { mode: 'explain', reason: '默认按解释处理' };
}

/** 各角色的模拟产物（题解/暴力/生成器用 Python，讲解返回结构化 Markdown） */
function mockAgentOutput(role, body, sysText) {
  const model = String((body && body.model) || '');
  const failMode = /mock-fail/.test(model);       // 模拟"题解反复错" → 触发熔断
  const noBruteMode = /mock-nobrute/.test(model); // 模拟"暴力解写不出" → 无标尺降级
  const cheatMode = /mock-cheat(?!-brute)/.test(model);   // 模拟"题解打表" → 反作弊必须拦下
  const cheatBruteMode = /mock-cheat-brute/.test(model); // 模拟"暴力解打表" → 拒绝当标尺
  const userText = extractUserText(body);

  if (role === 'router') return JSON.stringify(mockRoute(userText));
  // 手算锚点（无官方样例时）：给极端小样例 + 手算答案（1800C 的语义：遇到 0 取当前最大正数牌）
  if (role === 'witness') {
    return JSON.stringify({
      cases: [
        { why: '最小规模：只有一张 0，没有可取的牌', input: '1\n1\n0', answerSteps: ['读入 t=1', 'n=1，牌堆=[0]', '遇到 0 时堆为空 → 不取'], output: '0' },
        { why: '取一次：正数在前、0 在后', input: '1\n2\n5 0', answerSteps: ['读入 5 入堆', '遇到 0，弹出堆顶 5', '累加 5'], output: '5' },
        { why: '一张牌只能取一次（两个 0 只有一个能取到）', input: '1\n3\n7 0 0', answerSteps: ['7 入堆', '第一个 0 弹出 7，累加 7', '第二个 0 时堆空 → 不取'], output: '7' }
      ],
      uncertain: []
    });
  }
  if (role === 'normalize') {
    if (/mock-noanchor/.test(model)) return '整理失败了随便写点东西';   // 模拟整理 Agent 不可用 → 走手算锚点
    return JSON.stringify({
      title: 'Powering the Hero（整理版）',
      body: '牌堆里依次给出 n 张牌，每张牌的数值是非负整数。遇到数值为 0 的牌时，可以从此前出现过、'
        + '且尚未被取走的牌中取走一张，取走的牌面值计入总和。求能取得的最大总和。',
      inputFormat: '第一行一个整数 t（1 ≤ t ≤ 10^4）表示测试用例数。\n每个测试用例：第一行一个整数 n，第二行 n 个整数 a_i。',
      outputFormat: '对每个测试用例输出一行一个整数，表示该组能取得的最大总和。',
      guarantees: ['1 ≤ t ≤ 10^4', '1 ≤ n ≤ 2·10^5', '0 ≤ a_i ≤ 10^9', '所有测试用例的 n 之和不超过 2·10^5'],
      samples: [
        { input: '2\n3\n3 3 0\n5\n3 3 3 0 0', output: '3\n6' }
      ],
      assumptions: ['原题面未给出输出格式段，按样例推断为每个测试用例输出一行整数']
    });
  }
  if (role === 'plan') {
    return JSON.stringify({
      core: '遇到 0 就取当前可选的最大正数牌',
      why: '交换论证：把某个 0 取的 x 换成当前最大值 M 不会更差，且留下的 x ≤ M 对后面更有利',
      wrongIntuition: '把 0 当成"总能取最大值"，忽略一张牌被取走后不能再被后面的 0 使用',
      hand: { input: 'n=5, a=[3,0,2,0,1]', steps: ['读到 3 入堆', '读到 0 弹出 3（累计 3）', '读到 2 入堆', '读到 0 弹出 2（累计 5）', '读到 1 入堆但后面没有 0'] },
      correctness: '每个 0 独立且只能取一张；取当前最大值不劣于任何其它选择，因此贪心最优',
      pitfalls: ['不能用排序后的全局最大代替"当前堆顶"', '不能读完再处理（会把 0 之后的牌算进去）'],
      quiz: '如果牌堆是 [0,3] 答案是多少？'
    });
  }
  if (role === 'idea') {
    return JSON.stringify({ viable: true, approach: '用 Floyd 求全源最短路后按题意统计', reason: '数据范围小，可行', complexity: 'O(n^3)' });
  }
  if (role === 'solution') {
    if (cheatMode) {
      return ['（模拟打表题解）小 n 直接用样例答案。', '', '```python', MOCK_CHEAT_SOL_PY, '```'].join('\n');
    }
    if (failMode) {
      return ['（模拟坏题解）直接输出 0。', '', '```python', 'import sys', 'def main():', '    sys.stdin.read()', '    print(0)', 'main()', '```'].join('\n');
    }
    return [
      '用大根堆维护当前可选的正数牌：遇到正数入堆，遇到 0 就弹出堆顶累加。复杂度 O(n log n)。',
      '',
      '```python',
      MOCK_SOL_PY,
      '```'
    ].join('\n');
  }
  if (role === 'brute') {
    if (cheatBruteMode) {
      return ['（模拟打表暴力解）小 n 用样例答案，大 n 返回全 0。', '', '```python', MOCK_CHEAT_BRUTE_PY, '```'].join('\n');
    }
    if (noBruteMode) {
      return ['（模拟暴力解写不出）随便输出点东西。', '', '```python', 'print(0)', '```'].join('\n');
    }
    return [
      '暴力枚举每一步的选择（指数级），但 n ≤ 8 时完全跑得动。',
      '',
      '```python',
      MOCK_BRUTE_PY,
      '```'
    ].join('\n');
  }
  if (role === 'gen') {
    return ['```python', MOCK_GEN_PY, '```'].join('\n');
  }
  // 讲解 Agent
  const level = /L0/.test(sysText) ? 'L0' : (/L1/.test(sysText) ? 'L1' : (/L2/.test(sysText) ? 'L2' : 'L3'));
  // 注意：必须匹配"降级横幅"本身，不能用「本轮验证未通过」——
  // COMPOSE_GUIDE 里也有这几个字（"除非本轮验证未通过…"），用宽正则会误判成降级模式
  const degraded = /必须诚实降级/.test(sysText);
  const richMode = /图文并茂的互动文档/.test(sysText);
  // 模拟"讲解不合格"：缺手算演示与"为什么"、组件没闭合、还夹了"显然"、复杂度没记号
  // —— 用来验证结构校验 → 定向修复 → 机械兜底这条链路（修复版仍然不合格时也不能把裸标记交给学员）
  if (/mock-bad-explain/.test(model)) {
    return [
      '## 题面拆解', '牌堆贪心：遇到 0 取当前最大正数牌。',
      '## 关键观察', '显然每次取最大值就好，不难发现这是最优的。',
      '## 复杂度分析', '很快。',
      '## 代码', '```python', MOCK_SOL_PY, '```',
      '<viz-steps title="没闭合的组件"><viz-step title="第 1 步">忘了闭合'
    ].join('\n');
  }
  if (richMode) {
    // 模拟"富文档不合格"：只有 1 张图、div 没闭合、末尾被截断 —— 用来验证
    // 校验 → 定向修复 → 回落 Markdown → 原因要能传给用户（实测 deepseek-flash 那次就是这样失败的）
    if (/mock-bad-rich/.test(model)) {
      return [
        '下面是这道题的图文讲解。',
        '',
        '```html',
        '<div class="wrap">',
        '  <div class="hero"><h1>牌堆贪心</h1><div class="oneliner">遇到 0 取最大值</div>',
        '  <section class="chapter"><h2><span class="num">1</span>思路</h2>',
        '    <figure class="diagram"><svg viewBox="0 0 100 60"><text x="10" y="30">入堆</text></svg></figcaption></figure>',
        '```'
      ].join('\n');
    }
    // 富讲解：输出一份符合设计系统的图文文档（模拟）
    // mock-rich-soft：模拟"图确实画了，但没写成 <figure class="diagram">、末尾还少个 </div>"——
    // 真实模型很常见的写法。这类不该整份作废（作废=回落到没有图的 Markdown，学员看到"生不出图"），
    // 机械净化 + 宽容计数后应当照常交付。
    if (/mock-rich-soft/.test(model)) {
      return [
        '下面是这道题的图文讲解。',
        '',
        '```html',
        '<div class="wrap">',
        '  <div class="hero"><h1>牌堆贪心</h1><div class="oneliner">遇到 0 取当前最大值</div></div>',
        '  <section class="chapter"><h2><span class="num">1</span>思路</h2><p>用大根堆维护可选最大值。</p>',
        '    <div class="card"><svg viewBox="0 0 700 220" role="img" aria-label="扫描示意">',
        '      <rect x="20" y="60" width="120" height="60" rx="10" fill="#e8f0ff" stroke="#2f6fed"/>',
        '      <text x="80" y="96" text-anchor="middle" font-size="14" fill="#1b4fc0">正数入堆</text>',
        '    </svg><p class="cap">图 1｜扫描时的两个动作</p></div>',
        '  </section>',
        '  <section class="chapter"><h2><span class="num">2</span>复杂度分析</h2>',
        '    <div class="card"><svg viewBox="0 0 640 200" role="img" aria-label="复杂度对比">',
        '      <text x="320" y="100" text-anchor="middle" font-size="14" fill="#3c4a6b">O(n log n) 对比 O(n²)</text>',
        '    </svg><p class="cap">图 2｜两种做法的规模增长</p></div>',
        '  </section>',
        '  <section class="chapter"><h2><span class="num">3</span>代码</h2><pre class="code">heapq.heappush</pre>',
        '  </section>',
        '  <div class="footer">验证：官方样例 2 组通过 · 随机对拍 120 组一致</div>',
        // 故意不写收尾的 </div>
        '```'
      ].join('\n');
    }
    // 富讲解：输出一份符合设计系统的图文文档（模拟）
    return [
      '下面是这道题的图文讲解。',
      '',
      '```html',
      MOCK_RICH_DOC(degraded),
      '```'
    ].join('\n');
  }
  const code = level === 'L3' && !degraded
    ? '\n## 代码\n\n```python\n' + MOCK_SOL_PY + '\n```\n'
    : '\n（本等级按要求不贴完整代码' + (degraded ? '：本轮未验证通过' : '') + '）\n';
  return [
    degraded ? '【诚实降级模式】这题我还没能验证通过，以下是我的思路，供你参考。' : '',
    '## 题面拆解',
    '',
    '牌堆里依次给出若干张牌，遇到 0 时可以取走此前出现的最大正数牌，目标是让取走的牌面之和最大。',
    '容易读错的一点：**已经被取走的牌不能再被后面的 0 使用**（不是"每个 0 都能取最大值"）。',
    '',
    '## 关键观察',
    '',
    '每个 0 只影响它**之前**出现过的牌，且取走一张就少一张——所以问题等价于"每个 0 从当前剩余集合里取走最大值"。',
    '',
    '## 为什么',
    '',
    '假设某个 0 没有取当前最大值 $M$ 而取了 $x<M$：把它换成 $M$ 只会让总和变大，而且 $x$ 留在集合里给后面的 0 用，',
    '不会比 $M$ 更差（$x \\le M$）。所以"每次取最大值"不劣于任何其它取法 —— 这是**交换论证**，不是"看起来合理"。',
    '错误直觉是把 0 当成"可以随便取"，忽略了一张牌只能被取一次。',
    '<viz-compare a="大根堆贪心" b="排序后枚举">$O(n\\log n)$，一次扫描即可 || 需要枚举每个 0 的取法，指数级</viz-compare>',
    '',
    '## 手算演示',
    '',
    '拿牌堆 $a=[3,0,2,0,1]$ 走一遍（$n=5$）：',
    '<viz-steps title="拿 a=[3,0,2,0,1] 走一遍">'
      + '<viz-step title="第 1 步：读到 3">正数入堆，堆 = {3}，累计 = 0</viz-step>'
      + '<viz-step title="第 2 步：读到 0">弹出堆顶 3，累计 = 3，堆空</viz-step>'
      + '<viz-step title="第 3 步：读到 2">入堆，堆 = {2}</viz-step>'
      + '<viz-step title="第 4 步：读到 0">弹出 2，累计 = 5，堆空</viz-step>'
      + '<viz-step title="第 5 步：读到 1">入堆但后面没有 0 了 → 不计入</viz-step>'
      + '</viz-steps>',
    '结果 $5$；对比"每个 0 都无条件取最大值"的错误算法会得到 $3+3=6$，第 4 步就拿不到 3 了。',
    '',
    '## 算法',
    '',
    '用大根堆维护"当前可用且未被取走"的正数：遇到正数入堆；遇到 0 时若堆非空则弹出堆顶累加。',
    '<viz-callout type="danger" title="易错点">不能只看数值不看顺序：0 只能取它**之前**的牌，所以必须边读边维护堆。</viz-callout>',
    '',
    '## 复杂度分析',
    '',
    '每个元素入堆一次、出堆至多一次，单次操作 $O(\\log n)$，总计 $O(n \\log n)$；空间 $O(n)$。',
    '<viz-formula title="复杂度" fx="$T(n) = O(n\\log n)$" legend="n=牌的数量; h=堆中元素数" why="每个元素最多进出堆一次，堆操作是对数级。"/>',
    code,
    '## 讲解',
    '',
    '- `heapq.heappush(heap, -x)`：Python 只有小根堆，存负数模拟大根堆。',
    '- 遇到 0 时若堆非空则弹出堆顶累加，保证每次取的都是当前可选最大值。',
    '',
    '## 易错点',
    '',
    '1. 把 0 当成无条件取最大值（忽略"取走即消失"）→ 会得到偏大的错误答案；',
    '2. 读完整个数组再统一处理 → 会把 0 之后的牌也算进去。',
    '',
    '## 验证',
    '',
    '官方样例 2 组通过 · 与暴力解随机对拍 120 组一致。',
    '<viz-quiz title="自测"><viz-q q="为什么遇到 0 取当前最大值最优？" a="每个 0 独立且只能取一张">取更小的牌不会给后面的 0 带来好处（交换论证）。</viz-q></viz-quiz>'
  ].filter((x) => x !== '').join('\n');
}

/** 富讲解文档样例（符合 lib/richdoc.js 的白名单与结构要求） */
function MOCK_RICH_DOC(degraded) {
  return [
    '<div class="wrap">',
    '  <div class="hero">',
    '    <span class="kicker">CF 1800C · 贪心 + 堆</span>',
    '    <h1>每个 0 取走此前最大的正数牌</h1>',
    '    <p class="subtitle">按顺序贪心，用大根堆维护当前可选的最大值。</p>',
    '    <div class="meta"><span>🏷 <b>标签</b>：greedy, heap</span><span>⏱ <b>复杂度</b>：O(n log n)</span></div>',
    '    <div class="oneliner"><b>一句话总结：</b>遇到 0 就弹出堆顶累加，正数入堆。</div>',
    '  </div>',
    '  <section class="chapter" id="c1"><h2><span class="num">1</span>题意与坑点</h2>',
    '    <p class="lead">看清"0 只能取走它之前的牌"这一条。</p>',
    degraded ? '<div class="callout warn"><span class="ttl">注意</span>本轮未验证通过，以下内容供参考。</div>' : '',
    '    <div class="callout key"><span class="ttl">关键</span>每个 0 独立地取走当前剩余的最大正数牌。</div>',
    '  </section>',
    '  <section class="chapter" id="c2"><h2><span class="num">2</span>思路</h2>',
    '    <figure class="diagram"><svg viewBox="0 0 420 90" role="img" aria-label="扫描示意">',
    '      <rect x="10" y="24" width="80" height="40" rx="10" fill="#e8f0ff" stroke="#2f6fed"/>',
    '      <text x="50" y="49" text-anchor="middle" font-size="13" fill="#1b4fc0">正数入堆</text>',
    '      <rect x="310" y="24" width="90" height="40" rx="10" fill="#e3f7f0" stroke="#12a075"/>',
    '      <text x="355" y="49" text-anchor="middle" font-size="13" fill="#0a7a58">0 弹堆顶</text>',
    '      <line x1="95" y1="44" x2="300" y2="44" stroke="#6b7899" stroke-width="1.6"/>',
    '    </svg><figcaption><b>图 1</b>｜扫描时的两个动作。</figcaption></figure>',
    '  </section>',
    '  <section class="chapter" id="c3"><h2><span class="num">3</span>复杂度分析</h2>',
    '    <div class="formula"><div class="fx">T(n) = <span class="var">n</span> · log n</div>',
    '      <div class="legend"><dl><dt>n</dt><dd>牌的数量</dd></dl></div>',
    '      <div class="why"><b>它在说什么：</b>每个元素最多进出堆一次。</div></div>',
    '    <figure class="diagram"><svg viewBox="0 0 320 110" role="img" aria-label="复杂度对比">',
    '      <rect x="20" y="60" width="60" height="40" rx="6" fill="#e8f0ff" stroke="#2f6fed"/>',
    '      <text x="50" y="52" text-anchor="middle" font-size="12" fill="#1b4fc0">O(n log n)</text>',
    '      <rect x="120" y="20" width="60" height="80" rx="6" fill="#ffe9ed" stroke="#e0455f"/>',
    '      <text x="150" y="14" text-anchor="middle" font-size="12" fill="#b8273f">O(n²)</text>',
    '      <text x="240" y="70" text-anchor="middle" font-size="12" fill="#3c4a6b">堆贪心更快</text>',
    '    </svg><figcaption><b>图 2</b>｜两种做法的规模增长对比。</figcaption></figure>',
    '  </section>',
    '  <section class="chapter" id="c4"><h2><span class="num">4</span>代码</h2>',
    '    <pre class="code"><span class="kw">import</span> heapq</pre>',
    '  </section>',
    '  <section class="chapter" id="c5"><h2><span class="num">5</span>交互演示</h2>',
    '    <div class="anim-box" data-anim="sequence"><div class="head"><h5>演示：扫描顺序</h5>',
    '      <span><button class="ctl" type="button">▶ 播放</button><button class="ctl ghost" type="button">重置</button></span></div>',
    '      <div class="tokens"><span class="tok">3</span><span class="tok">0</span><span class="tok alt">2</span><span class="tok">0</span></div></div>',
    '  </section>',
    '  <div class="quiz"><div class="q"><div class="qh"><span class="idx">1</span>为什么遇到 0 取最大值最优？</div>',
    '    <div class="qa"><p class="ans">因为每个 0 独立且只取一张。</p></div></div></div>',
    '  <div class="footer">验证：官方样例 2 组通过 · 随机对拍 120 组一致</div>',
    '</div>'
  ].filter(Boolean).join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'mock-gpt-4', object: 'model' },
        { id: 'mock-gpt-mini', object: 'model' },
        { id: 'mock-claude', object: 'model' }
      ] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chatRequests, capEmptyServed }));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      chatRequests++;
      await openaiChat(req, res, body); return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
      chatRequests++;
      await anthropicChat(req, res, body); return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock: not found ' + url.pathname } }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(e && e.message || e) } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock-llm] listening on http://127.0.0.1:' + PORT);
  console.log('[mock-llm] OpenAI 兼容: POST /v1/chat/completions');
  console.log('[mock-llm] Anthropic:     POST /v1/messages');
  console.log('[mock-llm] 模型列表:      GET  /v1/models');
});
