'use strict';
/**
 * probe-parallel-stop.js — 两件事的实测探针（用真实 server + 真实 SSE，不用假 callAgent）：
 *  A) **并发是否真的生效**：mock-llm 的 mock-delay 模式给三个角色固定延迟
 *     （题解 2.5s / 暴力 1.5s / 生成器 0.8s），这里记录每个 role 的 agentStart/agentEnd 时间戳，
 *     打印时间窗。真并发 → 三个窗口重叠、总时长≈2.6s；串行 → 总时长≈4.8s 且首尾相接。
 *  B) **中途停止后的状态**：发一个请求，跑到一半客户端 abort，随后检查
 *     /api/generations 是否还认为它在生成、会话里那条消息的 status 是什么、有没有残缺的 streaming。
 *
 * 用法：node .probe/probe-parallel-stop.js <baseUrl> <convId 可选>
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3214';

async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
}

async function sseChat(body, onEvent, abortAfterMs, beforeAbort) {
  const ctrl = new AbortController();
  if (abortAfterMs) {
    setTimeout(async () => {
      if (beforeAbort) { try { await beforeAbort(); } catch (e) { /* ignore */ } }
      try { ctrl.abort(); } catch (e) { /* ignore */ }
    }, abortAfterMs);
  }
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).catch((e) => ({ ok: false, err: e }));
  if (!res || !res.ok) return { aborted: true, events: [] };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      parts.forEach((chunk) => {
        const line = chunk.split('\n').find((l) => l.indexOf('data: ') === 0);
        if (!line) return;
        let ev = null;
        try { ev = JSON.parse(line.slice(6)); } catch (e) { return; }
        events.push(ev);
        if (onEvent) onEvent(ev);
      });
    }
  } catch (e) {
    return { aborted: true, events, err: String(e && e.message) };
  }
  return { aborted: false, events };
}

(async () => {
  console.log('探针目标: ' + BASE);

  /* ---------- A) 并发测量 ---------- */
  await api('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providers: [{ id: 'mock-p', name: 'Mock', type: 'openai', baseUrl: 'http://127.0.0.1:3999/v1', apiKey: 'k', extraHeaders: {}, models: ['mock-delay'], stream: true }],
      defaultProviderId: 'mock-p', defaultModel: 'mock-delay', cfHandle: 'tester', defaultCoachLang: 'python'
    })
  });
  const conv = (await api('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json;
  await api('/api/conversations/' + conv.id, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-delay' })
  });

  const t0 = Date.now();
  const spans = {};
  const done = await sseChat({ conversationId: conv.id, mode: 'send', userContent: 'CF 1800C 讲解一下' }, (ev) => {
    if (ev.type === 'agentStart') spans[ev.role] = { start: Date.now() - t0, end: null, label: ev.label };
    if (ev.type === 'agentEnd' && spans[ev.role]) spans[ev.role].end = Date.now() - t0;
  });
  console.log('\n[A] 事件数: ' + done.events.length + '，总耗时: ' + (Date.now() - t0) + 'ms');
  ['solution', 'brute', 'gen'].forEach((r) => {
    const s = spans[r];
    console.log('  ' + r.padEnd(9) + ' : ' + (s ? ('start ' + s.start + 'ms → end ' + s.end + 'ms（' + (s.end - s.start) + 'ms）') : '（没看到）'));
  });
  const ss = ['solution', 'brute', 'gen'].map((r) => spans[r]).filter(Boolean);
  if (ss.length === 3) {
    const latestStart = Math.max.apply(null, ss.map((x) => x.start));
    const earliestEnd = Math.min.apply(null, ss.map((x) => x.end));
    const span = Math.max.apply(null, ss.map((x) => x.end)) - Math.min.apply(null, ss.map((x) => x.start));
    console.log('  三窗口是否重叠: ' + (latestStart < earliestEnd ? '✅ 是（真并发）' : '❌ 否（看起来是串行）')
      + ' | 三路总跨度 ' + span + 'ms（真并发≈2600ms，串行≈4800ms）');
  }
  // 决策轨迹里的 at/ms 是另一份证据（用户在"决策轨迹"里看到的就是它）
  const ws = (await api('/api/workspace?convId=' + conv.id)).json;
  const tr = (ws.trace || []).filter((t) => ['solution', 'brute', 'gen'].indexOf(t.role) >= 0);
  if (tr.length) {
    const base = Math.min.apply(null, tr.map((t) => t.at));
    console.log('  决策轨迹（相对第一条）:');
    tr.forEach((t) => console.log('    ' + t.role.padEnd(9) + ' at +' + (t.at - base) + 'ms  ms=' + t.ms));
  }

  /* ---------- B) 中途停止 ---------- */
  console.log('\n[B] 中途停止（1.5 秒后客户端 abort；用**全新题目**确保真的在链路中途）');
  const conv2 = (await api('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json;
  await api('/api/conversations/' + conv2.id, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-delay' })
  });
  const t1 = Date.now();
  const stopRes = await sseChat({ conversationId: conv2.id, mode: 'send', userContent: 'CF 2264D 讲解一下' }, null, 1500, async () => {
    // 模拟前端"点停止"：显式调停止端点（不依赖 socket 关闭语义）
    const r = await api('/api/chat/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: conv2.id }) });
    console.log('  已调用 /api/chat/stop → ' + JSON.stringify(r.json));
  });
  console.log('  客户端中断: ' + (stopRes.aborted ? '已 abort' : '没 abort（跑完了）')
    + '，收到事件 ' + stopRes.events.length + ' 个，耗时 ' + (Date.now() - t1) + 'ms');
  const runningAtAbort = stopRes.events.filter((e) => e.type === 'tool').length;
  console.log('  abort 前已发出 ' + runningAtAbort + ' 个步骤事件（三个代码 Agent 应该都已开跑）');
  // 立刻看一次（模拟界面在 abort 瞬间的状态），再等 4 秒看最终状态
  const gensNow = (await api('/api/generations')).json;
  console.log('  abort 后立刻: /api/generations.active = ' + JSON.stringify(gensNow && gensNow.active) + '（此刻服务端可能还在收尾，正常）');
  await new Promise((r) => setTimeout(r, 4000));
  const gens = (await api('/api/generations')).json;
  const convNow = (await api('/api/conversations/' + conv2.id)).json;
  const last = convNow.messages[convNow.messages.length - 1];
  const list = (await api('/api/conversations')).json.conversations.find((c) => c.id === conv2.id);
  const tools = (last && last.tools) || [];
  const stillRunning = tools.filter((c) => c.state === 'running');
  console.log('  4 秒后 /api/generations.active: ' + JSON.stringify(gens && gens.active));
  console.log('  列表项 active 标记: ' + (list ? list.active : '(没找到)'));
  console.log('  最后一条消息: status=' + (last && last.status) + ' content=' + ((last && last.content || '').length) + ' 字'
    + ' tools=' + tools.length + ' 条（其中仍标 running: ' + stillRunning.length + ' 条）');
  if (stillRunning.length) console.log('    残留: ' + stillRunning.map((c) => c.name + '·' + c.label).join(', '));
  const okA = (gens.active || []).indexOf(conv2.id) < 0;
  const okB = list && list.active === false;
  const okC = last && (last.status === 'stopped' || last.status === 'error');
  const okD = stillRunning.length === 0;
  console.log('  判定: active 已清 ' + (okA ? '✅' : '❌') + ' · 列表标记 false ' + (okB ? '✅' : '❌')
    + ' · 消息已收尾 ' + (okC ? '✅' : '❌') + ' · 无残留转圈 chip ' + (okD ? '✅' : '❌'));
  process.exit(okA && okB && okC && okD ? 0 : 1);
})().catch((e) => { console.error('探针异常: ' + (e && e.stack || e)); process.exit(1); });
