/**
 * dump-coach-events.js — 把一轮教练对话的 SSE 事件流打成可读清单。
 *
 * 用途：改 e2e 断言之前，先看清**新架构到底发了什么事件**（旧断言是按老词汇表写的：
 * tool 事件里带 harness_contract / harness_stress，done 里带 richDoc…）。
 * 用法：node .probe/dump-coach-events.js [用户消息] [模型名]
 */
'use strict';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3210';
const MOCK = process.env.E2E_MOCK || 'http://127.0.0.1:3999/v1';
const USER = process.argv[2] || 'CF 1800C 讲解一下';
const MODEL = process.argv[3] || 'mock-gpt-4';
const INTENT = process.argv[4] || '';

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
}

async function main() {
  const cfg = (await api('/api/config')).json;
  cfg.providers = [{ id: 'mock-p', name: 'Mock', type: 'openai', baseUrl: MOCK, apiKey: 'k', extraHeaders: {}, models: ['mock-gpt-4', 'mock-delay'], stream: true }];
  cfg.defaultProviderId = 'mock-p';
  cfg.defaultModel = MODEL;
  const maxTok = Number(process.argv[5] || 0);
  if (maxTok > 0) cfg.maxOutputTokens = maxTok;
  await api('/api/config', { method: 'POST', body: JSON.stringify(cfg) });

  const conv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
  await api('/api/conversations/' + conv.id, { method: 'PATCH', body: JSON.stringify(Object.assign({ mode: 'coach', lang: 'python', model: MODEL }, INTENT ? { intent: INTENT } : {})) });

  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conv.id, mode: 'send', userContent: USER })
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

  console.log('事件总数 ' + events.length + '，类型统计：');
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log('  ' + JSON.stringify(byType));

  console.log('\n--- 顺序（同类型折叠）---');
  let last = '';
  for (const e of events) {
    if (e.type === last && e.type !== 'tool' && e.type !== 'agentStart') continue;
    last = e.type;
    let extra = '';
    if (e.type === 'tool') extra = (e.calls || []).map((c) => c.name).join(',');
    else if (e.type === 'toolResult') extra = (e.results || []).map((r2) => r2.name + (r2.ok ? '✓' : '✗')).join(',');
    else if (e.type === 'agentStart') extra = e.role;
    else if (e.type === 'agentEnd') extra = e.role + (e.ok ? '✓' : '✗') + ' ' + e.ms + 'ms';
    else if (e.type === 'usage') extra = JSON.stringify(e);
    else if (e.type === 'richDoc') extra = 'html ' + String(e.html || '').length + ' 字符';
    else if (e.type === 'delta') extra = JSON.stringify(String(e.text || '').slice(0, 40));
    console.log('  ' + e.type + ' ' + extra);
  }

  const done = events.find((e) => e.type === 'done');
  if (done) {
    const m = done.message || {};
    console.log('\n--- done.message 字段 ---');
    console.log('  keys: ' + Object.keys(m).join(', '));
    console.log('  content 长度: ' + String(m.content || '').length
      + ' | reasoning 长度: ' + String(m.reasoning || '').length
      + ' | richDoc: ' + (m.richDoc ? String(m.richDoc).length + ' 字符' : '无')
      + ' | tools: ' + JSON.stringify(m.tools || null));
    console.log('  content 前 200 字: ' + JSON.stringify(String(m.content || '').slice(0, 200)));
  }
  const conv2 = (await api('/api/conversations/' + conv.id)).json;
  const lastMsg = (conv2.messages || [])[conv2.messages.length - 1] || {};
  console.log('\n--- 落盘消息 ---');
  console.log('  keys: ' + Object.keys(lastMsg).join(', '));
  console.log('  content 长度: ' + String(lastMsg.content || '').length
    + ' | richDoc: ' + (lastMsg.richDoc ? String(lastMsg.richDoc).length : '无')
    + ' | usage: ' + JSON.stringify(lastMsg.usage || null));
  const ws = await api('/api/workspace?convId=' + conv.id);
  console.log('\n--- workspace ---');
  console.log('  ' + JSON.stringify(ws.json && { files: (ws.json.files || []).map((f) => f.name), verification: ws.json.verification && ws.json.verification.status }));
}

main().catch((e) => { console.error(e); process.exit(1); });
