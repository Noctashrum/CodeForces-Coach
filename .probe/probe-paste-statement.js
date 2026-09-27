/**
 * probe-paste-statement.js — 走"用户把题面粘进对话框"这条真实路径，看教练的工具链。
 *
 * 要守住的几件事：
 *   ① 题面已在会话里 → 不应该再 cf_fetch；
 *   ② 样例要当场机械登记（否则 cf_run / 对拍拿不到标尺）；
 *   ③ 完整讲解要产出图文文档。
 *
 * 用法：先起 mock-cf / mock-llm / server（CF_BASE 指向 mock），再
 *   E2E_BASE=http://127.0.0.1:3210 node .probe/probe-paste-statement.js
 */
'use strict';
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3210';

const STATEMENT = [
  '【Codeforces 1800C】C. Powering the Hero (hard version)',
  '时限：2 seconds · 内存：256 megabytes',
  '',
  'There are n cards in a deck. Each card has a positive number or 0. In one move you can take',
  'the top card of the deck: if it is positive you put it on the top of your stack of bonuses,',
  'and if it is 0 you take the maximum bonus from the stack and add it to your total score.',
  'The deck is processed from top to bottom; you may also skip taking cards.',
  '',
  '输入格式',
  'The first line contains a single integer t (1 <= t <= 10^4) — the number of test cases.',
  'Each test case starts with a line containing n (1 <= n <= 2*10^5), then a line with n integers.',
  'It is guaranteed that the sum of n over all test cases does not exceed 2*10^5.',
  '',
  '输出格式',
  'For each test case print a single integer — the maximum total score you can achieve.',
  '',
  '样例：',
  '输入 1：',
  '2',
  '3',
  '3 3 0',
  '输出 1：',
  '3'
].join('\n');

const j = (u, o) => fetch(BASE + u, o).then((r) => r.json());
const jp = (u, body, method) => j(u, {
  method: method || 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});

(async () => {
  // 配一个指向 mock 的服务商（否则这轮直接因为"没有模型"而空转）
  const mock = process.env.E2E_MOCK || 'http://127.0.0.1:3990/v1';
  const cfg = await j('/api/config');
  await jp('/api/config', Object.assign({}, cfg, {
    providers: [{ id: 'mock-p', name: 'Mock', type: 'openai', baseUrl: mock, apiKey: 'k', extraHeaders: {}, models: ['mock-gpt-4'] }],
    defaultProviderId: 'mock-p', defaultModel: 'mock-gpt-4', cfHandle: 'tester', defaultCoachLang: 'python'
  }));
  const conv = await jp('/api/conversations', {});
  await jp('/api/conversations/' + conv.id, { mode: 'coach', lang: 'python' });
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conv.id, mode: 'send', userContent: STATEMENT })
  });
  const text = await res.text();
  const names = [];
  for (const m of text.matchAll(/"name":"([a-z_]+)"/g)) names.push(m[1]);
  const chain = names.filter((n, i) => names.indexOf(n) === i);

  const after = await j('/api/conversations/' + conv.id);
  const last = (after.messages || [])[after.messages.length - 1] || {};
  console.log('工具链：' + chain.join(' → '));
  console.log('会话登记：题面 ' + String(after.statementText || '').length + ' 字｜样例 '
    + (after.cfProblemSamples || []).length + ' 组');
  console.log('交付：' + (last.richDoc ? ('图文文档 ' + last.richDoc.length + ' 字') : '（没有文档）'));
  console.log('判定：'
    + (chain.includes('cf_fetch') ? '✗ 仍然联网取题  ' : '✓ 没有重复取题  ')
    + ((after.cfProblemSamples || []).length ? '✓ 样例已登记  ' : '✗ 样例没登记  ')
    + (last.richDoc ? '✓ 有图文文档' : '✗ 没有图文文档'));
  await j('/api/conversations/' + conv.id, { method: 'DELETE' });
})().catch((e) => { console.error('探针失败：' + e.message); process.exit(1); });
