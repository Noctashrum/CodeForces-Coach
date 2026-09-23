/**
 * probe-rich-frame.js — 富讲解**显示层**探针：把真实的 richDoc 放进真实 App 里渲染，量它到底有没有画出来。
 * 用法：node_modules\electron\dist\electron.exe .probe\probe-rich-frame.js <正文片段文件> [--no-lazy]
 *
 * 检查点：
 *  ① 消息里有没有 rich-host / iframe.rich-frame；
 *  ② iframe 有没有加载（子文档高度回报 = rich.js 真的跑起来了）；
 *  ③ **iframe 区域像素是否真的有内容**（背景全空 vs 画了图）—— 这是"生图"的最终判据；
 *  ④ 把 loading="lazy" 去掉再做一次对照（排除懒加载导致 iframe 一直不加载）。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const richdoc = require('../lib/richdoc.js');

const ROOT = path.join(__dirname, '..');
const fragFile = process.argv[2] || path.join(__dirname, 'richdoc-no-max-tokens.html');
const noLazy = process.argv.includes('--no-lazy');
const PORT = 3219;
const DATA = path.join(ROOT, '.test-data', 'rich-frame');
const CONV_ID = 'c_richframe';

let server = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 这个探针跑在 Electron 里：process.execPath 是 electron.exe，不能拿它去启动 server.js
const NODE = /electron/i.test(path.basename(process.execPath)) ? 'node' : process.execPath;

function writeFixture() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    version: 1, defaultProviderId: '', defaultModel: '', cfHandle: '', providers: []
  }, null, 2), 'utf8');
  const body = fs.readFileSync(fragFile, 'utf8');
  const html = richdoc.wrap(body, {
    theme: 'dark',
    css: fs.readFileSync(path.join(ROOT, 'public', 'rich', 'rich.css'), 'utf8'),
    js: fs.readFileSync(path.join(ROOT, 'public', 'rich', 'rich.js'), 'utf8'),
    title: '富讲解渲染探针'
  });
  const now = Date.now();
  const conv = {
    id: CONV_ID, title: '富讲解渲染探针', providerId: '', model: '', systemPrompt: '',
    params: { temperature: null, topP: null, maxTokens: null },
    mode: 'coach', lang: 'cpp', intent: 'full', rich: true,
    cfProblem: null, problemMeta: null, createdAt: now, updatedAt: now, archived: false, pinned: false,
    messages: [
      { id: 'm_u1', role: 'user', content: 'CF 1800C 用图文讲解一遍', createdAt: now },
      { id: 'm_a1', role: 'assistant', content: '（图文讲解已生成，见下方互动文档）', status: 'done', richDoc: html, createdAt: now + 1000 }
    ]
  };
  fs.writeFileSync(path.join(DATA, 'conversations', CONV_ID + '.json'), JSON.stringify(conv, null, 2), 'utf8');
  return { bytes: html.length };
}

async function startServer() {
  server = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
    env: Object.assign({}, process.env, { PORT: String(PORT), CHATBOX_DATA_DIR: DATA })
  });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { if ((await fetch('http://127.0.0.1:' + PORT + '/api/info')).ok) return true; } catch (e) { /* wait */ }
    await sleep(250);
  }
  return false;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const info = writeFixture();
  console.log('PROBE_FIXTURE ' + JSON.stringify(info));
  if (!await startServer()) { console.log('PROBE_ERR server 没起来'); app.exit(1); return; }
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { offscreen: true, contextIsolation: true }
  });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(500);
  await win.webContents.executeJavaScript(`(function () {
    window.__probeErrors = [];
    window.addEventListener('error', function (e) { window.__probeErrors.push(String(e.message)); });
    window.addEventListener('unhandledrejection', function (e) { window.__probeErrors.push('rejection: ' + String(e.reason)); });
    return true;
  })()`);
  await sleep(1200);
  await win.webContents.executeJavaScript(
    `(function () { localStorage.setItem('lastConvId', ${JSON.stringify(CONV_ID)}); location.reload(); return true; })()`);
  await sleep(2500);

  // 记录子文档的高度回报（rich.js 跑起来的证据）
  await win.webContents.executeJavaScript(`(function () {
    window.__richMsgs = [];
    window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.__richdoc) window.__richMsgs.push(ev.data);
    });
    return true;
  })()`);

  const measure = (tag) => win.webContents.executeJavaScript(`(function () {
    var host = document.querySelector('[data-rich-msg]');
    var f = document.querySelector('iframe.rich-frame');
    var r = f ? f.getBoundingClientRect() : null;
    var srcdoc = f ? String(f.getAttribute('srcdoc') || '') : '';
    return {
      tag: ${JSON.stringify(tag)},
      hostFound: !!host,
      iframeFound: !!f,
      loading: f ? f.getAttribute('loading') : null,
      styleHeight: f ? f.style.height : null,
      rect: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) } : null,
      srcdocLen: srcdoc.length,
      srcdocSvgs: (srcdoc.match(/<svg/gi) || []).length,
      richMsgs: (window.__richMsgs || []).length,
      lastHeight: (window.__richMsgs || []).length ? window.__richMsgs[window.__richMsgs.length - 1].height : null
    };
  })()`);

  const lazyState = await measure('initial(lazy)');
  console.log('PROBE_LAZY ' + JSON.stringify(lazyState));
  const diag = await win.webContents.executeJavaScript(`(function () {
    return {
      href: location.href,
      readyState: document.readyState,
      hasMD: !!window.MD,
      hasAgentRuns: !!window.AgentRuns,
      hasDesktop: !!window.desktop,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      chatViewFound: !!document.querySelector('#chat-view'),
      workbenchFound: !!document.querySelector('.workbench'),
      appScriptLoaded: Array.prototype.slice.call(document.scripts).map(function (s) { return s.getAttribute('src') || ('inline:' + s.textContent.length); }),
      lastConvId: localStorage.getItem('lastConvId'),
      title: (document.querySelector('#header-title') || {}).textContent || null,
      msgs: document.querySelectorAll('.msg').length,
      chatText: String(((document.querySelector('#chat-view') || {}).innerText) || '').slice(0, 200),
      errors: window.__probeErrors || [],
      bootHint: (function () {
        // boot() 里的异常会被 toast 吞掉：把 toast 文本也带出来
        var t = document.querySelector('#toast-root');
        return t ? String(t.innerText || '').slice(0, 200) : '';
      })(),
      apiProbe: null
    };
  })()`);
  console.log('PROBE_DIAG ' + JSON.stringify(diag));
  const apiDiag = await win.webContents.executeJavaScript(`(async function () {
    try {
      var r = await fetch('/api/conversations');
      var j = await r.json();
      var one = await fetch('/api/conversations/${CONV_ID}');
      var oj = await one.json();
      return { list: (j.conversations || []).map(function (c) { return c.id; }), oneStatus: one.status, msgs: (oj.messages || []).length, richLen: String((oj.messages && oj.messages[1] && oj.messages[1].richDoc) || '').length };
    } catch (e) { return { err: String(e && e.message) }; }
  })()`);
  console.log('PROBE_API ' + JSON.stringify(apiDiag));

  // 去掉 lazy 再测一次（对照）
  await win.webContents.executeJavaScript(`(function () {
    document.querySelectorAll('iframe.rich-frame').forEach(function (f) { f.removeAttribute('loading'); f.src = f.src; });
    return true;
  })()`);
  await sleep(2500);
  const eagerState = await measure('no-lazy');
  console.log('PROBE_EAGER ' + JSON.stringify(eagerState));

  // 像素判据：截取 iframe 区域，统计"非背景色"像素比例（画了图就会明显 > 0）
  const shot = await win.webContents.capturePage();
  const size = shot.getSize();
  const bmp = shot.toBitmap();      // BGRA
  const f = eagerState.rect || lazyState.rect;
  let nonBg = 0, total = 0;
  const colors = {};
  if (f) {
    const x0 = Math.max(0, Math.round(f.w * 0.02)), x1 = Math.round(f.w * 0.98);
    const y0 = 0, y1 = Math.min(f.h, 600);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = ((y * size.width) + x) * 4;
        if (i + 3 >= bmp.length) continue;
        const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
        total++;
        // 背景基准：应用深色底 (~#0f1523 / #131a2a)。偏离它就说明画了东西
        if (Math.abs(r - 15) + Math.abs(g - 21) + Math.abs(b - 35) > 40) nonBg++;
        const key = r + ',' + g + ',' + b;
        colors[key] = (colors[key] || 0) + 1;
      }
    }
  }
  const top = Object.keys(colors).sort((a, b) => colors[b] - colors[a]).slice(0, 5)
    .map((k) => k + '×' + colors[k]);
  console.log('PROBE_PIXELS ' + JSON.stringify({
    sampled: total, nonBg, ratio: total ? +(nonBg / total).toFixed(3) : 0, topColors: top,
    windowPx: size.width + 'x' + size.height, iframeRect: f
  }));

  const verdict = {
    iframe: eagerState.iframeFound,
    loaded: (eagerState.richMsgs > 0) || (lazyState.richMsgs > 0),
    painted: total > 0 && (nonBg / total) > 0.02,
    svgsInDoc: eagerState.srcdocSvgs
  };
  console.log('PROBE_VERDICT ' + JSON.stringify(verdict));
  try { server.kill(); } catch (e) { /* ignore */ }
  app.exit(0);
}).catch((e) => {
  console.log('PROBE_ERR ' + ((e && e.stack) || e));
  try { if (server) server.kill(); } catch (e2) { /* ignore */ }
  app.exit(1);
});
