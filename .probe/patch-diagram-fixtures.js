/**
 * 一次性夹具修补脚本：把 test-harness.js 里那些"只画了 text/rect"的 svg 夹具补上连线。
 *
 * 背景：richdoc 现在要求图解必须含 path/line/polyline/polygon/ellipse 或 marker
 * （用户原话"他那个表格我认为是不算图的"）。这些夹具代表的是**真图解**，
 * 所以按新判据把它们补成真图解，而不是放宽判据。
 *
 * 用法：node .probe/patch-diagram-fixtures.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'scripts', 'test-harness.js');
let s = fs.readFileSync(file, 'utf8');
let n = 0;

const patches = [
  ['<svg viewBox="0 0 200 60"><text', '<svg viewBox="0 0 200 60"><line x1="10" y1="30" x2="190" y2="30"/><text'],
  ['<svg viewBox="0 0 760 300"><text', '<svg viewBox="0 0 760 300"><line x1="10" y1="40" x2="700" y2="40"/><text'],
  ['<svg viewBox="0 0 600 200"><text', '<svg viewBox="0 0 600 200"><line x1="10" y1="40" x2="560" y2="40"/><text'],
  ['<svg viewBox="0 0 760 240"><text', '<svg viewBox="0 0 760 240"><line x1="10" y1="40" x2="700" y2="40"/><text'],
  ['<svg viewBox="0 0 500 200"><text', '<svg viewBox="0 0 500 200"><line x1="10" y1="60" x2="480" y2="60"/><text']
];

for (const [from, to] of patches) {
  while (s.indexOf(from) >= 0) { s = s.replace(from, to); n++; }
}
fs.writeFileSync(file, s);
console.log('补了 ' + n + ' 处连线');
