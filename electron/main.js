/**
 * electron/main.js — ChatBox 桌面应用主进程
 * 特性：
 *  - 内嵌本地服务（复用 server.js，随机空闲端口，仅 127.0.0.1）
 *  - 单实例锁；原生菜单（Ctrl+N 新建对话等）；系统托盘（关闭即最小化到托盘）
 *  - 窗口大小/位置记忆；外链用系统浏览器打开；页面导航锁定本机
 *  - CHATBOX_SMOKE=1 时启动自检：校验页面 DOM + 截图 smoke.png 后自动退出
 */
'use strict';

const { app, BrowserWindow, Menu, shell, Tray, nativeImage, ipcMain, dialog, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * stdout/stderr 管道断开防护（EPIPE）。
 * 打包版从资源管理器启动、或被外部程序（测试脚本/终端）拉起后父进程退出时，
 * 主进程里的 console.log 会抛 EPIPE，未捕获就会弹「A JavaScript error occurred in the
 * main process」崩溃框（实际只是打日志失败）。这里统一吞掉写入类错误。
 */
function guardStdio() {
  const ignore = (err) => {
    const code = err && (err.code || err.errno);
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET' || code === 'EINVAL') return true;
    return false;
  };
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') stream.on('error', (e) => { if (!ignore(e)) return; });
  }
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args) => { try { origLog(...args); } catch (e) { /* 管道已断开，忽略 */ } };
  console.error = (...args) => { try { origErr(...args); } catch (e) { /* 同上 */ } };
}
guardStdio();

process.on('uncaughtException', (err) => {
  const code = err && (err.code || err.errno);
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;   // 打日志失败不该弹崩溃框
  try {
    console.error('[main] 未捕获异常: ' + (err && err.stack || err));
    dialog.showErrorBox('CF Coach 发生错误', String(err && err.message || err));
  } catch (e) { /* 连弹框都失败就只能放弃 */ }
});

const APP_DIR = __dirname; // electron/
const ROOT_DIR = path.join(APP_DIR, '..');

// 数据目录：打包版放在可执行文件旁（便携式 data/），开发版与 web 模式共用项目 data/
if (app.isPackaged && !process.env.CHATBOX_DATA_DIR) {
  process.env.CHATBOX_DATA_DIR = path.join(path.dirname(process.execPath), 'data');
}
const DATA_DIR = process.env.CHATBOX_DATA_DIR || path.join(ROOT_DIR, 'data');
process.env.HOST = '127.0.0.1';

// 必须在窗口创建前引入服务（server.js 顶部会读取 CHATBOX_DATA_DIR）
const { startServer } = require(path.join(ROOT_DIR, 'server.js'));
const cfClient = require(path.join(ROOT_DIR, 'lib', 'cf.js'));

app.setAppUserModelId('com.local.cfcoach');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverPort = 0;
let cfWindow = null;          // 抓取题面用的隐藏浏览器窗口（复用，携带 Cloudflare 通行 cookie）

/* ---------------- Codeforces 题面抓取（内嵌 Chromium 过反爬挑战） ---------------- */

const CF_HOST_RE = /^https:\/\/([a-z0-9-]+\.)?codeforces\.com\//i;

/**
 * 用隐藏的 Chromium 窗口加载页面：Cloudflare 的非交互 JS 挑战会在真实浏览器里自动通过，
 * 拿到 `cf_clearance` cookie 后再读取 DOM。仅允许 codeforces.com 域名。
 */
/** 抓取用会话的代理：读取本地配置里的 cfProxy（如 http://127.0.0.1:7890） */
function applyCfProxy(session) {
  let proxy = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    proxy = String(cfg.cfProxy || '').trim();
  } catch (e) { /* 配置不存在时直连 */ }
  if (proxy && /^(https?|socks5?):\/\//i.test(proxy)) {
    session.setProxy({ proxyRules: proxy }).then(() => {
      console.log('[cf] 已启用代理: ' + proxy);
    }).catch((e) => console.log('[cf] 代理设置失败: ' + e.message));
  } else {
    session.setProxy({ mode: 'direct' }).catch(() => {});
  }
}

function fetchHtmlViaBrowser(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    if (!CF_HOST_RE.test(url)) { reject(new Error('仅允许抓取 codeforces.com 页面')); return; }
    let settled = false;
    let deadline = null;
    const wanted = url.split('?')[0];
    const win = ensureCfWindow(!!o.visible);
    applyCfProxy(win.webContents.session);
    console.log('[cf] 浏览器抓取（' + (o.visible ? '可见窗口' : '隐藏窗口') + '）: ' + url);

    const cleanup = () => {
      try { win.webContents.removeListener('did-finish-load', onFinish); } catch (e) { /* ignore */ }
      try { win.webContents.removeListener('did-fail-load', onFail); } catch (e) { /* ignore */ }
    };
    const done = (err, html) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (deadline) clearTimeout(deadline);
      if (err) reject(err); else resolve(html);
    };

    const readHtml = async () => {
      try {
        // 优先取「原始 HTML」：在页面上下文里用带 cookie（cf_clearance）的同源 fetch 请求本页，
        // 拿到的是 CF 服务器返回的原始标记（公式是 $$$…$$$、结构稳定），
        // 比渲染后的 DOM 更适合解析，也避开 MathJax 造成的重复文本。
        // CHATBOX_CF_FORCE_DOM=1 时跳过该通道，用于抓取「渲染后 DOM」做解析器回归夹具。
        const raw = process.env.CHATBOX_CF_FORCE_DOM ? null : await win.webContents.executeJavaScript(`(async function () {
          try {
            var r = await fetch(location.href, { credentials: 'include', headers: { 'Accept': 'text/html,application/xhtml+xml' } });
            return { status: r.status, text: await r.text() };
          } catch (e) { return { status: -1, error: String(e) }; }
        })()`);
        if (raw && raw.status === 200 && raw.text && raw.text.length > 2000
            && raw.text.indexOf('problem-statement') >= 0
            && !/Just a moment|browser is being checked|cf-mitigated/i.test(raw.text.slice(0, 3000))) {
          console.log('[cf] 原始 HTML 获取成功，长度 ' + raw.text.length + '，落地页 ' + win.webContents.getURL());
          done(null, raw.text);
          return;
        }
        if (raw) console.log('[cf] 原始 HTML 不可用（status=' + raw.status + (raw.error ? ', ' + raw.error : '') + '），改用渲染后的 DOM');
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
        console.log('[cf] 读取完成，长度 ' + (html ? html.length : 0) + '，落地页 ' + win.webContents.getURL());
        done(null, html);
      } catch (e) {
        done(e);
      }
    };

    let attempts = 0;
    const pollForStatement = async () => {
      if (settled) return;
      attempts++;
      if (attempts > 40) { await readHtml(); return; }
      try {
        const state = await win.webContents.executeJavaScript(
          `(function(){ return { stmt: !!document.querySelector('.problem-statement'), ready: document.readyState }; })()`);
        if (state && state.stmt) { await readHtml(); return; }
      } catch (e) { /* 页面跳转中，继续等待 */ }
      setTimeout(pollForStatement, 800);
    };

    let loads = 0;
    const onFinish = async () => {
      if (settled) return;
      loads++;
      const current = win.webContents.getURL().split('?')[0];
      const onRightPage = current === wanted || current.indexOf(wanted) === 0;
      console.log('[cf] 加载 #' + loads + ' 落地: ' + current + (onRightPage ? ' ✓' : ' ✗（反爬挑战跳转）'));
      if (!onRightPage && loads < 4) {
        // Cloudflare 挑战通过后会跳到站点根目录：带着通行 cookie 重新请求目标地址
        setTimeout(() => { if (!settled) win.loadURL(wanted).catch(() => {}); }, 1200);
        return;
      }
      pollForStatement();
    };
    const onFail = (e, code, desc) => {
      console.log('[cf] did-fail-load ' + code + ' ' + desc);
      done(new Error('页面加载失败 ' + code + ' ' + desc));
    };

    try {
      deadline = setTimeout(() => done(new Error('抓取超时（反爬挑战未通过）')), o.visible ? 90000 : 60000);
      console.log('[cf] 开始浏览器抓取: ' + url);
      win.webContents.on('did-finish-load', onFinish);
      win.webContents.on('did-fail-load', onFail);
      win.loadURL(url).catch((e) => done(e));
    } catch (e) {
      done(e);
    }
  });
}

/** 复用的隐藏抓取窗口（persist 分区保存 Cloudflare 通行 cookie） */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function ensureCfWindow(visible) {
  if (cfWindow && !cfWindow.isDestroyed()) {
    // 挑战有时会因为窗口"不可见"（document.hidden / 无渲染帧）而失败：
    // 需要时把窗口切成"可见但仍在屏幕外"，让 Cloudflare 的挑战脚本正常跑完。
    if (visible && !cfWindow.isVisible()) {
      try { cfWindow.setPosition(-12000, -12000); cfWindow.showInactive(); } catch (e) { /* ignore */ }
    }
    return cfWindow;
  }
  cfWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    x: -12000,
    y: -12000,
    show: !!visible,
    title: 'CF Fetch',
    webPreferences: {
      partition: 'persist:cfcoach-fetch',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      images: false,
      backgroundThrottling: false,
      userAgent: CHROME_UA          // 关键：去掉 Electron 标识，否则 Codeforces 会判定为机器人并重定向到首页
    }
  });
  try {
    cfWindow.webContents.setUserAgent(CHROME_UA);
    cfWindow.webContents.session.setUserAgent(CHROME_UA, 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  } catch (e) { /* ignore */ }
  cfWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return cfWindow;
}

// 冒烟自检模式：窗口完全隐藏（不打扰桌面）、跳过单实例锁、加超时保险
const IS_SMOKE = process.env.CHATBOX_SMOKE === '1';

/* ---------------- 单实例 ---------------- */

const gotLock = IS_SMOKE || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (!IS_SMOKE) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(async () => {
    buildMenu();
    // 注册题面抓取通道：普通 HTTP 被 Cloudflare 拦截时改用内嵌浏览器
    try {
      cfClient.setBrowserFetcher(fetchHtmlViaBrowser);
    } catch (e) {
      console.log('[cf] 注册浏览器抓取通道失败: ' + e.message);
    }
    // 抓取自检：CHATBOX_CF_TEST=<URL> 或 CHATBOX_CF_API_TEST=<1800C> 时做一次真实抓取并输出结果
    if (process.env.CHATBOX_CF_VISIBLE_TEST) {
      // 对比实验：可见（屏幕外）窗口加载，看是否仍被重定向
      const url = process.env.CHATBOX_CF_VISIBLE_TEST;
      const w = new BrowserWindow({
        width: 1280, height: 900, x: -12000, y: -12000, show: true,
        webPreferences: { partition: 'persist:cfcoach-visible', userAgent: CHROME_UA, javascript: true }
      });
      w.loadURL(url).catch(() => {});
      await new Promise((r) => setTimeout(r, 12000));
      const landing = w.webContents.getURL();
      const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
      console.log('CF_VISIBLE_TEST ' + JSON.stringify({
        landing,
        len: html.length,
        hasPowering: html.indexOf('Powering the Hero') >= 0,
        hasStmt: html.indexOf('problem-statement') >= 0,
        ua: await w.webContents.executeJavaScript('navigator.userAgent'),
        webdriver: await w.webContents.executeJavaScript('navigator.webdriver')
      }));
      app.exit(0);
      return;
    }
    if (process.env.CHATBOX_CF_TEST || process.env.CHATBOX_CF_API_TEST) {
      try {
        if (process.env.CHATBOX_CF_API_TEST) {
          const ref = String(process.env.CHATBOX_CF_API_TEST).match(/^(\d+)\s*([A-Za-z][0-9]?)$/);
          const p = await cfClient.fetchProblem(ref[1], ref[2]);
          console.log('CF_TEST_RESULT ' + JSON.stringify({
            mode: 'api',
            title: p.title,
            rating: p.rating,
            tags: (p.tags || []).slice(0, 4),
            statementLen: (p.statement || '').length,
            samples: (p.samples || []).filter((s) => s.input != null).length,
            firstSample: (p.samples || [])[0] ? (p.samples[0].input || '').slice(0, 30) : ''
          }));
        } else {
          const testUrl = process.env.CHATBOX_CF_TEST;
          const urls = testUrl.split(',').map((s) => s.trim()).filter(Boolean);
          for (const u of urls) {
            try {
              const html = await fetchHtmlViaBrowser(u);
              // 诊断辅助：把抓到的原始 HTML 落盘，便于离线调试解析器（CHATBOX_CF_DUMP=<目录>）
              if (process.env.CHATBOX_CF_DUMP) {
                try {
                  const dir = process.env.CHATBOX_CF_DUMP;
                  fs.mkdirSync(dir, { recursive: true });
                  const name = u.replace(/[^a-zA-Z0-9]+/g, '_').slice(-80) + '.html';
                  fs.writeFileSync(path.join(dir, name), html, 'utf8');
                  console.log('CF_TEST_DUMP ' + path.join(dir, name) + ' (' + html.length + ' bytes)');
                } catch (e) { console.log('CF_TEST_DUMP_ERROR ' + e.message); }
              }
              const stmtTag = html.match(/<div class="problem-statement[^"]*"/);
              const title = (html.match(/<div class="header">\s*<div class="title">([\s\S]{0,80}?)<\/div>/) || [])[1] || '';
              console.log('CF_TEST_RESULT ' + JSON.stringify({
                mode: 'raw', url: u, len: html.length,
                landing: (cfWindow && !cfWindow.isDestroyed()) ? cfWindow.webContents.getURL() : '',
                hasStmtDiv: !!stmtTag,
                stmtTitle: title.replace(/\s+/g, ' ').trim().slice(0, 60)
              }));
            } catch (e) {
              console.log('CF_TEST_ERROR ' + u + ' → ' + (e && e.message));
            }
          }
        }
      } catch (e) {
        console.log('CF_TEST_ERROR ' + (e && e.message));
      }
      app.exit(0);
      return;
    }
    startServer(0, '127.0.0.1', (addr) => {
      serverPort = addr.port;
      createWindow();
      if (!IS_SMOKE) createTray();
    });
  });
}

/* ---------------- 窗口状态记忆 ---------------- */

function windowStateFile() {
  return path.join(DATA_DIR, 'window-state.json');
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (s && typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch (e) { /* 首次启动或损坏 */ }
  return { width: 1280, height: 820 };
}

function saveWindowState() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getNormalBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(windowStateFile(), JSON.stringify(b));
  } catch (e) { /* 非关键 */ }
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const st = loadWindowState();
  // 冒烟自检：窗口创建在屏幕外且永不显示，测试期间不打扰用户桌面
  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: IS_SMOKE ? -12000 : st.x,
    y: IS_SMOKE ? -12000 : st.y,
    minWidth: 960,
    minHeight: 620,
    title: 'CF Coach · 本地算法教练',
    icon: path.join(ROOT_DIR, 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      preload: path.join(APP_DIR, 'preload.js')
    }
  });

  mainWindow.loadURL('http://127.0.0.1:' + serverPort);
  if (!IS_SMOKE) mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外链 / 页面跳转统一交给系统浏览器，防止窗口被带走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + serverPort)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 点击窗口 ✕ = 直接退出应用（不做托盘驻留，符合常见软件预期）
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  if (IS_SMOKE) runSmoke(mainWindow);
}

/* ---------------- 菜单 ---------------- */

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript('document.querySelector("#btn-new-chat") && document.querySelector("#btn-new-chat").click()');
          }
        },
        {
          label: '打开设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript('document.querySelector("#btn-settings") && document.querySelector("#btn-settings").click()');
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出 CF Coach' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录（本地对话文件）',
          click: () => { shell.openPath(DATA_DIR); }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 托盘（显式按钮触发，✕ 仍为直接退出） ---------------- */

/**
 * 把主窗口**可靠地**带到前台。
 * 为什么不能只写 show()+focus()：实测反馈"托盘右键 → 显示主界面没反应"——
 *   · 窗口如果是最小化的，show() 不会还原（Windows 上仍然是任务栏里那个缩略态）；
 *   · 窗口位置可能落在已经拔掉的显示器上，show() 成功了但屏幕上什么都看不到；
 *   · 单纯 focus() 在 Windows 上未必能把窗口提到最前（前台锁）。
 * 这里：还原 → 确认落在一块真实屏幕上（否则居中）→ show → 置顶再取消置顶（可靠的提权技巧）→ focus。
 */
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 极端情况（窗口被销毁）：重建一个，保证"显示"这个动作永远有结果
    try { createWindow(); } catch (e) { console.log('[tray] 重建窗口失败: ' + e.message); }
    return;
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    const b = mainWindow.getBounds();
    const displays = screen.getAllDisplays();
    const onScreen = displays.some((d) => {
      const w = d.workArea;
      return b.x < w.x + w.width - 40 && b.x + b.width > w.x + 40
        && b.y < w.y + w.height - 40 && b.y + b.height > w.y + 40;
    });
    if (!onScreen) mainWindow.center();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.focus();
    console.log('[tray] 已显示主界面');
  } catch (e) {
    console.log('[tray] 显示主界面失败: ' + e.message);
  }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ROOT_DIR, 'build', 'icon.png'));
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip('CF Coach · 本地算法教练');
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: '显示主界面',
        click: () => revealMainWindow()
      },
      { type: 'separator' },
      {
        label: '退出 CF Coach',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]));
    // 左键单击托盘：已经在前台就最小化（像聊天软件那样切换），否则还原
    tray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
        return;
      }
      revealMainWindow();
    });
  } catch (e) {
    console.log('[tray] 托盘创建失败（无碍使用）: ' + e.message);
  }
}

ipcMain.on('hide-to-tray', () => {
  if (mainWindow) {
    mainWindow.hide();
    if (tray) tray.displayBalloon && tray.displayBalloon({ title: 'CF Coach', content: '已最小化到托盘，点击托盘图标可重新打开' });
  }
});

// 用系统浏览器打开链接（题面被反爬拦截时可让用户自行复制）
ipcMain.on('open-external', (e, url) => {
  try {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  } catch (err) { /* ignore */ }
});

// 打开本地文件 / 文件夹（只允许数据目录内，避免被页面脚本利用）
ipcMain.on('open-path', (e, p) => {
  try {
    const target = path.resolve(String(p || ''));
    const root = path.resolve(DATA_DIR);
    if (!target.startsWith(root)) { console.log('[open-path] 拒绝越界路径: ' + target); return; }
    shell.openPath(target);
  } catch (err) { /* ignore */ }
});

/**
 * 清理「Codeforces 抓取会话」：只清本应用内嵌抓取窗口的 cookie / 缓存（独立 partition），
 * 不触碰用户浏览器的任何数据。用于 CF 端出现异常状态（例如把我们的会话当成移动端）时复位。
 */
ipcMain.handle('cf-clear-session', async () => {
  try {
    const ses = session.fromPartition('persist:cfcoach-fetch');
    await ses.clearStorageData();
    await ses.clearCache();
    try { ses.setUserAgent(CHROME_UA, 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'); } catch (e) { /* ignore */ }
    console.log('[cf] 抓取会话已清理');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------------- 冒烟自检（CI / 开发验证用） ---------------- */

function runSmoke(win) {
  // 硬超时保险：45 秒未完成即强制退出，绝不悬挂窗口/进程
  const killTimer = setTimeout(() => {
    console.log('SMOKE_TIMEOUT 45s');
    isQuitting = true;
    app.exit(1);
  }, 45000);
  win.webContents.on('console-message', (e, a, b) => {
    const level = typeof a === 'object' ? a.level : a;
    const message = typeof a === 'object' ? a.message : b;
    if (level >= 3) console.log('PAGE_ERR ' + message);
  });
  // 注意：必须 once——测试流程内部会重载页面，若用 on 会导致整个流程
  // 在重载后的页面里重复执行一遍，产生相互干扰的"幽灵点击"
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const info = await win.webContents.executeJavaScript(`(function () {
        var $ = function (s) { return document.querySelector(s); };
        return {
          url: location.href,
          headerTitle: $('#header-title') ? $('#header-title').textContent : null,
          welcome: !!$('.welcome'),
          composer: !!$('#composer'),
          convItems: document.querySelectorAll('.conv-item').length,
          theme: document.documentElement.dataset.theme,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          settingsBtn: !!$('#btn-settings'),
          modelLabel: $('#model-select-label') ? $('#model-select-label').textContent : null,
          trayBtn: !!document.querySelector('#btn-tray'),
          bridge: typeof window.chatbox !== 'undefined' && typeof window.chatbox.hideToTray === 'function'
        };
      })()`);
      console.log('SMOKE_RESULT ' + JSON.stringify(info));

      // ---- 可点击性回归检查（关键：全屏覆盖层会拦截一切点击） ----
      const hit = await win.webContents.executeJavaScript(`(function () {
        var top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        var root = document.getElementById('modal-root');
        return {
          topEl: top ? (top.id || (top.className && String(top.className).split(' ')[0]) || top.tagName) : 'none',
          topIsModalRoot: !!(top && (top.id === 'modal-root')),
          modalDisplay: root ? getComputedStyle(root).display : null,
          modalPointerEvents: root ? getComputedStyle(root).pointerEvents : null
        };
      })()`);
      console.log('SMOKE_HIT ' + JSON.stringify(hit));
      const hitOk = !hit.topIsModalRoot && hit.modalDisplay === 'none' && hit.modalPointerEvents === 'none';

      // ---- 真实点击测试：点击「新建对话」应创建并打开新会话 ----
      const idsBefore = await win.webContents.executeJavaScript(
        `fetch('/api/conversations').then(function (r) { return r.json(); }).then(function (j) { return j.conversations.map(function (c) { return c.id; }); })`);
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-new-chat'); if (b) b.click(); return !!b; })()`);
      await new Promise((r) => setTimeout(r, 1800));
      const clickState = await win.webContents.executeJavaScript(`(function () {
        return {
          title: document.querySelector('#header-title') ? document.querySelector('#header-title').textContent : null,
          convItems: document.querySelectorAll('.conv-item').length
        };
      })()`);
      console.log('SMOKE_CLICK ' + JSON.stringify(clickState));
      const clickOk = clickState.title === '新对话' && clickState.convItems >= 1;

      // ---- 纯教练检查：CF 取题 / 讲解语言 / 提问意图 / 页面导航 ----
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-lang-select'); if (b) b.click(); return !!b; })()`);
      await sleep(500);
      const langMenu = await win.webContents.executeJavaScript(`(function () {
        var pop = document.querySelector('#menu-root .menu-pop');
        var r = pop ? pop.getBoundingClientRect() : null;
        return {
          menuVisible: !!(r && r.width > 0),
          items: pop ? pop.querySelectorAll('.menu-item').length : 0
        };
      })()`);
      await win.webContents.executeJavaScript(`(function () { document.body.click(); return true; })()`);
      await sleep(300);
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-intent-select'); if (b) b.click(); return !!b; })()`);
      await sleep(500);
      const intentMenu = await win.webContents.executeJavaScript(`(function () {
        var pop = document.querySelector('#menu-root .menu-pop');
        var r = pop ? pop.getBoundingClientRect() : null;
        return {
          menuVisible: !!(r && r.width > 0),
          items: pop ? pop.querySelectorAll('.menu-item').length : 0
        };
      })()`);
      await win.webContents.executeJavaScript(`(function () { document.body.click(); return true; })()`);
      await sleep(300);
      const coachState = await win.webContents.executeJavaScript(`(function () {
        return {
          cfImportVisible: !document.querySelector('#btn-cf-import').hidden,
          navLibrary: !!document.querySelector('#btn-library'),
          navProfile: !!document.querySelector('#btn-profile'),
          navSettings: !!document.querySelector('#btn-settings'),
          pages: !!document.querySelector('#page-library') && !!document.querySelector('#page-profile') && !!document.querySelector('#page-settings'),
          workbench: !!document.querySelector('.workbench'),
          problemPanel: !!document.querySelector('#problem-panel') && !!document.querySelector('#pp-body'),
          panelRendered: (document.querySelector('#pp-body') || {}).innerHTML ? document.querySelector('#pp-body').innerHTML.length > 40 : false,
          richToggleGone: !document.querySelector('#btn-rich-toggle'),
          workspaceCard: !!document.querySelector('#pp-body [data-pp-ws]'),
          workspaceHint: /验证工作区/.test((document.querySelector('#pp-body') || {}).innerHTML || ''),
          // 本轮花费：校验文案函数可用（真实消息上的渲染由"面板无 PAGE_ERR + panelRendered"覆盖）
          costLine: (function () {
            try {
              var s = MD.formatCost({ usage: { calls: 3, cost: { amount: 0.12, currency: 'CNY' } } });
              var t = MD.formatTokens({ usage: { promptTokens: 12345, completionTokens: 6789 } });
              return /¥/.test(s) && /3 次调用/.test(s) && /12\.3K/.test(t);
            } catch (e) { return false; }
          })(),
          agentWorkbench: !!document.querySelector('[data-agent-workbench]'),
          chatInner: !!(document.querySelector('#chat') || document.querySelector('.chat-scroll') || document.querySelector('#messages')),
          langLabel: document.querySelector('#lang-select-label') ? document.querySelector('#lang-select-label').textContent : null,
          placeholder: document.querySelector('#input').placeholder,
          coachBtnGone: !document.querySelector('#btn-coach-mode'),
          attachGone: !document.querySelector('#btn-attach')
        };
      })()`);
      // 图文讲解（默认交付形式，没有开关）+ 可视化组件渲染
      const richState = await win.webContents.executeJavaScript(`(function () {
        var html = MD.renderMarkdown('<viz-array values="3,1,4" highlight="1" ptr="i:1"></viz-array>\\n\\n<viz-callout type="tip" title="提示">内容</viz-callout>\\n\\n<viz-steps title="步骤"><viz-step title="第一步">a</viz-step><viz-step title="第二步">b</viz-step></viz-steps>', { allowHtml: true });
        var html2 = MD.renderMarkdown('<viz-compare a="堆贪心" b="排序枚举">O(n log n) || 更慢</viz-compare>\\n\\n<viz-formula title="复杂度" fx="$T(n)=O(n\\\\log n)$" legend="n=牌数" why="每个元素进出堆一次"/>\\n\\n<viz-quiz><viz-q q="为什么取最大值？" a="每个 0 独立">补充</viz-q></viz-quiz>', { allowHtml: true });
        var escaped = MD.renderMarkdown('<script>alert(1)<\\/script>', { allowHtml: true });
        return {
          // 开关已去掉：讲解形式是自动的（完整讲解/代码评估 → 图文文档）
          toggleGone: !document.querySelector('#btn-rich-toggle'),
          arrayRendered: html.indexOf('viz-cell-hi') >= 0 && html.indexOf('viz-ptr') >= 0,
          calloutRendered: html.indexOf('viz-callout') >= 0,
          stepsRendered: html.indexOf('viz-step-nav') >= 0,
          compareRendered: html2.indexOf('viz-side-a') >= 0 && html2.indexOf('viz-side-b') >= 0,
          formulaRendered: html2.indexOf('viz-fx') >= 0 && html2.indexOf('viz-legend') >= 0 && html2.indexOf('viz-why') >= 0,
          quizRendered: html2.indexOf('viz-qh') >= 0 && html2.indexOf('viz-qa') >= 0 && html2.indexOf('data-quiz-toggle') >= 0,
          scriptStripped: escaped.indexOf('<script') < 0,
          // 题目面板里如实显示"讲解形式"
          formRow: /讲解形式/.test((document.querySelector('#pp-body') || {}).innerHTML || '')
        };
      })()`);
      console.log('SMOKE_RICH ' + JSON.stringify(richState));
      const richOk = richState.toggleGone && richState.arrayRendered && richState.calloutRendered
        && richState.stepsRendered && richState.compareRendered && richState.formulaRendered
        && richState.quizRendered && richState.scriptStripped;
      // 编码回归：**普通讲解**也必须把 viz-* 组件渲染成 HTML，
      // 绝不能把 `<viz-steps title="…">` 当纯文本吐给学员
      const vizState = await win.webContents.executeJavaScript(`(function () {
        var md = [
          '## 思路',
          '结论：贪心取最大值。',
          '<viz-callout type="key" title="核心观察">每个 0 独立取一张。</viz-callout>',
          '<viz-steps title="手算"><viz-step title="第 1 步">读入</viz-step></viz-steps>',
          '<viz-array values="3,0,2" highlight="1" title="状态"></viz-array>',
          '<viz-formula title="复杂度" fx="$T(n)=O(n\\\\log n)$" legend="n=元素数" why="每个元素进出堆一次"/>',
          '<viz-quiz><viz-q q="为什么取最大？" a="交换论证">留下的更小不会更差。</viz-q></viz-quiz>',
          '单字符公式也要渲染：$s$ 与 $t$。',
          '没闭合的组件不能露出来：<viz-steps title="坏的"><viz-step title="x">忘了闭合'
        ].join('\\n\\n');
        var host = document.createElement('div');
        host.style.position = 'fixed'; host.style.left = '-9999px';
        document.body.appendChild(host);
        host.innerHTML = MD.renderMarkdown(md, { allowHtml: false });
        var text = host.textContent || '';
        var res = {
          leaked: (text.match(/<viz-[a-z]+/g) || []).length,          // 裸标记泄漏数（必须为 0）
          callout: host.querySelectorAll('.viz-callout').length,
          steps: host.querySelectorAll('.viz-step-nav').length > 0 || host.querySelectorAll('[class^="viz-step"]').length > 0,
          array: host.querySelectorAll('.viz-cell-hi').length > 0,
          formula: host.querySelectorAll('.viz-fx').length > 0,
          quiz: host.querySelectorAll('.viz-qh').length > 0,
          singleCharMath: (text.match(/\\$s\\$/g) || []).length === 0 && host.querySelectorAll('.katex').length > 0
        };
        host.remove();
        return res;
      })()`);
      console.log('SMOKE_VIZ ' + JSON.stringify(vizState));
      const vizOk = vizState.leaked === 0 && vizState.callout > 0 && vizState.steps
        && vizState.array && vizState.formula && vizState.quiz && vizState.singleCharMath;
      // 页面切换检查：题目库 → 返回教练
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-library'); if (b) b.click(); return !!b; })()`);
      await sleep(600);
      const libState = await win.webContents.executeJavaScript(`(function () {
        var page = document.querySelector('#page-library');
        var r = page.getBoundingClientRect();
        var wb = document.querySelector('.workbench');
        return {
          libVisible: !page.hidden,
          chatHidden: wb.hidden && getComputedStyle(wb).display === 'none',
          pageFullHeight: r.height > window.innerHeight * 0.7,
          pageFullWidth: r.width > window.innerWidth * 0.6,
          title: document.querySelector('.page-title') ? document.querySelector('.page-title').textContent : null,
          filterSelects: document.querySelectorAll('.lib-filter').length
        };
      })()`);
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-library'); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      const viewBackState = await win.webContents.executeJavaScript(
        `(function () { return { chatVisible: !document.querySelector('.workbench').hidden, libHidden: document.querySelector('#page-library').hidden }; })()`);
      // ---- 独立整页检查：我的（就地编辑） / 这道题的设置 ----
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-profile'); if (b) b.click(); return !!b; })()`);
      await sleep(900);
      const profilePageState = await win.webContents.executeJavaScript(`(function () {
        var page = document.querySelector('#page-profile');
        var r = page.getBoundingClientRect();
        var wb = document.querySelector('.workbench');
        return {
          visible: !page.hidden,
          fullWidth: r.width > window.innerWidth * 0.6,
          fullHeight: r.height > window.innerHeight * 0.7,
          chatHidden: getComputedStyle(wb).display === 'none',
          hasChart: !!page.querySelector('.rating-chart, .form-hint'),
          modalCount: document.querySelectorAll('#modal-root .modal').length
        };
      })()`);
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('[data-prof-edit]'); if (b) b.click(); return !!b; })()`);
      await sleep(700);
      const profileEditState = await win.webContents.executeJavaScript(`(function () {
        var page = document.querySelector('#page-profile');
        var empty = page.querySelector('.profile-empty');
        return {
          inlineForm: !!page.querySelector('[data-pe-text]'),
          hasEditBtn: !!page.querySelector('[data-prof-edit]'),
          btnText: page.querySelector('[data-prof-edit]') ? page.querySelector('[data-prof-edit]').textContent : null,
          htmlLen: page.innerHTML.length,
          html: page.innerHTML.slice(0, 200),
          note: empty ? empty.textContent.slice(0, 60) : '',
          modalCount: document.querySelectorAll('#modal-root .modal').length
        };
      })()`);
      console.log('SMOKE_PAGES ' + JSON.stringify({ profilePageState, profileEditState }));
      const pagesOk = profilePageState.visible && profilePageState.fullWidth && profilePageState.fullHeight
        && profilePageState.chatHidden && profilePageState.modalCount === 0
        && profileEditState.inlineForm && profileEditState.modalCount === 0;
      // 回到教练视图
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-profile'); if (b) b.click(); return !!b; })()`);
      await sleep(500);
      console.log('SMOKE_COACH ' + JSON.stringify({ langMenu, intentMenu, coachState, libState, viewBackState }));
      const coachOk = langMenu.menuVisible && langMenu.items >= 2
        && intentMenu.menuVisible && intentMenu.items >= 4
        && coachState.cfImportVisible && coachState.navLibrary && coachState.navProfile && coachState.navSettings && coachState.pages
        && coachState.workbench && coachState.problemPanel && coachState.panelRendered && coachState.richToggleGone
        && coachState.workspaceCard && coachState.workspaceHint && coachState.agentWorkbench && coachState.costLine
        && coachState.coachBtnGone && coachState.placeholder.indexOf('Codeforces') >= 0
        && libState.libVisible && libState.chatHidden && libState.filterSelects >= 4
        && viewBackState.chatVisible && viewBackState.libHidden && pagesOk;

      // 清理冒烟测试创建的会话，避免污染用户数据
      const idsAfter = await win.webContents.executeJavaScript(
        `fetch('/api/conversations').then(function (r) { return r.json(); }).then(function (j) { return j.conversations.map(function (c) { return c.id; }); })`);
      for (const id of idsAfter) {
        if (!idsBefore.includes(id)) {
          await win.webContents.executeJavaScript(
            `fetch('/api/conversations/${id}', { method: 'DELETE' }).catch(function () {})`);
        }
      }

      // ---- 设置页检查（独立页面 + 添加服务菜单 + 服务编辑弹窗层级） ----
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-settings'); if (b) b.click(); return !!b; })()`);
      await sleep(700);
      const settings1 = await win.webContents.executeJavaScript(`(function () {
        return {
          pageVisible: !document.querySelector('#page-settings').hidden,
          chatHidden: document.querySelector('.workbench').hidden,
          hasTabs: !!document.querySelector('[data-stab="providers"]'),
          hasAppearance: !!(document.querySelector('[data-g-bg]') && document.querySelector('[data-g-accent]')
            && document.querySelector('[data-g-density]') && document.querySelector('[data-g-bgstyle]')
            && document.querySelector('[data-g-uifont]') && document.querySelector('[data-g-radius]')
            && document.querySelector('[data-g-width]') && document.querySelector('[data-g-anim]')
            && document.querySelector('[data-g-codetheme]') && document.querySelector('[data-g-codefont]')
            && document.querySelector('[data-g-reset-appearance]')),
          hasNetwork: !!(document.querySelector('[data-g-cfproxy]') && document.querySelector('[data-g-cftest]')
            && document.querySelector('[data-g-bgimg-upload]')),
          hasSandbox: !!(document.querySelector('[data-g-sandbox]') && document.querySelector('[data-g-sandboxnet]')),
          hasCfClear: !!document.querySelector('[data-g-cfclear]'),
          noParams: !document.querySelector('[data-g-t]')
        };
      })()`);
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('[data-stab="providers"]'); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      const agentModelsState = await win.webContents.executeJavaScript(`(function () {
        var sels = document.querySelectorAll('[data-agent-model]');
        return {
          count: sels.length,
          save: !!document.querySelector('[data-agent-save]'),
          roles: Array.prototype.map.call(sels, function (s) { return s.getAttribute('data-agent-model'); })
        };
      })()`);
      console.log('SMOKE_AGENT_MODELS ' + JSON.stringify(agentModelsState));
      const agentModelsOk = agentModelsState.count >= 7 && agentModelsState.save
        && agentModelsState.roles.indexOf('brute') >= 0 && agentModelsState.roles.indexOf('gen') >= 0
        && agentModelsState.roles.indexOf('witness') >= 0 && agentModelsState.roles.indexOf('normalize') >= 0;
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('[data-p-add]'); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      const addMenu = await win.webContents.executeJavaScript(`(function () {
        var pop = document.querySelector('#menu-root .menu-pop');
        var item = pop ? pop.querySelectorAll('.menu-item').length : 0;
        var visible = false, hitMenu = false, zIndex = null;
        if (pop) {
          var cs = getComputedStyle(pop);
          var r = pop.getBoundingClientRect();
          visible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          zIndex = cs.zIndex;
          if (visible) {
            var x = r.left + Math.min(r.width / 2, 60);
            var y = Math.min(r.top + 30, r.bottom - 8);
            var el = document.elementFromPoint(x, y);
            hitMenu = !!(el && pop.contains(el));
          }
        }
        return { menuPresent: !!pop, menuVisible: visible, menuItems: item, menuHits: hitMenu, menuZIndex: zIndex };
      })()`);
      console.log('SMOKE_SETTINGS_ADD ' + JSON.stringify(addMenu));
      const addMenuOk = addMenu.menuVisible && addMenu.menuItems >= 1 && addMenu.menuHits;
      // 点击第一个预设 → 应进入「模型服务编辑」独立整页（无弹窗）
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('[data-menu-idx="0"]'); if (b) b.click(); return !!b; })()`);
      await sleep(500);
      const stackState = await win.webContents.executeJavaScript(`(function () {
        var page = document.querySelector('#page-provider-edit');
        var r = page ? page.getBoundingClientRect() : null;
        return {
          editorPage: !!(page && !page.hidden),
          editorFullWidth: !!(r && r.width > window.innerWidth * 0.75),
          settingsHidden: document.querySelector('#page-settings').hidden,
          modalCount: document.querySelectorAll('#modal-root .modal').length,
          hasSave: !!document.querySelector('[data-pe-save]'),
          hasBack: !!document.querySelector('#page-provider-edit [data-page-back]')
        };
      })()`);
      // 点「返回」→ 回到设置页
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#page-provider-edit [data-page-back]'); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      const backState = await win.webContents.executeJavaScript(`(function () {
        var r = document.querySelector('#page-settings').getBoundingClientRect();
        return {
          settingsVisible: !document.querySelector('#page-settings').hidden,
          settingsFullWidth: r.width > window.innerWidth * 0.75,
          editorHidden: document.querySelector('#page-provider-edit').hidden,
          modalCount: document.querySelectorAll('#modal-root .modal').length
        };
      })()`);
      console.log('SMOKE_SETTINGS_STACK ' + JSON.stringify({ opened: stackState, back: backState }));
      const stackOk = stackState.editorPage && stackState.editorFullWidth && stackState.settingsHidden
        && stackState.modalCount === 0 && stackState.hasSave && stackState.hasBack
        && backState.settingsVisible && backState.settingsFullWidth && backState.editorHidden && backState.modalCount === 0;
      // 返回教练视图（再次点击当前导航按钮）
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-settings'); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      const settings2 = await win.webContents.executeJavaScript(`(function () {
        return { chatVisible: !document.querySelector('.workbench').hidden };
      })()`);
      console.log('SMOKE_SETTINGS_CLOSE ' + JSON.stringify({ open: settings1, closed: settings2 }));
      const settingsOk = settings1.pageVisible && settings1.chatHidden && settings1.hasTabs
        && settings1.hasAppearance && settings1.hasNetwork && settings1.hasSandbox && settings1.hasCfClear && settings1.noParams && settings2.chatVisible
        && agentModelsOk;

      // ---- 模型选择检查（回归：无会话/未配置服务时点击必须有响应） ----
      const apiBase = 'http://127.0.0.1:' + serverPort;
      const cfgSnapshot = await (await fetch(apiBase + '/api/config')).json();
      const smokeCfg = Object.assign({}, cfgSnapshot, {
        providers: [{
          id: 'smoke-p', name: 'SmokeTest', type: 'openai',
          baseUrl: 'http://127.0.0.1:3999/v1', apiKey: '', extraHeaders: {},
          models: ['smoke-model-a', 'smoke-model-b']
        }],
        defaultProviderId: 'smoke-p',
        defaultModel: 'smoke-model-a'
      });
      await fetch(apiBase + '/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(smokeCfg)
      });
      // 重载页面使前端读到新配置（重载后 lastConvId 指向已删除会话 → 自动回到欢迎页，即"无会话"状态）
      await new Promise((resolve) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.reload();
      });
      await sleep(2500);
      const idsBeforeModel = (await (await fetch(apiBase + '/api/conversations')).json()).conversations.map((c) => c.id);
      // 安装运行时错误捕获 + 菜单容器变更日志，排查异步链路
      await win.webContents.executeJavaScript(`(function () {
        window.__smokeErrors = [];
        window.__menuLog = [];
        window.__clickLogs = [];
        window.addEventListener('error', function (e) { window.__smokeErrors.push(String(e.message)); });
        window.addEventListener('unhandledrejection', function (e) { window.__smokeErrors.push('rejection: ' + String(e.reason)); });
        document.addEventListener('click', function (e) {
          window.__clickLogs.push({
            tag: e.target.tagName,
            id: e.target.id || '',
            cls: String(e.target.className || '').slice(0, 40),
            x: e.clientX, y: e.clientY,
            isTrusted: e.isTrusted
          });
        }, true);
        var mo = new MutationObserver(function (muts) {
          muts.forEach(function (m) {
            Array.prototype.forEach.call(m.addedNodes, function (n) {
              if (n.nodeType === 1) window.__menuLog.push({ op: 'add', id: n.id, cls: String(n.className).slice(0, 40) });
            });
            Array.prototype.forEach.call(m.removedNodes, function (n) {
              if (n.nodeType === 1) window.__menuLog.push({ op: 'remove', id: n.id, cls: String(n.className).slice(0, 40) });
            });
          });
        });
        mo.observe(document.getElementById('menu-root'), { childList: true });
        mo.observe(document.getElementById('modal-root'), { childList: true });
        return true;
      })()`);
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('#btn-model-select'); if (b) b.click(); return !!b; })()`);
      const sampleMenu = () => win.webContents.executeJavaScript(`(function () {
        var pop = document.querySelector('#menu-root .menu-pop');
        var r = pop ? pop.getBoundingClientRect() : null;
        return {
          present: !!pop,
          visible: !!(r && r.width > 0 && r.height > 0),
          items: pop ? pop.querySelectorAll('[data-model-pick]').length : 0,
          menuRootChildren: document.getElementById('menu-root').children.length,
          modalOpen: document.getElementById('modal-root').children.length > 0,
          toasts: document.querySelectorAll('#toast-root .toast').length,
          clicks: window.__clickLogs,
          activeTag: document.activeElement ? document.activeElement.tagName : null,
          menuLog: window.__menuLog,
          errors: window.__smokeErrors || []
        };
      })()`);
      const sample1 = await sampleMenu();
      await sleep(1400);
      const sample2 = await sampleMenu();
      console.log('SMOKE_MODEL_S1 ' + JSON.stringify(sample1));
      console.log('SMOKE_MODEL_S2 ' + JSON.stringify(sample2));
      await win.webContents.executeJavaScript(
        `(function () { var b = document.querySelector('[data-model-pick="smoke-p|smoke-model-b"]'); if (b) b.click(); return !!b; })()`);
      await sleep(900);
      const modelLabel = await win.webContents.executeJavaScript(
        `(document.querySelector('#model-select-label') ? document.querySelector('#model-select-label').textContent : null)`);
      const convTitle = await win.webContents.executeJavaScript(
        `(document.querySelector('#header-title') ? document.querySelector('#header-title').textContent : null)`);
      console.log('SMOKE_MODEL ' + JSON.stringify({ label: modelLabel, convTitle: convTitle }));
      const modelOk = sample2.present && sample2.visible && sample2.items >= 2
        && sample2.errors.length === 0 && convTitle === '新对话' && modelLabel === 'smoke-model-b';
      // 清理：删除自动新建的会话，恢复原始配置
      const idsNow = (await (await fetch(apiBase + '/api/conversations')).json()).conversations.map((c) => c.id);
      for (const id of idsNow) {
        if (!idsBeforeModel.includes(id)) {
          await fetch(apiBase + '/api/conversations/' + id, { method: 'DELETE' }).catch(() => {});
        }
      }
      await fetch(apiBase + '/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfgSnapshot)
      }).catch(() => {});

      /* ---- 并发工作台：三个代码 Agent 真并发时，界面按角色归属、耗时真实 ---- */
      // 回归目标：曾经按"最后一个还在跑的条目"匹配事件 → 并发下两个 Agent 显示"0s 完成"，
      // 看起来像并行没生效。这里用 mock-delay（题解 2.5s / 暴力 1.5s / 生成器 0.8s）跑**真实 SSE**，
      // 直接读工作台 DOM：跑的时候三个都必须是"进行中"，跑完后每个的耗时都必须是真实秒数（不是 0s）。
      const paraCfg = Object.assign({}, cfgSnapshot, {
        providers: [{
          id: 'smoke-p', name: 'SmokeTest', type: 'openai',
          baseUrl: 'http://127.0.0.1:3999/v1', apiKey: '', extraHeaders: {},
          models: ['mock-delay']
        }],
        defaultProviderId: 'smoke-p',
        defaultModel: 'mock-delay'
      });
      await fetch(apiBase + '/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(paraCfg)
      });
      const convPara = await (await fetch(apiBase + '/api/conversations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      })).json();
      await fetch(apiBase + '/api/conversations/' + convPara.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-delay', intent: 'full' })
      });
      await win.webContents.executeJavaScript(
        `(function () { localStorage.setItem('lastConvId', ${JSON.stringify(convPara.id)}); location.reload(); return true; })()`);
      await sleep(2500);
      const readWb = () => win.webContents.executeJavaScript(`(function () {
        var box = document.querySelector('[data-agent-workbench]');
        var items = box ? Array.prototype.slice.call(box.querySelectorAll('details.pp-agent')) : [];
        return {
          hidden: !box || box.hidden,
          total: items.length,
          running: items.filter(function (d) { return /进行中/.test(d.querySelector('.pp-agent-meta').textContent); }).length,
          metas: items.map(function (d) {
            return d.querySelector('summary b').textContent + ' · ' + d.querySelector('.pp-agent-meta').textContent;
          }),
          secs: items.map(function (d) {
            var m = /(\\d+)s/.exec(d.querySelector('.pp-agent-meta').textContent);
            return m ? parseInt(m[1], 10) : -1;
          })
        };
      })()`);
      const sent = await win.webContents.executeJavaScript(`(function () {
        var inp = document.querySelector('#input');
        var btn = document.querySelector('#btn-send');
        if (!inp || !btn) return false;
        inp.value = 'CF 1800C 讲解一下';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        btn.click();
        return true;
      })()`);
      // 自适应采样：一直采到"三个代码 Agent 同时进行中"为止（最多 20 秒）。
      // 打包版首次发送比开发版慢（冷启动 + 取题），机器忙时链路起步也会晚 —— 窗口太短会误报。
      const wbSamples = [];
      for (let i = 0; i < 66; i++) {
        await sleep(300);
        const s = await readWb();
        wbSamples.push(s);
        if (s.running >= 3) break;
      }
      let wbAfter = null;
      for (let i = 0; i < 60; i++) {
        await sleep(700);
        wbAfter = await readWb();
        if (wbAfter.total >= 3 && wbAfter.running === 0) break;
      }
      const maxRunning = Math.max.apply(null, wbSamples.map((s) => s.running));
      const realSecs = (wbAfter ? wbAfter.secs : []).filter((s) => s >= 1);
      console.log('SMOKE_WORKBENCH ' + JSON.stringify({
        sent, maxRunning, during: wbSamples.map((s) => s.metas), after: wbAfter && wbAfter.metas
      }));
      const paraOk = sent && maxRunning >= 3
        && wbAfter && wbAfter.running === 0 && realSecs.length >= 3
        && new Set(realSecs).size >= 2;
      // 清理：删掉这次会话，恢复原始配置
      await fetch(apiBase + '/api/conversations/' + convPara.id, { method: 'DELETE' }).catch(() => {});
      await win.webContents.executeJavaScript(`(function () { localStorage.removeItem('lastConvId'); return true; })()`);

      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(ROOT_DIR, 'smoke.png'), img.toPNG());
      console.log('SMOKE_SHOT smoke.png (' + img.toPNG().length + ' bytes)');
      const trayOk = info.trayBtn === true && info.bridge === true;
      console.log('SMOKE_TRAY ' + JSON.stringify({ trayBtn: info.trayBtn, bridge: info.bridge }));
      // 托盘"显示主界面"必须真的能把窗口叫回来（实测反馈过它没反应）：
      // 这里走一遍 hide → revealMainWindow() → 断言窗口可见；再最小化 → reveal 也能还原。
      const revealState = {};
      try {
        mainWindow.hide();
        revealState.hiddenOk = mainWindow.isVisible() === false;
        revealMainWindow();
        revealState.shownOk = mainWindow.isVisible() === true;
        mainWindow.minimize();
        revealMainWindow();
        revealState.restoredOk = mainWindow.isVisible() === true && mainWindow.isMinimized() === false;
        revealState.centeredIfOffscreen = true;   // 逻辑同上（无第二块屏可测）
      } catch (e) {
        revealState.error = e.message;
      }
      console.log('SMOKE_TRAY_REVEAL ' + JSON.stringify(revealState));
      const revealOk = revealState.hiddenOk === true && revealState.shownOk === true && revealState.restoredOk === true;
      console.log('SMOKE_OVERALL ' + (hitOk && clickOk && coachOk && richOk && vizOk && addMenuOk && stackOk && settingsOk && modelOk && paraOk && trayOk && revealOk ? 'PASS' : 'FAIL'));
    } catch (e) {
      console.log('SMOKE_ERROR ' + (e && e.message));
    }
    clearTimeout(killTimer);
    isQuitting = true;
    // 冒烟模式用硬退出，确保主进程与所有子进程零残留
    app.exit(0);
  });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.log('SMOKE_FAIL_LOAD ' + code + ' ' + desc);
  });
}

/* ---------------- 退出 ---------------- */

app.on('before-quit', () => {
  isQuitting = true;
  try { if (cfWindow && !cfWindow.isDestroyed()) cfWindow.destroy(); } catch (e) { /* ignore */ }
});
app.on('window-all-closed', () => {
  app.quit();
});
