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
  'import random',
  'print(random.randint(1, 10), random.randint(1, 10))'
].join('\n');

function scriptFor(body, opts) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const userText = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const wrong = /错解/.test(userText) || opts.wrong;
  const code = wrong ? WRONG : SOLUTION;
  const steps = (body.messages || []).filter((m) => m.role === 'tool').length;
  const names = tools.map((t) => t.function && t.function.name).filter(Boolean);
  if (!names.length) {
    return { text: '思路：读入两个整数并输出它们的和。\n\n```python\n' + code + '\n```' };
  }
  const has = (n) => names.indexOf(n) >= 0;
  if (steps === 0 && has('write_file')) return { call: { name: 'write_file', args: { path: 'brute.py', content: BRUTE } } };
  if (steps === 1 && has('write_file')) return { call: { name: 'write_file', args: { path: 'gen.py', content: GEN } } };
  if (steps === 2 && has('write_file')) return { call: { name: 'write_file', args: { path: 'solution.py', content: code } } };
  if (steps === 3 && has('stress_test')) {
    return { call: { name: 'stress_test', args: { solution: 'solution.py', brute: 'brute.py', gen: 'gen.py', iterations: 10 } } };
  }
  return { text: '思路：读入 a、b 输出 a+b（暴力解与生成器已对拍通过）。\n\n```python\n' + code + '\n```' };
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

module.exports = { startMockLlm, SOLUTION, WRONG, BRUTE, GEN, scriptFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  let port = 3999;
  const i = args.indexOf('--port');
  if (i >= 0) port = parseInt(args[i + 1], 10) || 3999;
  const wrong = args.indexOf('--wrong') >= 0;
  startMockLlm({ port, wrong }).then((s) => {
    console.log('[mock-ablation] listening on ' + s.url);
    console.log('[mock-ablation] 用法示例：node ablation/run.js --base-url ' + s.url + ' --api-key mock --model mock-gpt-4 --level L0,L1 --problems example-ab');
  });
}
