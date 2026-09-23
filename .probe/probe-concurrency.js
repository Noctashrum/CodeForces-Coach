'use strict';
// 聚焦复现 e2e 里的并发断言失败：打印三路 agentStart/agentEnd 的原始事件与时间窗
const BASE = process.argv[2] || 'http://127.0.0.1:3215';
const MODEL = process.argv[3] || 'mock-delay';

async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
}

(async () => {
  const t0 = Date.now();
  const spans = {};
  const raw = [];
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: process.argv[4], mode: 'send', userContent: 'CF 2264D 讲解一下' })
  });
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
      let ev = null;
      try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (/^agent/.test(ev.type)) {
        raw.push(ev.type + ' ' + ev.role + ' @+' + (Date.now() - t0) + (ev.ms != null ? ' ms=' + ev.ms : ''));
        if (ev.type === 'agentStart') spans[ev.role] = { start: Date.now() - t0, end: null };
        if (ev.type === 'agentEnd' && spans[ev.role]) spans[ev.role].end = Date.now() - t0;
      }
    }
  }
  console.log('总耗时 ' + (Date.now() - t0) + 'ms');
  console.log('模型: ' + MODEL);
  Object.keys(spans).forEach((k) => console.log('  ' + k.padEnd(10) + JSON.stringify(spans[k])));
  console.log('原始 agent 事件序列:');
  raw.forEach((x) => console.log('  ' + x));
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });
