'use strict';
/**
 * probe-call-audit.js — 审计最近几轮"到底谁在反复跑、每次为什么跑"
 * 用法：node .probe/probe-call-audit.js [数据目录] [轮数]
 *
 * 打印：每个角色的调用次数与标签（修题解/重写暴力解/…）、每次调用的耗时、轨迹里的
 * 触发点（mismatch / 仲裁结论 / 体检结论 / run-error）、以及整轮墙钟与各阶段耗时。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const N = parseInt(process.argv[3] || '3', 10);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
function listConvs() {
  const out = [];
  [path.join(DATA, 'conversations'), path.join(DATA, 'archive')].forEach((d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).filter((f) => f.endsWith('.json')).forEach((f) => {
      const j = readJson(path.join(d, f));
      if (j) out.push(j);
    });
  });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
const textOf = (c) => (Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : String(c || ''));

listConvs().slice(0, N).forEach((conv) => {
  const key = (conv.cfProblem && conv.cfProblem.contestId)
    ? 'cf-' + conv.cfProblem.contestId + String(conv.cfProblem.index).toUpperCase() : conv.id;
  const meta = readJson(path.join(DATA, 'workspace', key, 'meta.json')) || {};
  const last = conv.messages.filter((m) => m.role === 'assistant').pop() || {};
  const firstU = conv.messages.find((m) => m.role === 'user') || {};
  console.log('============================================================');
  console.log('会话 ' + conv.id + ' · ' + new Date(conv.updatedAt || 0).toLocaleString() + ' · 工作区 ' + key);
  console.log('题目: ' + (conv.cfProblem ? (conv.cfProblem.contestId + conv.cfProblem.index + ' ' + (conv.cfProblem.title || '')) : '(粘贴题面)')
    + ' · 来源 ' + (conv.cfProblem ? 'CF' : '粘贴') + ' · 意图 ' + conv.intent);
  console.log('题面开头: ' + textOf(firstU.content).replace(/\s+/g, ' ').slice(0, 70));
  const u = last.usage || {};
  console.log('整轮用量: 调用 ' + u.calls + ' 次 · 输入 ' + u.promptTokens + ' · 输出 ' + u.completionTokens
    + (u.estimated ? '（估算）' : '') + ' · 消息状态 ' + last.status);

  // 每个角色的调用次数
  const trace = meta.trace || [];
  const byRole = {};
  trace.forEach((t) => {
    const r = t.role || '?';
    byRole[r] = byRole[r] || { n: 0, ms: 0, labels: [] };
    byRole[r].n++;
    byRole[r].ms += t.ms || 0;
    byRole[r].labels.push((t.label || '') + '(' + Math.round((t.ms || 0) / 1000) + 's' + (t.ok === false ? '✗' : '') + ')');
  });
  console.log('实际调用（按角色，来自 trace）:');
  Object.keys(byRole).forEach((r) => {
    console.log('  ' + r.padEnd(10) + ' ' + String(byRole[r].n).padStart(2) + ' 次 · 合计 ' + Math.round(byRole[r].ms / 1000) + 's');
    console.log('      ' + byRole[r].labels.join('  '));
  });
  // 触发点
  const tj = meta.trajectory || [];
  console.log('轨迹（触发点）:');
  tj.forEach((t) => {
    const note = String(t.note || '').replace(/\s+/g, ' ').slice(0, 150);
    console.log('  · ' + t.kind + (note ? '：' + note : ''));
  });
  const v = meta.verification || {};
  console.log('验证结论: ' + v.status + ' · 原因 ' + String(v.reason || '').slice(0, 120)
    + ' · 对拍 ' + v.iterations + ' 组 · solRewrites ' + v.solRewrites + ' · bruteFrozen ' + v.bruteFrozen);
  if (meta.minimalCase && meta.minimalCase.input) {
    console.log('反例(from=' + meta.minimalCase.from + '): expected=' + JSON.stringify(String(meta.minimalCase.expected || '').slice(0, 40))
      + ' actual=' + JSON.stringify(String(meta.minimalCase.actual || '').slice(0, 40)));
  }
});
