/**
 * probe-cf-profile.js — 逐个配置试"应用内窗口能不能拿到 CF 页面"。
 *
 * 背景（用户实测反馈）：**用户的浏览器打开 CF 完全正常，但应用内窗口频繁要过挑战、题解全超时**。
 * 这说明问题不在网络、也不在解析，而在抓取窗口的配置"不像一个真实浏览器窗口"。
 * 本脚本用同一台机器、同一个网络，只改配置，逐个跑一次真实抓取，用结果说话。
 *
 * 用法（一次一个配置，避免互相污染 cookie）：
 *   node scripts/probe-cf-profile.js baseline     # 现状：离屏 + images:false + 伪造 UA
 *   node scripts/probe-cf-profile.js noimg        # 只加：加载图片
 *   node scripts/probe-cf-profile.js onscreen     # 加载图片 + 窗口在屏内
 *   node scripts/probe-cf-profile.js full         # 以上全部 + 不伪造 UA + 关闭遮挡节流
 *
 * 输出：每个 URL 的 HTTP 落地、是否有挑战标题、题解正文长度。
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const profile = process.argv[2] || 'baseline';
const ROOT = path.join(__dirname, '..');

// 用 Electron 跑一段内联脚本：启动隐藏的"主窗口"是不必要的，这里只要抓取窗口
const SCRIPT = `
const { app, BrowserWindow, session, screen } = require('electron');
const path = require('path');
const profile = process.env.CFCOACH_CF_PROFILE || 'baseline';
const ROOT = ${JSON.stringify(ROOT)};

try {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} catch (e) {}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const useImages = profile !== 'baseline';
const spoofUA = !(profile === 'full' || profile === 'realua');
const onScreen = (profile === 'onscreen' || profile === 'full' || profile === 'realua');

const URLS = [
  'https://codeforces.com/blog/entry/157126',
  'https://codeforces.com/contest/1567/problem/C'
];

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: 1280, height: 900,
    x: onScreen ? wa.x + 40 : -12000,
    y: onScreen ? wa.y + 40 : -12000,
    show: onScreen,
    title: 'CF probe',
    webPreferences: {
      partition: 'persist:cfcoach-probe-' + profile,   // 每个配置独立分区，互不污染
      sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true,
      images: useImages,
      backgroundThrottling: false,
      ...(spoofUA ? { userAgent: CHROME_UA } : {})
    }
  });
  if (spoofUA) {
    try {
      win.webContents.setUserAgent(CHROME_UA);
      win.webContents.session.setUserAgent(CHROME_UA, 'zh-CN,zh;q=0.9');
    } catch (e) {}
  }
  const realUA = await win.webContents.executeJavaScript('navigator.userAgent').catch(() => '?');
  console.log('PROFILE ' + profile + ' | images=' + useImages + ' spoofUA=' + spoofUA + ' onScreen=' + onScreen);
  console.log('REAL_UA ' + realUA);

  for (const url of URLS) {
    const t0 = Date.now();
    try { await win.loadURL(url); } catch (e) { console.log('  loadURL 中断: ' + e.message); }
    let landed = '', title = '', bodyLen = 0, challenge = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1000));
      landed = win.webContents.getURL();
      const st = await win.webContents.executeJavaScript(
        '({t: document.title, len: (document.body ? document.body.innerText.length : 0), topic: !!document.querySelector(".topic"), stmt: !!document.querySelector(".problem-statement")})'
      ).catch(() => null);
      if (!st) continue;
      title = st.t; bodyLen = st.len;
      challenge = /just a moment|attention required|checking your browser|请稍候/i.test(title);
      if (!challenge && (st.topic || st.stmt)) break;
    }
    console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] ' + url);
    console.log('       落地: ' + landed);
    console.log('       标题: ' + title + ' | 挑战页: ' + challenge + ' | 正文长度: ' + bodyLen);
  }
  app.exit(0);
});
`;

const child = spawn(process.execPath, ['-e', SCRIPT], { windowsHide: true,
  cwd: ROOT,
  env: Object.assign({}, process.env, { CFCOACH_CF_PROFILE: profile, ELECTRON_RUN_AS_NODE: '' }),
  stdio: 'inherit'
});
child.on('exit', (code) => process.exit(code === null ? 1 : code));
