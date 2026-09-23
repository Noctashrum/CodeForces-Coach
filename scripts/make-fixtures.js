/**
 * make-fixtures.js — 从抓取到的真实页面中裁出解析器回归夹具（只保留解析所需结构）
 * 用法：node scripts/make-fixtures.js
 * 输入：.cf-dump/*.html（由 node scripts/cf-dump.js 抓取）
 * 输出：scripts/fixtures/cf-2264D-raw.html（CF 原始标记）
 *       scripts/fixtures/cf-2264D-dom.html（MathJax 渲染后的 DOM —— 历史 bug 现场）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dumpDir = path.join(ROOT, '.cf-dump');
const fixDir = path.join(ROOT, 'scripts', 'fixtures');
fs.mkdirSync(fixDir, { recursive: true });

/** 只保留 <div class="problem-statement"> 起到样例/注释结束的结构 */
function trim(html) {
  const at = html.indexOf('<div class="problem-statement');
  if (at < 0) throw new Error('找不到 problem-statement');
  // 结束点：样例区域（含 note）之后
  const noteAt = html.indexOf('<div class="note"', at);
  let end = html.length;
  if (noteAt > 0) {
    let i = noteAt;
    let depth = 0;
    for (;;) {
      const openAt = html.indexOf('<div', i);
      const closeAt = html.indexOf('</div>', i);
      if (closeAt < 0) break;
      if (openAt >= 0 && openAt < closeAt) { depth++; i = openAt + 4; }
      else { depth--; i = closeAt + 6; if (depth === 0) { end = i; break; } }
    }
  }
  return '<!DOCTYPE html><html><head><title>Problem - 2264D - Codeforces</title></head><body>'
    + html.slice(at, end + 6) + '</body></html>';
}

const jobs = [
  { src: 'https_codeforces_com_problemset_problem_2264_D.html', out: 'cf-2264D-dom.html', force: true }
];

// 原始 HTML：优先用已保存的 raw 夹具（cf-dump 会随 FORCE_DOM 覆盖 dump 目录内容）
for (const j of jobs) {
  const src = path.join(dumpDir, j.src);
  if (!fs.existsSync(src)) { console.log('跳过（缺少 ' + src + '）'); continue; }
  const out = trim(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(path.join(fixDir, j.out), out);
  console.log(j.out + '  ' + out.length + ' 字节');
}
