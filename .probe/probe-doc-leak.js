'use strict';
/**
 * probe-doc-leak.js — 检查最新一轮的图文文档里有没有"没渲染出来的标记"（LaTeX / Markdown / viz 组件）
 * 用法：node .probe/probe-doc-leak.js [数据目录] [第几新]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const IDX = parseInt(process.argv[3] || '0', 10);
const dir = path.join(DATA, 'conversations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, t: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).updatedAt || 0 }))
  .sort((a, b) => b.t - a.t);
const conv = JSON.parse(fs.readFileSync(path.join(dir, files[IDX].f), 'utf8'));
const a = conv.messages.filter((m) => m.role === 'assistant').pop() || {};
const doc = a.richDoc || '';
const body = String(a.content || '');
console.log('会话 ' + conv.id + ' · ' + new Date(conv.updatedAt || 0).toLocaleString()
  + ' · 题目 ' + (conv.cfProblem ? conv.cfProblem.contestId + conv.cfProblem.index : '粘贴'));
console.log('正文 ' + body.length + ' 字 · 文档 ' + doc.length + ' 字');
console.log('---- 正文（前 300 字）----\n' + body.slice(0, 300));
const count = (s, re) => (s.match(re) || []).length;
const latexInline = doc.match(/\$[^$\n]{2,120}\$/g) || [];
const latexCmd = doc.match(/\\(texttt|text|le|ge|sum|cdot|times|log|bmod|left|right|frac|max|min|lfloor|rfloor|equiv|mathcal|mathrm)\b/g) || [];
const fences = count(doc, /```/g);
const viz = doc.match(/<viz-[a-z-]+/g) || [];
console.log('---- 文档里的"未渲染标记" ----');
console.log('  $...$ 内联公式: ' + latexInline.length);
console.log('  LaTeX 命令: ' + latexCmd.length + (latexCmd.length ? '（' + [...new Set(latexCmd)].slice(0, 8).join(' ') + '）' : ''));
console.log('  代码围栏 ```: ' + fences);
console.log('  <viz-* 组件: ' + viz.length + (viz.length ? '（' + [...new Set(viz)].slice(0, 5).join(' ') + '）' : ''));
if (latexInline.length) console.log('  公式样例: ' + JSON.stringify(latexInline.slice(0, 3)));
const near = doc.match(/[^<>]{0,80}\\[a-z]{2,}[^<>]{0,80}/);
if (near) console.log('  上下文: ' + JSON.stringify(near[0]).slice(0, 300));
// 文档里是否含 KaTeX 渲染痕迹 / 设计系统公式组件
console.log('---- 设计系统用法 ----');
console.log('  div.formula: ' + count(doc, /class="formula"/g) + ' · span.var: ' + count(doc, /class="var"/g)
  + ' · pre.code: ' + count(doc, /<pre class="code"/g) + ' · katex: ' + count(doc, /katex/g));
