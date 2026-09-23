'use strict';
/** probe-doc-tex.js — 打印最新一轮文档里**没被翻译掉**的 LaTeX 残渣（附上下文） */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const IDX = parseInt(process.argv[3] || '0', 10);
const dir = path.join(DATA, 'conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, t: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).updatedAt || 0 }))
  .sort((a, b) => b.t - a.t);
const c = JSON.parse(fs.readFileSync(path.join(dir, files[IDX].f), 'utf8'));
const a = c.messages.filter((m) => m.role === 'assistant').pop() || {};
const doc = String(a.richDoc || '');
console.log('会话 ' + c.id + ' · 文档 ' + doc.length + ' 字');
const hits = [];
(doc.match(/\$[^$\n]{2,300}\$/g) || []).forEach((m) => hits.push(['内联 $…$', m]));
(doc.match(/\\[a-zA-Z]{2,}/g) || []).forEach((m) => hits.push(['命令', m]));
console.log('残留 ' + hits.length + ' 处：');
const seen = {};
hits.forEach(([kind, text]) => {
  const k = kind + ':' + text.slice(0, 40);
  seen[k] = (seen[k] || 0) + 1;
});
Object.keys(seen).slice(0, 20).forEach((k) => {
  const sample = k.slice(k.indexOf(':') + 1);
  const i = doc.indexOf(sample);
  console.log('  [' + k.split(':')[0] + '] ×' + seen[k] + ' ' + JSON.stringify(sample)
    + '\n      上下文: ' + JSON.stringify(doc.slice(Math.max(0, i - 90), i + 90)));
});
