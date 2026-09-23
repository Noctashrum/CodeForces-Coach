'use strict';
/**
 * probe-health.js — 最近几轮的"体检表"：成本、失败路径、正文/文档有没有漏标记
 * 用法：node .probe/probe-health.js [数据目录] [轮数]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const N = parseInt(process.argv[3] || '5', 10);
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const dir = path.join(DATA, 'conversations');
const convs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => rd(path.join(dir, f))).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, N);

convs.forEach((c) => {
  const key = (c.cfProblem && c.cfProblem.contestId)
    ? 'cf-' + c.cfProblem.contestId + String(c.cfProblem.index).toUpperCase() : c.id;
  const meta = rd(path.join(DATA, 'workspace', key, 'meta.json')) || {};
  const a = c.messages.filter((m) => m.role === 'assistant').pop() || {};
  const body = String(a.content || '');
  const doc = String(a.richDoc || '');
  const u = a.usage || {};
  const v = meta.verification || {};
  const trace = meta.trace || [];
  const byRole = {};
  trace.forEach((t) => { byRole[t.role] = (byRole[t.role] || 0) + 1; });
  const samples = (c.cfProblemSamples || []).length;
  const counts = (s, re) => (s.match(re) || []).length;
  console.log('==================================================');
  console.log(new Date(c.updatedAt || 0).toLocaleString() + ' · ' + key + ' · ' + (c.cfProblem ? 'CF' : '粘贴')
    + ' · 官方样例 ' + samples + ' 组');
  console.log('  调用 ' + (u.calls || trace.length) + ' 次（' + Object.keys(byRole).map((r) => r + '×' + byRole[r]).join(' ') + '）'
    + ' · 输出 ' + (u.completionTokens || 0) + ' tok · 墙钟 ' + (v.wallMs ? Math.round(v.wallMs / 1000) + 's' : '?')
    + ' · 费用 ' + (u.cost ? '¥' + u.cost.amount : '—'));
  console.log('  验证 ' + v.status + ' · 对拍 ' + v.iterations + ' 组 · 题解重写 ' + v.solRewrites
    + ' · 标尺冻结 ' + v.bruteFrozen + (v.solSamplesPass === true ? ' · 题解过样例 ✓' : (v.solSamplesPass === false ? ' · ⚠️题解没过样例' : ''))
    + (v.emptyRetries ? ' · 空回复重试 ' + v.emptyRetries : ''));
  console.log('  正文 ' + body.length + ' 字（HTML标签 ' + counts(body, /<[a-z/][^>]*>/gi) + ' · 围栏 ' + counts(body, /```/g)
    + ' · 转义实体 ' + counts(body, /&lt;|&gt;/g) + '）'
    + ' · 文档 ' + doc.length + ' 字（svg ' + counts(doc, /<svg/gi) + ' figure ' + counts(doc, /<figure/gi)
    + ' · LaTeX残渣 ' + (counts(doc, /\$[^$\n]{2,}\$/g) + counts(doc, /\\[a-zA-Z]{2,}/g)) + '）');
  const bad = [];
  if (counts(body, /<[a-z/][^>]*>/gi) > 2 || counts(body, /```/g) > 0 || counts(body, /&lt;|&gt;/g) > 0) bad.push('正文有标记泄漏');
  if (doc && (counts(doc, /\$[^$\n]{2,}\$/g) + counts(doc, /\\[a-zA-Z]{2,}/g)) > 0) bad.push('文档残留 LaTeX');
  if (v.status !== 'ok') bad.push('验证未通过：' + String(v.reason || '').slice(0, 60));
  console.log('  体检: ' + (bad.length ? '⚠️ ' + bad.join('；') : '✅ 干净'));
  const kinds = (meta.trajectory || []).map((t) => t.kind);
  if (kinds.length) console.log('  轨迹: ' + kinds.join(' → '));
});
