/**
 * check-soft-rescue.js — 直接验证夹具文档能否通过 richdoc 校验。
 *
 * 用途：改了"什么算图解"的判定、或改了 mock 夹具里的 SVG 之后，
 * 先跑这个看看到底是哪条规则把文档拒了（比跑完整 e2e 快几十倍）。
 * 用法：node .probe/check-soft-rescue.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const richdoc = require('../lib/richdoc');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mock-llm.js'), 'utf8');

/** 从 mock-llm.js 里把某个夹具函数的字符串数组拼回来 */
function fixtureOf(fnName, nextFnName) {
  const i = src.indexOf('function ' + fnName);
  const j = nextFnName ? src.indexOf('function ' + nextFnName) : src.length;
  const body = src.slice(i, j);
  const lines = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) lines.push(m[1].replace(/\\'/g, "'"));
  return lines.join('\n');
}

// ① 末尾少 </div> 的那份（宽容计数 + 机械补齐）
const soft = fixtureOf('MOCK_RICH_DOC_SOFT', 'MOCK_RICH_DOC(');
const v1 = richdoc.validate(soft);
console.log('MOCK_RICH_DOC_SOFT（' + soft.length + ' 字符）ok=' + v1.ok + ' errors=' + JSON.stringify(v1.errors));
const s = richdoc.sanitize(soft);
console.log('  sanitize changes = ' + JSON.stringify(s.changes));
const v2 = richdoc.validate(s.html);
console.log('  净化后 ok=' + v2.ok + ' errors=' + JSON.stringify(v2.errors));
const svgs = soft.match(/<svg[\s\S]*?<\/svg>/gi) || [];
console.log('  svg ' + svgs.length + ' 张，其中带连线/箭头的 '
  + svgs.filter((x) => /<(path|line|polyline|polygon|ellipse)\b|<marker\b/i.test(x)).length + ' 张');

// ② 标准富讲解文档
const rich = fixtureOf('MOCK_RICH_DOC', 'MOCK_BAD_DOC');
const v3 = richdoc.validate(rich);
console.log('MOCK_RICH_DOC（' + rich.length + ' 字符）ok=' + v3.ok + ' errors=' + JSON.stringify(v3.errors));

// ③ 反面用例：把表格画成 SVG（只有 rect + text）应当**不算图**
const fake = '<div class="wrap"><div class="hero"><h1>t</h1></div>'
  + '<section class="chapter"><h2><span class="num">1</span>思路</h2>'
  + '<svg viewBox="0 0 600 200"><rect x="10" y="10" width="100" height="30"/><text x="20" y="30">表格</text>'
  + '<rect x="10" y="50" width="100" height="30"/><text x="20" y="70">a</text></svg>'
  + '<p>' + '文字'.repeat(200) + '</p></section></div>';
const v4 = richdoc.validate(fake);
console.log('表格型 SVG（只有 rect+text）ok=' + v4.ok + '（应当 false）errors=' + JSON.stringify(v4.errors.slice(0, 1)));
