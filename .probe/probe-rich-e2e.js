'use strict';
/**
 * probe-rich-e2e.js — 富讲解"生不出图"的**端到端**真实诊断（用真实模型跑真实链路）
 *
 * 用法：node .probe/probe-rich-e2e.js [真实配置路径] [端口]
 *   默认读 dist/CFCoach-win32-x64/data/config.json（真实服务商与密钥），
 *   拷进**隔离数据目录**后跑，绝不碰真实数据。
 *
 * 它做的事：mock-cf（题面）+ 真实 server + 真实模型，开富讲解发一道题，然后如实报告：
 *   · 每个阶段 chip 的结论（尤其"图文文档校验"那条）
 *   · richDoc 事件有没有来、文档多大、里面有几张 <svg>/<figure>（**生图**的关键）
 *   · 工作区里留下了什么（richdoc.html 成功件 / richdoc-attempt*.html 被拒件）
 *   · 迭代轨迹里有没有 richdoc-fallback / richdoc-fail，以及具体原因
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const cfgArg = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data', 'config.json');
const PORT = parseInt(process.argv[3] || '3217', 10);
const CF_PORT = 3998;
const DATA = path.join(ROOT, '.test-data', 'rich-e2e');
const BASE = 'http://127.0.0.1:' + PORT;

const kids = [];
function start(name, args, env) {
  const c = spawn(process.execPath, args, {
    cwd: ROOT, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, env || {})
  });
  c.on('exit', (code) => { if (code) console.log('[probe] ' + name + ' 退出 code=' + code); });
  kids.push(c);
  return c;
}
const stopAll = () => kids.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } });
process.on('exit', stopAll);

async function api(p, opts) {
  const r = await fetch(BASE + p, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
}

async function sse(body, onEvent) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.indexOf('data:') === 0);
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      events.push(ev);
      if (onEvent) onEvent(ev);
    }
  }
  return events;
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(cfgArg, 'utf8').replace(/^\uFEFF/, ''));
  const provider = (cfg.providers || []).find((p) => p.id === cfg.defaultProviderId) || (cfg.providers || [])[0];
  const model = cfg.defaultModel || (provider.models || [])[0];
  console.log('真实服务商: ' + provider.name + ' · ' + provider.baseUrl + ' · 模型 ' + model);
  console.log('源配置 maxOutputTokens = ' + JSON.stringify(cfg.maxOutputTokens) + '（缺省时由 DEFAULT_CONFIG 兜底）');

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  // 隔离配置：只带服务商与密钥，其余用默认（不碰真实数据）
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    version: 1,
    defaultProviderId: provider.id,
    defaultModel: model,
    defaultCoachLang: 'cpp',
    cfHandle: cfg.cfHandle || '',
    providers: cfg.providers
  }, null, 2), 'utf8');

  start('mock-cf', [path.join(ROOT, 'scripts', 'mock-cf.js')], { PORT: String(CF_PORT) });
  start('server', [path.join(ROOT, 'server.js')], {
    PORT: String(PORT), CF_BASE: 'http://127.0.0.1:' + CF_PORT, CHATBOX_DATA_DIR: DATA
  });
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(BASE + '/api/info')).ok; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!up) { console.error('server 没起来'); stopAll(); process.exit(1); }

  const conv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
  await api('/api/conversations/' + conv.id, {
    method: 'PATCH',
    body: JSON.stringify({ mode: 'coach', lang: 'cpp', intent: 'full', rich: true, model, providerId: provider.id })
  });
  const chk = (await api('/api/conversations/' + conv.id)).json;
  console.log('会话: rich=' + chk.rich + ' mode=' + chk.mode + ' lang=' + chk.lang + ' model=' + chk.model);

  const t0 = Date.now();
  const chips = [];
  let richDocEvent = null;
  const notes = [];
  const evs = await sse({ conversationId: conv.id, mode: 'send', userContent: 'CF 1800C 讲解一下' }, (ev) => {
    if (ev.type === 'toolResult') (ev.results || []).forEach((r) => {
      chips.push(r.name + ' :: ' + (r.ok === false ? '✗ ' : '✓ ') + r.summary);
      if (r.ok === false) console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] 步骤失败 → ' + r.name + '：' + r.summary);
    });
    if (ev.type === 'richDoc') { richDocEvent = ev; console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] 收到 richDoc 事件，size=' + ev.size); }
    if (ev.type === 'notice') notes.push(ev.text || ev.message || JSON.stringify(ev));
    if (ev.type === 'done') console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] done');
    if (ev.type === 'error') console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] error: ' + JSON.stringify(ev).slice(0, 200));
  });
  console.log('\n整轮耗时 ' + Math.round((Date.now() - t0) / 1000) + 's，事件 ' + evs.length + ' 个');

  const convNow = (await api('/api/conversations/' + conv.id)).json;
  const last = convNow.messages[convNow.messages.length - 1] || {};
  const ws = (await api('/api/workspace?convId=' + conv.id)).json;
  const doc = last.richDoc || '';
  const traj = (ws.meta && ws.meta.trajectory) || [];
  const files = (ws.files || []).map((f) => f.name);

  console.log('\n================ 结论 ================');
  console.log('消息状态: ' + last.status + ' · 正文 ' + String(last.content || '').length + ' 字');
  console.log('richDoc 事件: ' + (richDocEvent ? '有（' + richDocEvent.size + ' 字）' : '没有'));
  console.log('落盘 richDoc: ' + (doc ? doc.length + ' 字' : '（无）'));
  if (doc) {
    console.log('  文档内 <svg> 数: ' + (doc.match(/<svg/gi) || []).length
      + ' · <figure 数: ' + (doc.match(/<figure/gi) || []).length
      + ' · viewBox 数: ' + (doc.match(/viewBox=/gi) || []).length
      + ' · data-anim 数: ' + (doc.match(/data-anim=/gi) || []).length);
  }
  console.log('工作区文件: ' + files.join(', '));
  const richChips = chips.filter((c) => /richdoc|图文/.test(c));
  console.log('图文相关步骤:');
  richChips.forEach((c) => console.log('  · ' + c));
  const richTraj = traj.filter((t) => /richdoc/.test(t.kind));
  console.log('轨迹里的图文结论:');
  richTraj.forEach((t) => console.log('  · ' + t.kind + '：' + String(t.note || '').slice(0, 220)));
  if (notes.length) { console.log('前端提醒:'); notes.forEach((n) => console.log('  · ' + n)); }

  const ok = !!doc && (doc.match(/<svg/gi) || []).length >= 2;
  console.log('\n判定: ' + (ok ? '✅ 富讲解生成了带图的文档' : '❌ 没有生成带图文档（走了回落或失败）'));
  await api('/api/conversations/' + conv.id, { method: 'DELETE' });
  stopAll();
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('探针异常: ' + ((e && e.stack) || e)); stopAll(); process.exit(1); });
