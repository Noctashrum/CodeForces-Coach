'use strict';
/**
 * probe-cf-cache.js — 验证"取题失败时用缓存官方样例兜底"（真实事故：明明有缓存样例，整轮却按"没有 ground truth"跑）
 *
 * 做法：mock-llm 正常起，但把 CF_BASE 指到一个**没人监听的端口**（取题必失败）；
 * 会话里预置好 cfProblem=1800C + 缓存样例；发一条带题面的消息。
 * 期望：步骤里出现"复用本题缓存的官方样例"，而且走的是**样例校准**（不是手算锚点）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3221;
const LLM_PORT = 3999;
const DEAD_CF_PORT = 3997;   // 故意不监听 → fetchProblem 必失败
const DATA = path.join(ROOT, '.test-data', 'probe-cfcache');
const BASE = 'http://127.0.0.1:' + PORT;
const CONV_ID = 'c_cfcache';

const STATEMENT = [
  '【Codeforces 1800C】C. Powering the Hero (hard version) 难度：1800 分',
  '题意：牌堆里依次给出 n 张牌，遇到 0 可以取走此前未被取走的最大正数牌，求能取得的最大总和。',
  '',
  '输入格式',
  '第一行 t（1 ≤ t ≤ 10）。每个测试用例第一行 n（1 ≤ n ≤ 2·10^5），第二行 n 个整数。',
  '',
  '输出格式',
  '每个测试用例输出一行整数。'
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  fs.mkdirSync(path.join(DATA, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{ id: 'mock-p', name: 'Mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1', apiKey: 'k', extraHeaders: {}, models: ['mock-gpt-4'], stream: true }],
    defaultProviderId: 'mock-p', defaultModel: 'mock-gpt-4', defaultCoachLang: 'python'
  }, null, 2), 'utf8');
  // 预置会话：题目 1800C + 缓存官方样例（就是 mock-cf 里那组）
  const now = Date.now();
  fs.writeFileSync(path.join(DATA, 'conversations', CONV_ID + '.json'), JSON.stringify({
    id: CONV_ID, title: '缓存样例兜底', providerId: 'mock-p', model: 'mock-gpt-4', systemPrompt: '',
    params: { temperature: null, topP: null, maxTokens: null }, mode: 'coach', lang: 'python', intent: 'full',
    cfProblem: { contestId: 1800, index: 'C', title: 'C. Powering the Hero (hard version)' },
    cfProblemSamples: [{ input: '2\n3\n3 3 0\n2\n5 0', output: '3\n5' }],
    problemMeta: { rating: 1800, source: 'cf', contest: '1800' },
    createdAt: now, updatedAt: now, archived: false, pinned: false,
    messages: [{ id: 'm_u1', role: 'user', content: STATEMENT, createdAt: now }]
  }, null, 2), 'utf8');

  start([path.join(ROOT, 'scripts', 'mock-llm.js')], { PORT: String(LLM_PORT) });
  start([path.join(ROOT, 'server.js')], {
    PORT: String(PORT), CF_BASE: 'http://127.0.0.1:' + DEAD_CF_PORT, CHATBOX_DATA_DIR: DATA
  });
  const end = Date.now() + 15000;
  let up = false;
  while (Date.now() < end && !up) {
    try { up = (await fetch(BASE + '/api/info')).ok; } catch (e) { await sleep(250); }
  }
  if (!up) { console.error('server 没起来'); stopAll(); process.exit(1); }

  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: CONV_ID, mode: 'send', userContent: 'CF 1800C 讲解一下' })
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const chips = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.indexOf('data:') === 0);
      if (!line) continue;
      let ev = null; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (ev.type === 'toolResult') (ev.results || []).forEach((x) => chips.push(x.name + ' :: ' + (x.ok === false ? '✗ ' : '✓ ') + x.summary));
    }
  }
  const conv = (await api('/api/conversations/' + CONV_ID)).json;
  const v = (conv.messages.slice(-1)[0] || {}).verification || {};
  console.log('---- 步骤 ----');
  chips.filter((c) => /cf_fetch|contract|samples|witness|stress/.test(c)).forEach((c) => console.log('  · ' + c));
  console.log('---- 验证结论 ----');
  console.log('  status=' + v.status + ' samples=' + v.samples + ' source=' + v.samplesSource + ' 对拍=' + v.iterations);
  // 判据：① 用了缓存样例；② 走的是**官方样例校准**（而不是"没有 ground truth"那条路）；
  // ③ 没有"没有可用的官方样例"这类告警。（样例只有 1 组时仍会做手算体检——那是有意为之，不算退化。）
  const ok = chips.some((c) => /复用本题缓存的官方样例/.test(c))
    && chips.some((c) => /暴力解官方样例全过/.test(c))
    && !chips.some((c) => /没有可用的官方样例/.test(c));
  console.log('判定: ' + (ok ? '✅ 取题失败时用缓存官方样例兜底（走官方样例校准，没有退化成"没有 ground truth"）'
    : '❌ 仍然退化成了"没有 ground truth"'));
  stopAll();
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('探针异常: ' + ((e && e.stack) || e)); stopAll(); process.exit(1); });
