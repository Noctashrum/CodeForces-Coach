/**
 * cf-parse-check.js — 诊断脚本：用真实页面 HTML 检查题面解析结果
 * 用法：node scripts/cf-parse-check.js .cf-dump/xxx.html [--full]
 */
'use strict';

const fs = require('fs');
const cf = require('../lib/cf.js');

const file = process.argv[2];
const full = process.argv.includes('--full');
if (!file) {
  console.error('用法: node scripts/cf-parse-check.js <html 文件> [--full]');
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');
console.log('文件: ' + file + '（' + html.length + ' 字节）');

const p = cf.parseProblemPage(html, 2264, 'D');
console.log('title       : ' + p.title);
console.log('timeLimit   : ' + p.timeLimit);
console.log('memoryLimit : ' + p.memoryLimit);
console.log('statement   : ' + p.statement.length + ' 字符');
console.log('samples     : ' + p.samples.filter((s) => s.input != null).length + ' 组，note ' + p.samples.filter((s) => s.note).length + ' 条');
console.log('---- statement 前 400 字 ----');
console.log(p.statement.slice(0, 400));
console.log('---- statement 后 400 字 ----');
console.log(p.statement.slice(-400));
p.samples.forEach((s, i) => {
  if (s.note) console.log('note[' + i + ']: ' + s.note.slice(0, 120));
  else console.log('sample[' + i + '] in=' + JSON.stringify((s.input || '').slice(0, 40)) + ' out=' + JSON.stringify((s.output || '').slice(0, 40)));
});
if (full) {
  console.log('---- 完整 statement ----');
  console.log(p.statement);
}
