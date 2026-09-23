'use strict';
/**
 * probe-last-round.js — 只读分析：把最近几轮对话的"工作流证据"摊开看
 * 用法：node .probe/probe-last-round.js [数据目录] [条数]
 * 默认读打包版的真实数据目录 dist/CFCoach-win32-x64/data（只读，不写任何东西）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const N = parseInt(process.argv[3] || '6', 10);
const CONV_DIR = path.join(DATA, 'conversations');
const WS_DIR = path.join(DATA, 'workspace');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function listConvs() {
  const out = [];
  const dirs = [CONV_DIR, path.join(DATA, 'archive')];
  dirs.forEach((d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).filter((f) => f.endsWith('.json')).forEach((f) => {
      const j = readJson(path.join(d, f));
      if (j) out.push(j);
    });
  });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function wsKeyOf(conv) {
  const p = conv.cfProblem;
  if (p && p.contestId && p.index) return 'cf-' + p.contestId + String(p.index).toUpperCase();
  return conv.id;
}

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
  return String(c || '');
}

const convs = listConvs().slice(0, N);
console.log('数据目录: ' + DATA);
console.log('最近 ' + convs.length + ' 轮：\n');

convs.forEach((c) => {
  const key = wsKeyOf(c);
  const wsDir = path.join(WS_DIR, key);
  const meta = readJson(path.join(wsDir, 'meta.json'));
  const files = fs.existsSync(wsDir) ? fs.readdirSync(wsDir) : [];
  const lastA = c.messages.slice().reverse().find((m) => m.role === 'assistant');
  const firstU = c.messages.find((m) => m.role === 'user');
  const uText = textOf(firstU && firstU.content).replace(/\s+/g, ' ').slice(0, 90);
  console.log('======================================================');
  console.log('会话 ' + c.id + ' · ' + new Date(c.updatedAt || 0).toLocaleString());
  console.log('  标题: ' + c.title + ' · 题目: ' + (c.cfProblem ? (c.cfProblem.contestId + c.cfProblem.index + ' ' + (c.cfProblem.title || '')) : '(无 CF 题号，粘贴题面?)'));
  console.log('  工作区键: ' + key + ' · 文件: ' + files.join(', '));
  console.log('  首条用户消息: ' + uText);
  if (lastA) {
    console.log('  最后一条回答: status=' + lastA.status + ' 正文=' + textOf(lastA.content).length
      + ' 字 richDoc=' + String(lastA.richDoc || '').length + ' 字');
    const tools = (lastA.tools || []).map((t) => t.name + '(' + t.state + (t.ok === false ? '✗' : '') + ')');
    console.log('  步骤 chip: ' + tools.join(' '));
    const failed = (lastA.tools || []).filter((t) => t.ok === false).map((t) => t.name + '：' + String(t.summary || '').slice(0, 120));
    if (failed.length) { console.log('  失败步骤:'); failed.forEach((f) => console.log('    · ' + f)); }
  }
  if (meta) {
    const v = meta.verification || {};
    console.log('  验证: status=' + v.status + ' iterations=' + v.iterations + ' bruteFrozen=' + v.bruteFrozen
      + ' solRewrites=' + v.solRewrites + ' samples=' + v.samples + ' samplesSource=' + (v.samplesSource || '-')
      + ' agentCalls=' + v.agentCalls);
    if (v.reason) console.log('  验证原因: ' + String(v.reason).slice(0, 200));
    const kinds = {};
    (meta.trajectory || []).forEach((t) => { kinds[t.kind] = (kinds[t.kind] || 0) + 1; });
    console.log('  轨迹类型: ' + JSON.stringify(kinds));
    (meta.trajectory || []).filter((t) => /fail|mismatch|retry|regen|anticheat|error|sanitiz|rescue|hand/.test(t.kind))
      .slice(-8).forEach((t) => console.log('    · [' + t.kind + '] ' + String(t.note || '').slice(0, 160)));
    if (meta.minimalCase && meta.minimalCase.input) {
      console.log('  最小反例(from=' + (meta.minimalCase.from || '?') + '): ' + JSON.stringify(meta.minimalCase.input).slice(0, 120));
    }
  } else {
    console.log('  （没有工作区 meta.json）');
  }
});
