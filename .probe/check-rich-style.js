/**
 * check-rich-style.js — 确认图文文档**真的带了设计系统**。
 *
 * 背景：cf_doc 原来调 `richdoc.wrap(body)` 时不传 css/js，文档于是用浏览器默认样式渲染
 * （纯黑字 + 深色底 → 看不清，真实反馈）。这个探针就是那条回归的看门人。
 *
 * 用法：node .probe/check-rich-style.js
 */
'use strict';
const richdoc = require('../lib/richdoc');

const css = richdoc.designCss();
const js = richdoc.designJs();
console.log('rich.css: ' + css.length + ' 字节｜rich.js: ' + js.length + ' 字节');

const doc = richdoc.wrap('<div class="wrap"><section class="chapter"><h2>1</h2></section></div>',
  { theme: 'dark', css, js });

const checks = [
  ['带上了颜色变量（--bg / --text）', /--bg\s*:/.test(doc) && /--text\s*:/.test(doc)],
  ['带上了 body 基础样式', /body\s*\{/.test(doc)],
  ['主题标记为 dark', /data-theme="dark"/.test(doc)],
  ['CSP 仍然禁止外链', /Content-Security-Policy/.test(doc) && /default-src 'none'/.test(doc)]
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
  if (!ok) bad++;
}
console.log(bad ? '有 ' + bad + ' 项不达标' : '全部通过');
process.exit(bad ? 1 : 0);
