/**
 * probe-e2e-cases.js — 定点复现 e2e 里几条"看不清原因"的用例，把关键事件打出来。
 *
 * 用法：node .probe/probe-e2e-cases.js [debug|badrich|hint|doc|rethink]
 */
'use strict';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3210';
const MOCK = process.env.E2E_MOCK || 'http://127.0.0.1:3997/v1';

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
}

async function chat(convId, userContent) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, mode: 'send', userContent })
  });
  const events = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch (e) { /* ignore */ }
    }
  }
  return events;
}

async function mkConv(patch) {
  const cfg = (await api('/api/config')).json;
  cfg.providers = [{ id: 'mock-p', name: 'Mock', type: 'openai', baseUrl: MOCK, apiKey: 'k', extraHeaders: {}, models: ['mock-gpt-4', 'mock-delay', 'mock-bad-rich', 'mock-bad-explain', 'mock-cap-empty'], stream: true }];
  cfg.defaultProviderId = 'mock-p';
  cfg.defaultModel = 'mock-gpt-4';
  await api('/api/config', { method: 'POST', body: JSON.stringify(cfg) });
  const conv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
  await api('/api/conversations/' + conv.id, { method: 'PATCH', body: JSON.stringify(Object.assign({ mode: 'coach', lang: 'python' }, patch || {})) });
  return conv;
}

function report(tag, evs) {
  const calls = evs.filter((e) => e.type === 'tool').map((e) => (e.calls || [])).flat();
  const tools = calls.map((c) => c.name);
  const res = evs.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => (r.ok ? '✓' : '✗') + r.name + ': ' + String(r.summary || '').slice(0, 120))).flat();
  const done = evs.find((e) => e.type === 'done');
  console.log('\n===== ' + tag + ' =====');
  console.log('工具：' + tools.join(','));
  console.log('cf_verify 参数：' + JSON.stringify(calls.filter((c) => c.name === 'cf_verify').map((c) => {
    try { const a = JSON.parse(c.args || '{}'); return Object.assign({}, a, { userCode: a.userCode ? String(a.userCode).slice(0, 40) + '…' : undefined, statement: a.statement ? String(a.statement).slice(0, 30) + '…' : undefined }); } catch (e) { return String(c.args).slice(0, 80); }
  })));
  console.log('结果：\n  ' + res.join('\n  '));
  console.log('notice：' + evs.filter((e) => e.type === 'notice').map((e) => e.message.slice(0, 120)).join(' | '));
  console.log('done：content ' + String((done && done.message.content) || '').length
    + ' 字｜richDoc ' + String((done && done.message.richDoc) || '').length
    + '｜verification ' + JSON.stringify((done && done.message.verification) || null));
  console.log('content 开头：' + JSON.stringify(String((done && done.message.content) || '').slice(0, 120)));
}

async function main() {
  const which = process.argv[2] || 'debug';

  if (which === 'debug') {
    const conv = await mkConv({ intent: 'debug' });
    const badUserCode = ['```python', 'import sys', 'def main():', '    data = sys.stdin.read().split()',
      '    print(0)   # 故意写错的用户代码', 'main()', '```'].join('\n');
    report('代码诊断（debug + 用户代码）', await chat(conv.id, 'CF 1800C 我的代码为什么 WA？\n\n' + badUserCode));
  } else if (which === 'health') {
    const conv = await mkConv({ intent: 'debug' });
    const broken = ['```python', 'import sys', 'def main(:', '    print(1)', '```'].join('\n');
    report('代码体检（语法错误）', await chat(conv.id, 'CF 1800C 我的代码编译报错\n\n' + broken));
  } else if (which === 'badrich') {
    const conv = await mkConv({ model: 'mock-bad-rich' });
    report('富讲解失败（一直写坏文档）', await chat(conv.id, 'CF 1800C 用图文讲解一遍'));
  } else if (which === 'hint') {
    const conv = await mkConv({ intent: 'hint' });
    report('思路提示', await chat(conv.id, 'CF 1800C 给我点思路'));
  } else if (which === 'doc') {
    const conv = await mkConv({ intent: 'debug' });
    await chat(conv.id, 'CF 1800C 讲解一下');
    report('图文讲解（已有上下文再要文档）', await chat(conv.id, 'CF 1800C 用图文讲解一遍'));
  } else if (which === 'soft') {
    const conv = await mkConv({ model: 'mock-rich-soft' });
    const evs = await chat(conv.id, 'CF 1800C 用图文讲解一遍');
    report('软失败文档（图在、写法不规范、末尾缺闭合）', evs);
    const done = evs.find((e) => e.type === 'done');
    const doc = String((done && done.message.richDoc) || '');
    console.log('richDoc ' + doc.length + ' 字｜svg ' + ((doc.match(/<svg/gi) || []).length)
      + '｜card ' + ((doc.match(/class="card"/g) || []).length));
  } else if (which === 'rethink') {
    const conv = await mkConv({ intent: 'full' });
    await chat(conv.id, 'CF 1800C 讲解一下');
    report('换讲法（我没听懂）', await chat(conv.id, '我没听懂，能不能换个说法'));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
