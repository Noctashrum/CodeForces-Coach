'use strict';
/**
 * probe-cap-retry.js — 单次输出上限被"思考"吃光的诊断（快，约 30 秒）
 *
 * 场景：用户在设置里填了 max_tokens（例如 4096），而模型是推理型——
 * 预算全花在思考上，正文 0 字、finish_reason=length。
 * 期望：服务端自动**去掉上限重试一次**，最终仍然拿到完整讲解（而不是空回复）。
 *
 * 用法：node .probe/probe-cap-retry.js [模型] [maxOutputTokens]
 *   模型默认 mock-cap-empty（mock-llm 里专门模拟这种截断），也可以填 mock-rich-soft / mock-gpt-4 做对照。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODEL = process.argv[2] || 'mock-cap-empty';
const MAXOUT = parseInt(process.argv[3] || '4096', 10);
const PORT = 3220;
const CF_PORT = 3998;
const LLM_PORT = 3999;
const DATA = path.join(ROOT, '.test-data', 'probe-cap');
const BASE = 'http://127.0.0.1:' + PORT;

const kids = [];
const start = (args, env) => {
  const c = spawn(process.execPath, args, { cwd: ROOT, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, env || {}) });
  kids.push(c);
  return c;
};
const stopAll = () => kids.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } });
process.on('exit', stopAll);

const api = async (p, opts) => {
  const r = await fetch(BASE + p, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}));
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* ignore */ }
  return { status: r.status, json: j, text: t };
};

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{ id: 'mock-p', name: 'Mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1', apiKey: 'k', extraHeaders: {}, models: [MODEL, 'mock-gpt-4'], stream: true }],
    defaultProviderId: 'mock-p', defaultModel: MODEL, maxOutputTokens: MAXOUT, defaultCoachLang: 'python'
  }, null, 2), 'utf8');
  start([path.join(ROOT, 'scripts', 'mock-cf.js')], { PORT: String(CF_PORT) });
  start([path.join(ROOT, 'scripts', 'mock-llm.js')], { PORT: String(LLM_PORT) });
  start([path.join(ROOT, 'server.js')], { PORT: String(PORT), CF_BASE: 'http://127.0.0.1:' + CF_PORT, CHATBOX_DATA_DIR: DATA });
  const end = Date.now() + 15000;
  let up = false;
  while (Date.now() < end && !up) {
    try { up = (await fetch(BASE + '/api/info')).ok; } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) { console.error('server 没起来'); process.exit(1); }
  console.log('模型 ' + MODEL + ' · maxOutputTokens=' + MAXOUT);

  const before = await (await fetch('http://127.0.0.1:' + LLM_PORT + '/__stats')).json();
  const conv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
  await api('/api/conversations/' + conv.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', rich: true, model: MODEL }) });
  const t0 = Date.now();
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: conv.id, mode: 'send', userContent: 'CF 1800C 用图文讲解一遍' })
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const chips = [];
  let done = null;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.indexOf('data:') === 0);
      if (!line) continue;
      let ev = null; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (ev.type === 'toolResult') (ev.results || []).forEach((x) => chips.push(x.name + ' :: ' + (x.ok === false ? '✗ ' : '✓ ') + x.summary));
      if (ev.type === 'notice') console.log('  notice: ' + (ev.message || ev.text));
      if (ev.type === 'error') console.log('  error: ' + JSON.stringify(ev).slice(0, 200));
      if (ev.type === 'done') done = ev;
    }
  }
  const after = await (await fetch('http://127.0.0.1:' + LLM_PORT + '/__stats')).json();
  const last = (await api('/api/conversations/' + conv.id)).json.messages.slice(-1)[0] || {};
  console.log('耗时 ' + Math.round((Date.now() - t0) / 1000) + 's');
  console.log('mock 统计: 请求 ' + (after.chatRequests - before.chatRequests) + ' 次，其中"上限吃光"响应 '
    + (after.capEmptyServed - before.capEmptyServed) + ' 次');
  console.log('步骤:');
  chips.filter((c) => /richdoc|讲解|题解|暴力|生成器|stress/.test(c)).forEach((c) => console.log('  · ' + c));
  console.log('消息: status=' + last.status + ' 正文=' + String(last.content || '').length + ' 字 richDoc='
    + String(last.richDoc || '').length + ' 字 svg=' + ((last.richDoc || '').match(/<svg/gi) || []).length);
  const ok = (after.capEmptyServed - before.capEmptyServed) > 0
    && last.status === 'done' && String(last.richDoc || '').length > 2000
    && ((last.richDoc || '').match(/<svg/gi) || []).length >= 2;
  console.log('判定: ' + (ok ? '✅ 上限生效 + 自动重试救回完整讲解' : '❌ 没救回来'));
  stopAll();
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('探针异常: ' + ((e && e.stack) || e)); stopAll(); process.exit(1); });
