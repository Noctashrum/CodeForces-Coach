/**
 * probe-render.js — 用 Electron 真实渲染一段 Markdown，检查"编码/渲染"是否漏原始标记。
 * 用法：node_modules\electron\dist\electron.exe .probe\probe-render.js <markdown文件>
 * 输出：PROBE_JSON {...}（含渲染后 HTML、可见文本、残留标记数等）
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const mdFile = process.argv[2] || path.join(__dirname, '..', '.last-answer.md');
const rich = process.argv.includes('--rich');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'render.html'));
  await new Promise((r) => setTimeout(r, 800));
  const markdown = fs.readFileSync(mdFile, 'utf8');
  const res = await win.webContents.executeJavaScript(
    'window.__renderProbe(' + JSON.stringify(markdown) + ', ' + JSON.stringify({ allowHtml: rich }) + ')'
  );
  console.log('PROBE_JSON ' + JSON.stringify({
    file: mdFile, rich: rich, leakedTags: res.leakedTags, codeBlocks: res.codeBlocks,
    plainPre: res.plainPre, vizNodes: res.vizNodes, escapedAngle: res.escapedAngle
  }));
  // 把渲染后的 HTML 落盘，便于人工/后续 diff
  fs.writeFileSync(path.join(__dirname, 'rendered.html'), res.html, 'utf8');
  // 泄漏的标记片段（前后文），直接看是什么漏出来了
  const m = res.visibleText.match(/[\s\S]{0,80}<viz-[a-z]+[\s\S]{0,120}/);
  if (m) console.log('PROBE_LEAK ' + JSON.stringify(m[0]));
  app.exit(0);
}).catch((e) => { console.error('PROBE_ERR ' + (e && e.message)); app.exit(1); });
