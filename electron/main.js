/**
 * electron/main.js — ChatBox 桌面应用主进程
 * 特性：
 *  - 内嵌本地服务（复用 server.js，随机空闲端口，仅 127.0.0.1）
 *  - 单实例锁；原生菜单（Ctrl+N 新建对话等）；系统托盘（关闭即最小化到托盘）
 *  - 窗口大小/位置记忆；外链用系统浏览器打开；页面导航锁定本机
 *  - CHATBOX_SMOKE=1 时启动自检：校验页面 DOM + 截图 smoke.png 后自动退出
 */
'use strict';

/**
 * 冒烟自检模式：把 Codeforces 指向本地 mock（run-smoke.js 会在 3998 起一个）。
 *
 * 为什么要在这里、且必须在 require 之前：`lib/cf.js` 在**加载时**就把 CF_BASE 定下来了，
 * 之后再设环境变量已经没用。而冒烟测试跑的是"取题 → 验证 → 出图文文档"的真实链路，
 * 如果不指向 mock，它就会去访问真的 codeforces.com —— 于是冒烟的结果取决于外网与 CF 反爬，
 * 还会因为取不到题面而在工具循环里反复重试（实测：chips 12 个、工作台全空）。
 */
if (process.env.CHATBOX_SMOKE === '1' && !process.env.CF_BASE) {
  process.env.CF_BASE = 'http://127.0.0.1:' + (process.env.CHATBOX_SMOKE_CF_PORT || '3998');
}

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
const { startServer, setSubmissionBrowserFetch, setEditorialBrowserFetch, setChallengeWindowOpener, setCfLoginOpener, setCfWarmOpener } = require(path.join(ROOT_DIR, 'server.js'));
const cfClient = require(path.join(ROOT_DIR, 'lib', 'cf.js'));
const { createSerialQueue } = require(path.join(ROOT_DIR, 'lib', 'serialqueue.js'));

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

/**
 * 抓取窗口的**串行队列**（多题并行的关键）。
 *
 * 为什么必须排队：整个应用只有一个 cfWindow。它靠 webContents 的
 * did-finish-load / did-fail-load 事件 + 轮询判断"这一页是不是题面"，
 * 两个抓取同时进行时，双方会挂上同一组监听、互相抢占同一个 webContents 的导航 ——
 * A 的回调看到的是 B 的页面（判成"被重定向"），B 可能读到 A 的 HTML，
 * 于是"两个会话同时问两道题"会退化成随机失败或抓错题面。
 *
 * 串行化的只是**共享窗口这一段**（一次抓取本身也就几秒，包含挑战等待）：
 * 两轮对话的模型调用、编译、对拍、文档生成仍然各跑各的。
 * 队列里前一个抓取失败不会卡住后面的（见 lib/serialqueue.js）。
 */
const cfFetchQueue = createSerialQueue();

/** 排队抓取（对外入口，保持原来的函数签名） */
function fetchHtmlViaBrowser(url, opts) {
  const ahead = cfFetchQueue.pending;
  if (ahead > 0) console.log('[cf] 抓取排队中（前面还有 ' + ahead + ' 个抓取）: ' + url);
  return cfFetchQueue.push(() => fetchHtmlViaBrowserNow(url, opts));
}

function fetchHtmlViaBrowserNow(url, opts) {
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
        const state = await readPageState();
        if (state && state.stmt) { await readHtml(); return; }
      } catch (e) { /* 页面跳转中，继续等待 */ }
      setTimeout(pollForStatement, 800);
    };

    /**
     * 读一眼"现在这一页到底是什么"：目标题面 / 反爬挑战页 / 被甩回站内其它页。
     *
     * 为什么要区分这三种：旧实现在"落地页不是目标页"时**一律重新 loadURL**（最多 4 次），
     * 而挑战页恰恰是最怕反复重新导航的 —— 每导航一次就重新触发一次挑战，于是表现为
     * "一直爆拦截、还越来越慢"。挑战页要等它自己跑完，站内跳转才需要再请求一次。
     */
    const readPageState = () => win.webContents.executeJavaScript(`(function(){
      var t = String(document.title || '');
      var challenge = !!document.querySelector('#challenge-form, #challenge-stage, #cf-challenge-running, .cf-browser-verification')
        || /just a moment|browser is being checked|checking your browser|enable javascript and cookies/i.test(t);
      return {
        url: String(location.href),
        title: t,
        challenge: challenge,
        stmt: !!document.querySelector('.problem-statement'),
        ready: document.readyState
      };
    })()`).catch(() => null);

    let loads = 0;
    let challengeSince = 0;
    let emptyOnTarget = 0;
    let sawChallenge = false;
    const t0 = Date.now();
    const onFinish = async () => {
      if (settled) return;
      loads++;
      const current = win.webContents.getURL().split('?')[0];
      const onRightPage = current === wanted || current.indexOf(wanted) === 0;
      const st = await readPageState();
      const challenged = !!(st && st.challenge);
      console.log('[cf] 加载 #' + loads + ' 落地: ' + current + (onRightPage ? ' ✓' : ' ✗')
        + (challenged ? '（反爬挑战页）' : ''));
      diagLog('加载 #' + loads + '（+' + (Date.now() - t0) + 'ms）落地 ' + current
        + '（' + (onRightPage ? '目标页' : '被重定向') + (challenged ? '/挑战页' : '') + '，'
        + (o.visible ? '可见' : '隐藏') + '窗口）');
      if (challenged) {
        sawChallenge = true;
        // 挑战页：**不要**再 loadURL（每次重新导航都会重新触发挑战）。等它自己跳走，
        // 但只给一个很短的预算 —— 挑战在隐藏窗口里经常过不去，早点失败才能让外层的
        // "可见窗口"重试接上来（lib/cf.js 的两段式）。旧实现要耗满 60 秒才走到那一步。
        if (!challengeSince) challengeSince = Date.now();
        const waited = Date.now() - challengeSince;
        if (waited > CHALLENGE_WAIT_MS) {
          diagFail('题面抓取：反爬挑战页超过 ' + Math.round(CHALLENGE_WAIT_MS / 1000) + ' 秒未通过'
            + '（窗口=' + (o.visible ? '可见' : '隐藏') + '，落地 ' + current + '，标题 ' + JSON.stringify((st && st.title) || '') + '）');
          done(new Error('反爬挑战未通过（' + (o.visible ? '可见窗口' : '隐藏窗口') + '）'));
          return;
        }
        setTimeout(() => { if (!settled) onFinish(); }, 900);
        return;
      }
      challengeSince = 0;
      /**
       * 已经停在**目标地址**上、页面也加载完了，却依然没有 .problem-statement：
       * 那就不是"还没渲染好"，而是**这道题根本不存在或不可见**（CF 对这类请求照样回 200，
       * 内容却是站点框架/别的页面）。早点把 HTML 交回去让上层判类型，别在这里耗满 20 秒
       * —— 旧行为正是白等 20 秒后报一句含糊的"被反爬"。
       * 留两次轮询（约 1.8 秒）余量，避免把"刚提交还没渲染完"误判成不存在。
       */
      if (onRightPage && st && st.ready === 'complete' && !st.stmt) {
        emptyOnTarget++;
        if (emptyOnTarget >= 2) {
          diagFail('题面抓取：目标地址上没有任何题面结构（这道题很可能不存在或不可见）：'
            + current + '｜标题 ' + JSON.stringify((st && st.title) || ''));
          await readHtml();
          return;
        }
        setTimeout(() => { if (!settled) onFinish(); }, 900);
        return;
      }
      /**
       * 被甩回站内其它页**且不是挑战页**：
       *   · 这轮见过挑战 → 再请求一次目标地址是有用的（挑战通过后 CF 会先甩到站点根，带着新
       *     cookie 重来一次就成）；最多重来 2 次。
       *   · 一次挑战都没见过 → 说明这个地址是真的不成立（题号不存在 / 比赛不存在 / 无权限），
       *     再导航几次也是白等。早点把 HTML 交回上层，让 lib/cf.js 判类型并给准确结论。
       */
      if (!onRightPage && (!sawChallenge || loads >= 3)) {
        diagFail('题面抓取：被重定向离开目标地址（落地 ' + current + '，见过挑战=' + sawChallenge
          + '，第 ' + loads + ' 次，窗口=' + (o.visible ? '可见' : '隐藏') + '）');
        // 标记 notFound：告诉上层"这不是反爬挑战，是地址本身不成立（题号/比赛不存在/无权限）"，
        // 于是它不必再开可见窗口重试一遍（那只会让用户多等十几秒）
        const err = new Error('目标地址被重定向到 ' + current + '（没有出现反爬挑战页）');
        err.notFound = true;
        done(err);
        return;
      }
      if (!onRightPage && loads < 4) {
        // 站内跳转（挑战通过后 CF 会先甩到站点根）：带着新拿到的通行 cookie 重新请求目标地址
        setTimeout(() => { if (!settled) win.loadURL(wanted).catch(() => {}); }, 1200);
        return;
      }
      pollForStatement();
    };
    const onFail = (e, code, desc) => {
      console.log('[cf] did-fail-load ' + code + ' ' + desc);
      diagFail('题面抓取：页面加载失败 ' + code + ' ' + desc + '（' + url + '）');
      done(new Error('页面加载失败 ' + code + ' ' + desc));
    };

    try {
      // 隐藏窗口的预算**故意短**：它只是"安静的第一枪"，过不了挑战就赶紧交给可见窗口。
      // 旧实现隐藏 60 秒 / 可见 90 秒，用户体感就是"卡住不动然后报被拦截"。
      deadline = setTimeout(() => {
        diagFail('题面抓取：超时（' + (o.visible ? '可见' : '隐藏') + '窗口，' + Math.round((o.visible ? VISIBLE_TIMEOUT_MS : HIDDEN_TIMEOUT_MS) / 1000) + 's）'
          + '，当前落地 ' + (() => { try { return win.webContents.getURL(); } catch (e) { return '?'; } })());
        done(new Error('抓取超时（反爬挑战未通过）'));
      }, o.visible ? VISIBLE_TIMEOUT_MS : HIDDEN_TIMEOUT_MS);
      console.log('[cf] 开始浏览器抓取: ' + url);
      win.webContents.on('did-finish-load', onFinish);
      win.webContents.on('did-fail-load', onFail);
      win.loadURL(url).catch((e) => done(e));
    } catch (e) {
      done(e);
    }
  });
}

/**
 * 题面抓取的时间预算与挑战等待上限。
 *
 * 三个数字都是"别让用户干等"的产物：
 *   · 隐藏窗口：只给 20 秒 —— 它是安静的第一枪，过不了挑战就该让位；
 *   · 挑战页最多等 12 秒 —— 挑战在隐藏窗口里往往根本过不去，等满 60 秒纯属浪费；
 *   · 可见窗口：给足 75 秒 —— 屏内可见窗口是**唯一可靠**过挑战的方式，值得等。
 */
const HIDDEN_TIMEOUT_MS = 20000;
const VISIBLE_TIMEOUT_MS = 75000;
const CHALLENGE_WAIT_MS = 12000;

/**
 * 反爬对照实验用的"伪造 UA"。**默认不使用**——见下方抓取窗口配置的说明：
 * 硬编码 UA（Chrome/131）与 Electron 实际的 Chromium 版本不一致，反而更容易被挑战。
 * 保留它只为 `CHROME_UA` 对照实验与 cf-clear-session 里的复位。
 */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 诊断日志（仅在 CFCOACH_DEBUG_EDITORIAL=1 时写文件）。
 *
 * 为什么不用 console.log：exe 是 GUI 子系统程序，Windows 下没有控制台，
 * 主进程的 console 输出**哪里都看不到**（我用 --log-file 也抓不到）。
 * 反爬这类问题只能靠落盘日志定位，所以这里做成一个显式的诊断通道。
 */
function diagLog(msg) {
  if (!process.env.CFCOACH_DEBUG_EDITORIAL) return;
  try {
    const p = path.join(app.getPath('userData'), 'cf-diag.log');
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

/**
 * **始终落盘**的诊断（不受 CFCOACH_DEBUG_EDITORIAL 控制），只用于"抓取失败/被反爬拦截"这一类事件。
 *
 * 为什么需要它：GUI 版没有控制台，失败原因原本只存在于 console 里 —— 用户报"稳定爆拦截"时，
 * 我们手上一点证据都没有（题面这条链以前连 diagLog 都没调用）。失败是低频事件，
 * 记下来不会有噪音，却能把"到底卡在哪一步"变成可读的事实。
 */
function diagFail(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'cf-diag.log');
    fs.appendFileSync(p, new Date().toISOString() + ' [失败] ' + msg + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

/**
 * 反爬相关：**不要让 Chromium 把抓取窗口当作"被遮挡/后台"**。
 * Cloudflare 的挑战是时序敏感的 JS + 渲染，被节流时要么跑不完、要么反复重挑战
 * —— 这是"用户自己的浏览器一切正常、应用内窗口频繁要过挑战"的最合理解释。
 * 必须在 app ready 之前设置。
 */
try {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} catch (e) { /* ignore */ }

/* ---------------- CF 会话预热（"冷启动第一条必失败"的根治） ---------------- */

/**
 * 主框架导航序号（模块级）。配合 waitCfCommit 用。
 *
 * 为什么需要（这是"每次开应用第一条源码必然取不到"的**真凶**，cf-diag.log 实证）：
 *   `webContents.getURL()` 返回的是**最后一次已提交**的地址。`loadURL()` 之后立刻轮询，
 *   拿到的是**上一个页面**的 URL 和 readyState —— 上一个页面往往正好是首页 `/`，
 *   于是 `readyState==='complete' && 不是目标页` 成立，立刻被判成"提交不存在 / 未登录"。
 *   日志里的证据：导航 #2 只用了 0.4 秒就"结束"了，而真实的提交页要 1.4 秒才能提交。
 *   所以必须等 `did-navigate` 事件（= 新文档真的提交了）再去看落地页。
 */
let cfNavSeq = 0;

/** 等"自从 sinceSeq 之后又发生了一次主框架导航提交"；超时返回 false（不抛异常） */
function waitCfCommit(win, sinceSeq, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (cfNavSeq > sinceSeq) return resolve(true);
      if (win.isDestroyed() || Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * 抓取前的会话准备：把 `persist:cfcoach-fetch` 分区里的 cookie 读出来（顺带让 Chromium 完成装载）。
 *
 * ⚠️ 这里**只读 cookie，绝不做任何导航**。曾经为了绕开"新进程第一次抓取会落到首页"这个问题，
 * 在这里加过一次"先访问首页热身"，结果是**帮了倒忙**（用户实测：原先能抓，改完稳定爆拦截）：
 *   · 抓取窗口是**隐藏**的（`ensureCfWindow(false)`），而代码自己的注释就写着
 *     "隐藏窗口的反爬挑战通过率明显低于可见窗口" —— 预热把首页（CF 防护最重的页面）
 *     放进了一个隐藏窗口，一旦被挑战就过不去；
 *   · 这个窗口是**题面 / 题解 / 提交源码三条链共用**的，于是"没过的挑战"会污染整个会话，
 *     紧接着的正式抓取继续被拦 —— 表现就是"稳定爆拦截"；
 *   · 复盘页一打开就会调它（/api/review/warm），所以用户在打开复盘页之后提问就会中招。
 * 真正需要的是"失败了就重试真正的目标页"（外层 retry + 两段式可见窗口），而不是预热。
 *
 * @returns {Promise<{total:number,loggedIn:boolean,names:string[]}>}
 */
let cfWarmPromise = null;
async function warmCfSession(win) {
  if (cfWarmPromise) return cfWarmPromise;
  cfWarmPromise = (async () => {
    let total = 0; let names = [];
    try {
      const all = await win.webContents.session.cookies.get({ domain: 'codeforces.com' });
      total = all.length;
      names = all.map((c) => String(c.name));
    } catch (e) {
      diagLog('会话准备失败：' + ((e && e.message) || e));
    }
    const loggedIn = names.indexOf('X-User-Sha1') >= 0;
    diagLog('会话准备：codeforces.com cookie ' + total + ' 个 [' + names.join(',') + '] 登录态=' + loggedIn);
    return { total, loggedIn, names };
  })();
  return cfWarmPromise;
}

function ensureCfWindow(visible) {
  if (cfWindow && !cfWindow.isDestroyed()) {
    // 需要抓取时把窗口**摆在屏内并显示**（showInactive：不抢焦点，但 Chromium 不会再把它
    // 当作被遮挡而节流）——这是 Cloudflare 挑战能跑完的前提。
    if (visible) revealCfWindow(cfWindow);
    return cfWindow;
  }
  // 窗口位置与可见性策略（这是"应用内窗口频繁要过挑战"的核心修复）：
  //   · 默认：**在屏内、show:true**（用 showInactive 不抢焦点）。
  //     为什么不能在屏幕外：Chromium 会把完全离屏的窗口判定为"被遮挡"，
  //     从而节流渲染与计时器；Cloudflare 的挑战是时序敏感 JS，一被节流就过不去、并且反复重发。
  //     这就是"用户自己的浏览器一切正常、应用内窗口题解全超时"的合理解释。
  //   · CFCOACH_CF_OFFSCREEN=1 时退回旧的离屏行为（仅用于对照实验）。
  const offscreen = process.env.CFCOACH_CF_OFFSCREEN === '1';
  cfWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    ...(offscreen ? { x: -12000, y: -12000 } : {}),
    show: false,                 // 先不显示；真正需要抓取时用 showInactive 露出来（见 useCfWindow）
    title: 'CF Coach · 正在访问 Codeforces',
    skipTaskbar: !visible,
    webPreferences: {
      partition: 'persist:cfcoach-fetch',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      // ⚠️ 不要设 images:false：那是**明显的机器人指纹**（真实用户一定加载图片）。
      // 抓文本用不上图片，但这一个字段就足以让 Cloudflare 提高怀疑等级、频繁发挑战。
      images: true,
      backgroundThrottling: false
      // ⚠️ 也不要伪造 User-Agent。旧代码硬编码 "Chrome/131"，而 Electron 44 实际是 Chromium 142；
      // UA 与真实的 sec-ch-ua 客户端提示不一致时，Cloudflare 会更倾向发挑战——越伪装越可疑。
      // Electron 自带的 UA 与自身引擎版本一致，反而更"诚实"。
    }
  });
  cfWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 主框架导航计数：用来"等这一次导航真正提交"，而不是靠 sleep 猜
  // （见 waitCfCommit 的注释：不等提交会把上一个页面的状态误判成本次结果）
  try { cfWindow.webContents.on('did-navigate', () => { cfNavSeq++; }); } catch (e) { /* ignore */ }
  // 诊断：把页面标题变化与页面内 console 打到应用日志。
  // 反爬问题只能靠这个定位：挑战页自己会报错/重试，光看"timeout"什么也看不出来。
  if (process.env.CFCOACH_DEBUG_EDITORIAL) {
    try {
      cfWindow.webContents.on('console-message', (e, level, message) => {
        const m = String(message || '').slice(0, 200);
        if (m) console.log('[cf:page] ' + m);
      });
      cfWindow.webContents.on('page-title-updated', (e, title) => {
        console.log('[cf:title] ' + title);
      });
      cfWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
        console.log('[cf:fail] ' + code + ' ' + desc + ' ' + url);
      });
      cfWindow.webContents.on('render-process-gone', (e, details) => {
        console.log('[cf:gone] ' + JSON.stringify(details));
      });
    } catch (e) { /* ignore */ }
  }
  console.log('[cf] 抓取窗口已创建（images=on / UA=Electron 原生 / 在屏显示 / 关闭遮挡节流）');
  return cfWindow;
}

/**
 * 把抓取窗口摆到**屏幕内**并显示出来（用 showInactive 不抢焦点）。
 *
 * 这是整个反爬链路里最关键的一步。踩过的坑（用户实测反馈："我浏览器打开 CF 完全正常，
 * 但应用内窗口频繁要过挑战、题解全超时"）：
 *   · 旧实现把窗口放在 (-12000, -12000) 并 show:false —— 完全离屏的窗口会被 Chromium
 *     判定为"被遮挡"，渲染与计时器被节流；Cloudflare 的挑战是时序敏感 JS，
 *     被节流就跑不完，于是**反复重发挑战**、每次抓取都超时。
 *   · 只有真正"在屏幕上、有渲染帧"的窗口，挑战才会像普通浏览器那样顺利通过。
 * 窗口只在抓取期间出现，抓完可以关掉（用户会看到一个标题写着"正在访问 Codeforces"的窗口，
 * 这是刻意的：透明度比偷偷摸摸更重要）。
 */
function revealCfWindow(win) {
  try {
    if (!win || win.isDestroyed()) return;
    if (process.env.CFCOACH_CF_OFFSCREEN === '1') { win.showInactive(); return; }
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const w = Math.min(1180, Math.max(720, wa.width - 120));
    const h = Math.min(820, Math.max(520, wa.height - 120));
    win.setSize(w, h);
    // 靠右下角摆，尽量不遮住应用主窗口的正文区
    win.setPosition(wa.x + Math.max(20, wa.width - w - 60), wa.y + Math.max(20, wa.height - h - 60));
    if (win.isMinimized()) win.restore();
    win.showInactive();
    try { win.setSkipTaskbar(false); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

/** 让抓取窗口"像一个真实在用的浏览器窗口"（在屏内、非最小化、有焦点）——挑战过关率的关键 */
function bringCfWindowOnScreen(win) {
  try {
    if (!win || win.isDestroyed()) return;
    revealCfWindow(win);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.moveTop();
  } catch (e) { /* ignore */ }
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
    // 注册「提交源码」抓取通道：赛后复盘要看学员自己的提交代码，而提交页同样在 Cloudflare 后面。
    // 与题面通道共用同一个内嵌窗口（persist 分区里的 cf_clearance 是两者共享的，重开窗口等于重新过一次挑战）。
    try {
      setSubmissionBrowserFetch(fetchSubmissionSource);
    } catch (e) {
      console.log('[cf] 注册提交源码抓取通道失败: ' + e.message);
    }
    // 注册「官方题解」抓取通道：题解页同样在 Cloudflare 后面。
    // 注意：**不是每道题都有题解**，抓不到就如实报 no-tutorial-link，界面显示"本题没有官方题解"。
    try {
      setEditorialBrowserFetch(fetchEditorial);
    } catch (e) {
      console.log('[cf] 注册题解抓取通道失败: ' + e.message);
    }
    // 反爬挑战的人工兜底（打开可见窗口过一次挑战）——抓取反复 timeout 时的唯一可靠出路
    try {
      setChallengeWindowOpener(openChallengeWindow);
    } catch (e) {
      console.log('[cf] 注册人工兜底通道失败: ' + e.message);
    }
    // 注册「会话预热」通道：复盘页一打开就调用，把"新进程第一个 CF 请求容易被拒"这笔开销
    // 提前花在用户挑题的时候（幂等，一个进程只真正做一次）
    try {
      setCfWarmOpener(() => warmCfSession(ensureCfWindow(false)));
    } catch (e) {
      console.log('[cf] 注册会话预热通道失败: ' + e.message);
    }
    // 登录通道：CF 要求登录后才能看提交源码，所以这条是"取源码"能否成功的关键
    try {
      setCfLoginOpener(openCfLogin);
    } catch (e) {
      console.log('[cf] 注册登录通道失败: ' + e.message);
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
    // 先把抓取窗口彻底销毁：仅清 cookie 不够，窗口创建时的配置（images/UA/位置）
    // 是**建窗时固定**的，想换配置必须重建窗口（诊断/修复反爬问题时靠这个）。
    try {
      if (cfWindow && !cfWindow.isDestroyed()) { cfWindow.destroy(); }
      cfWindow = null;
    } catch (e) { /* ignore */ }
    const ses = session.fromPartition('persist:cfcoach-fetch');
    await ses.clearStorageData();
    await ses.clearCache();
    console.log('[cf] 抓取会话已清理（窗口已销毁，下次抓取会用新配置重建）');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------------- Codeforces 单条提交源码抓取 ---------------- */

/**
 * 为什么单独开一条通道，而不是走 lib/cf.js 的题面通道：
 *  1) 源码在**渲染后的 DOM** 里（高亮把每个 token 包成 <span>），要的是 textContent，不是 HTML 字符串；
 *  2) "页面不存在"和"页面被抓到了"落地长得一样 —— 不存在的提交会被 302 到首页 `/`，
 *     而 Cloudflare 挑战通过后也会把落地页甩到 `/`，只能靠"再导航一次"区分（见 CF_SUBMISSION_NAV_TRIES）；
 *  3) 必须守 CF 的限速（≤1 请求 / 2 秒）。
 * 传输层仍然只有一条路：**非 headless** 的真实 Chromium（实测 --headless 会被 Cloudflare 识别；
 * 普通 HTTP 拿到的 HTML 页一律是 403 + cf-mitigated: challenge），所以复用 ensureCfWindow 的
 * persist:cfcoach-fetch 分区，顺带复用题面抓取已经拿到的 cf_clearance cookie。
 */
const CF_SUBMISSION_TIMEOUT_MS = 45000;   // 整体上限：与题面抓取同量级，界面不能无限等
const CF_SUBMISSION_ATTEMPT_MS = 22000;   // 单次导航最多等这么久（两次导航正好卡在整体上限内）
const CF_SUBMISSION_NAV_TRIES = 2;        // 第二次导航用于区分"挑战跳首页"与"这条提交真的不存在"
const CF_SUBMISSION_POLL_MS = 700;        // DOM 轮询间隔（与题面抓取同节奏）
const CF_SUBMISSION_NAV_GAP_MS = 2500;    // 两次导航之间的最小间隔：CF 要求 ≤1 请求 / 2 秒，留 500ms 余量

/** 上一次提交页导航时间（模块级）。只作用于本通道：题面抓取是用户逐个触发且自带轮询节奏，不去动它。 */
let lastSubmissionNavAt = 0;

function waitSubmissionNavGap() {
  const wait = CF_SUBMISSION_NAV_GAP_MS - (Date.now() - lastSubmissionNavAt);
  if (wait <= 0) return Promise.resolve();
  console.log('[cf] 提交页抓取节流：等待 ' + wait + 'ms（Codeforces 限速 ~1 请求 / 2 秒）');
  return new Promise((r) => setTimeout(r, wait));
}

/**
 * 落地 URL 是否就是这条提交。
 *
 * 实测：Codeforces 对同一条提交提供**多个等价路径**，不能只认 `/contest/...`：
 *   /contest/<cid>/submission/<sid>
 *   /problemset/submission/<cid>/<sid>
 *   /gym/<cid>/submission/<sid>
 * 早先只认第一种，于是 CF 把请求规范化到第二种时被判成"提交不存在"（返回 not-found），
 * 用户看到的现象就是"有时候取不到源码"。所以这里按 **submissionId** 匹配，路径形状放宽。
 */
function submissionLandingOk(landing, contestId, submissionId) {
  try {
    const p = new URL(String(landing)).pathname.replace(/\/+$/, '');
    if (!p.includes('/submission/')) return false;
    // 只要落在包含 submissionId 的提交类路径上就算命中（末尾段必须是这条提交）
    const last = p.split('/').filter(Boolean).pop() || '';
    return last === String(submissionId);
  } catch (e) {
    return false;   // 空 URL / 非法 URL 一律当作"不是提交页"
  }
}

/**
 * 页面探针：一次 executeJavaScript 把需要的 DOM 事实全部取回（少走 IPC 往返）。
 * 每个字段都独立降级为 null —— 某个选择器失配不该让整次抓取失败。
 */
const PROBE_SUBMISSION_PAGE = `(function () {
  var q = function (s) { return document.querySelector(s); };
  var flat = function (el) { return el ? (String(el.textContent || '').replace(/\\s+/g, ' ').trim() || null) : null; };
  // 提交信息表：按"行首单元格文本"匹配 Language / Verdict 行（CF 改版一般只动 class，这张表的语义很稳）
  var rowText = function (label) {
    var want = String(label).toLowerCase();
    var trs = document.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var tds = trs[i].children || [];
      if (tds.length < 2) continue;
      var head = String(tds[0].textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (head === want) return flat(tds[1]);
    }
    return null;
  };
  var pre = q('#program-source-text')
    || q('pre.program-source.prettyprint')
    || q('pre.prettyprint');
  // 源码取 textContent 而不是 innerHTML：CF 的源码块把每个 token 包在 <span class="…"> 里，
  // innerHTML 会带回满屏高亮标签，以及 &lt; &amp;&amp; 这类 HTML 实体 —— 喂给模型/编辑器全是噪声；
  // textContent 才是用户看到的源码原文（含换行）。
  var code = pre ? String(pre.textContent) : null;
  var langRow = rowText('Language');
  var verdictRow = rowText('Verdict');
  var verdictEl = q('span.verdict-accepted, span.verdict-rejected, span.verdict-waiting') || q('[class*="verdict-"]');
  var title = String(document.title || '');
  // 反爬挑战页也会以目标 URL 提供（403 + cf-mitigated），必须能把它和真实页面区分开
  var challenge = /just a moment|attention required|checking your browser/i.test(title)
    || !!q('#challenge-running') || !!q('#challenge-stage') || !!q('#cf-challenge-running');
  // "这页面确实是提交页"的证据：源码块 / 信息表里的 Language·Verdict 行 / 标题含 Submission / 提交页容器。
  // 用来区分"Source: N/A 的提交页"（正常状态）与"页面压根没渲染出来"（超时）。
  var marker = !!(pre || langRow || verdictRow || q('.submission-view') || q('.submission-info')
    || /submission/i.test(title));
  return {
    ready: document.readyState,
    challenge: challenge,
    marker: marker,
    code: code,
    lang: langRow,
    langClass: pre ? String(pre.className || '') : '',
    verdict: verdictEl ? flat(verdictEl) : verdictRow,
    problem: flat(q('a[href*="/problem/"]')),
    // 页面正文片段：用来识别"无权查看"这类**由 CF 明确告知**的拒绝页
    // （它不是挑战页、也不是 404，只看 marker/URL 是分不出来的）
    pageText: String(document.body ? document.body.innerText : '').slice(0, 400)
  };
})()`;

/** CF 的"无权查看"页判定（未登录时看提交源码就是这一页） */
function isNotAllowedPage(state) {
  const t = String((state && state.pageText) || '');
  return /not allowed to view|You are not allowed|没有权限查看|无权查看/i.test(t);
}

/**
 * 抓取单条提交的源码。永不对渲染进程抛异常，只回对象：
 *   成功         { ok: true, code, lang, verdict, problem, url }
 *   页面在但没源码 { ok: false, reason: 'source-unavailable', hint }
 *   不存在/不可见  { ok: false, reason: 'not-found' }
 *   超时/其它错误  { ok: false, reason: 'timeout' | '<短消息>' }
 * lang / verdict / problem 都是 best-effort，取不到给 null（不算失败）。
 */
/**
 * Codeforces 会为"无权查看的页面"返回一个专用页面：
 *   "You are not allowed to view the requested page"
 * 实测：**未登录时查看提交源码**就是这条（不是挑战页、也不是 404）。
 * 一旦遇到，就该停下来告诉用户"去登录"，而不是继续弹窗口重试 ——
 * 每抓一条提交弹一次窗口，用户看到的就是"界面一直在弹提示"（真实反馈）。
 */
let cfPermissionDenied = false;

/**
 * 抓取单条提交的源码。永不对渲染方抛异常，只回对象。
 *
 * ⚠️ **外层带一次重试**，这是实测必需的：
 * 新进程里的**第一次**抓取经常落在首页（会话/cookie 还没热起来），紧接着第二次就正常了
 * （实测：第 1 次 ✗ → 第 2、3 次 ✓）。旧实现第一发失败就直接回 not-found，
 * 用户看到的就是"有时候第一条取不到"。
 */
async function fetchSubmissionSourceOnce(input) {
  const o = input || {};
  const contestId = String(o.contestId == null ? '' : o.contestId).trim();
  const submissionId = String(o.submissionId == null ? '' : o.submissionId).trim();
  diagLog('抓源码单次进入 sub=' + submissionId + ' contest=' + contestId + ' deniedLatch=' + cfPermissionDenied);
  if (!/^\d{1,12}$/.test(contestId) || !/^\d{1,12}$/.test(submissionId)) {
    console.log('[cf] 提交源码抓取参数不合法: contestId=' + contestId + ' submissionId=' + submissionId);
    return { ok: false, reason: '参数不合法：contestId / submissionId 必须是数字' };
  }
  // 已知没有权限：直接返回，不再导航、不再弹窗口（批量抓取时这一点尤其重要）
  if (cfPermissionDenied) {
    return {
      ok: false, reason: 'not-allowed',
      hint: 'Codeforces 拒绝了访问（未登录）。请点复盘页的「🔑 登录 Codeforces」登录一次，'
        + '之后抓源码都会正常；也可以直接把代码粘过来。'
    };
  }
  const url = 'https://codeforces.com/contest/' + contestId + '/submission/' + submissionId;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + CF_SUBMISSION_TIMEOUT_MS;
  let landing = '';
  let state = null;
  let warm = { loggedIn: true, total: -1 };
  try {
    const win = ensureCfWindow(false);
    applyCfProxy(win.webContents.session);
    // 先预热会话（等 cookie 装载完 + 用首页导航消耗掉"冷启动第一枪"），否则第一条必然被判失败
    warm = await warmCfSession(win);
    for (let nav = 1; nav <= CF_SUBMISSION_NAV_TRIES && Date.now() < deadline; nav++) {
      // 实测（同 lib/cf.js 的两段式兜底注释）：隐藏窗口的挑战通过率低于"可见但在屏幕外"的窗口。
      // 第一次仍用隐藏窗口（安静），失败后第二次切成屏幕外的可见窗口 —— 定位仍由 ensureCfWindow 管。
      if (nav > 1) ensureCfWindow(true);
      await waitSubmissionNavGap();
      lastSubmissionNavAt = Date.now();
      console.log('[cf] 提交页导航 #' + nav + '（' + (nav > 1 ? '屏幕外可见窗口' : '隐藏窗口') + '）: ' + url);
      // 只等"这一次导航结束"，不用 did-finish-load 判成功：挑战页自己也会触发 did-finish-load，
      // 之后 CF 还会再跳一次（跳到 `/` 或目标页）。成败一律交给下面的 DOM 轮询。
      const beforeSeq = cfNavSeq;
      try { await win.loadURL(url); } catch (e) { console.log('[cf] 提交页加载中断（' + ((e && e.message) || e) + '），继续看落地页'); }
      // ⚠️ 关键：等新文档真正提交再判断。否则 getURL()/readyState 都是**上一个页面**的，
      // 上一个页面常常正好是首页 `/`，会被立刻误判为"提交不存在"（详见 waitCfCommit 注释）。
      const committed = await waitCfCommit(win, beforeSeq, 12000);
      if (!committed) diagLog('导航 #' + nav + ' 等待提交超时（12s）：' + url);
      const attemptDeadline = Math.min(deadline, Date.now() + CF_SUBMISSION_ATTEMPT_MS);
      let sawChallenge = false;
      while (Date.now() < attemptDeadline) {
        await sleep(CF_SUBMISSION_POLL_MS);
        try { landing = win.webContents.getURL() || ''; } catch (e) { landing = ''; }
        try { state = await win.webContents.executeJavaScript(PROBE_SUBMISSION_PAGE); } catch (e) { state = null; continue; }
        const onTarget = submissionLandingOk(landing, contestId, submissionId);
        if (state.challenge) { sawChallenge = true; continue; }   // 反爬挑战还在跑：接着等
        // 无权查看（未登录）：立刻判定并**记住**，不再重试、不再弹窗口
        if (isNotAllowedPage(state)) {
          cfPermissionDenied = true;
          diagLog('提交页无权查看（未登录）：' + url + ' text=' + JSON.stringify(String(state.pageText || '').slice(0, 120)));
          return {
            ok: false, reason: 'not-allowed',
            hint: 'Codeforces 提示 "You are not allowed to view the requested page" —— 这是**未登录**导致的。'
              + '请点复盘页的「🔑 登录 Codeforces」登录一次（登录态会保留），之后抓源码都会正常；'
              + '也可以直接把代码粘过来。'
          };
        }
        if (state.marker && onTarget) break;                  // 真正的提交页到手
        // 已稳定落在非提交页（且不是挑战页）→ 就是"提交不存在被 302 到首页"，
        // 没必要把单次预算耗光；"再试一次"还是"判不存在"交给外层决定。
        // 三个附加条件都是防"拿旧页面状态误判"：必须已提交过、确实有落地页、且当前不在加载中。
        if (state.ready === 'complete' && !onTarget && committed && landing
          && !/^about:/.test(landing) && !win.webContents.isLoading()) break;
      }
      diagLog('导航 #' + nav + ' 结束 sub=' + submissionId + ' 落地=' + landing
        + ' onTarget=' + submissionLandingOk(landing, contestId, submissionId)
        + ' 见过挑战=' + sawChallenge + ' ready=' + ((state && state.ready) || '')
        + ' marker=' + !!(state && state.marker));
      if (state && state.marker && submissionLandingOk(landing, contestId, submissionId)) break;
    }

    const landingOk = submissionLandingOk(landing, contestId, submissionId);
    // 关键：不存在的提交会被 302 到首页 `/`（或登录页）。
    // 绝不能把首页 HTML 当成源码回上去 —— 否则上层会把整页导航栏/侧边栏当代码喂给模型或编辑器。
    if (!landingOk) {
      // 诊断：把真实落地页 + 登录态记下来。只看"not-found"三个字根本分不清
      // "提交真的不存在"、"被 302 到首页"、还是"落到了别的等价路径而我没认出来"。
      diagLog('提交落地页不匹配: landing=' + landing + ' wantSub=' + submissionId + ' marker=' + !!(state && state.marker)
        + ' 登录态=' + warm.loggedIn + ' cf-cookie=' + warm.total);
      // 没登录就直说"没登录"：重试、换窗口都没用，让用户去点一次登录才是出路
      return { ok: false, reason: warm.loggedIn ? 'not-found' : 'not-allowed', landing: landing };
    }
    if (!state || !state.marker) {
      console.log('[cf] 提交页未渲染出提交结构（落地 ' + landing + '）: ' + url);
      return { ok: false, reason: 'timeout' };
    }
    let lang = state.lang || null;
    const langClass = String(state.langClass || '').trim();
    if (!lang && langClass) {
      // pre 的 class 形如 "program-source prettyprint lang-cpp"：有 lang-* token 就取它，否则退回原始 class
      const m = langClass.match(/\blang-[a-z0-9+#-]+/i);
      lang = m ? m[0] : (langClass || null);
    }
    const code = state.code == null ? '' : String(state.code);
    if (!code.trim()) {
      // CF 上确实存在「提交页正常、但没有源码」的状态（页面显示 Source: N/A，官方已知问题）。
      // 这是正常状态而不是崩溃：如实返回，让上层提示用户去 CF 站内看。
      console.log('[cf] 提交页无源码（Source: N/A）: ' + url);
      return {
        ok: false,
        reason: 'source-unavailable',
        hint: '该提交页没有可读源码（Codeforces 显示 Source: N/A，常见于官方数据缺失或源码未公开）。可用系统浏览器打开该提交页查看。'
      };
    }
    console.log('[cf] 提交源码抓取成功: ' + url + '（' + code.length + ' 字符，语言 ' + (lang || '未知')
      + '，判定 ' + (state.verdict || '未知') + '，题目 ' + (state.problem || '未知') + '）');
    // url 固定回规范请求地址（调用方可直接拿去打开/展示），真实落地页写在日志里
    return { ok: true, code: code, lang: lang, verdict: state.verdict || null, problem: state.problem || null, url: url };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[cf] 提交源码抓取失败: ' + url + ' → ' + msg);
    return { ok: false, reason: msg.slice(0, 160) };
  }
}

/**
 * 对外入口：抓提交源码，**失败时重试一次**。
 *
 * 为什么必须重试（实测数据）：全新进程里连续抓三次 →
 *   第 1 次 ✗（落在首页）→ 第 2 次 ✓ → 第 3 次 ✓
 * 也就是第一次抓取时抓取会话还没"热"（cookie/连接建立中），紧接着重试就成功。
 * 旧实现第一发失败就返回 not-found，用户看到的就是"偶尔取不到源码"。
 * 这里只在**可重试**的失败上重试：not-found / timeout 重试一次；not-allowed（未登录）不重试。
 */
async function fetchSubmissionSource(input) {
  const sid = input && input.submissionId;
  const t0 = Date.now();
  const first = await fetchSubmissionSourceOnce(input);
  diagLog('抓源码外层次 #1 sub=' + sid + ' ok=' + !!first.ok + ' reason=' + ((first && first.reason) || '')
    + ' landing=' + ((first && first.landing) || '') + ' 用时=' + (Date.now() - t0) + 'ms');
  if (first.ok) return first;
  if (first.reason === 'not-allowed') return first;
  console.log('[cf] 提交源码首次失败（' + first.reason + '）→ 重试一次');
  await new Promise((r) => setTimeout(r, 1200));
  const t1 = Date.now();
  const second = await fetchSubmissionSourceOnce(input);
  diagLog('抓源码外层次 #2（重试） sub=' + sid + ' ok=' + !!second.ok + ' reason=' + ((second && second.reason) || '')
    + ' landing=' + ((second && second.landing) || '') + ' 用时=' + (Date.now() - t1) + 'ms');
  if (second.ok) {
    console.log('[cf] 重试成功（说明首次失败只是会话未热）');
    return second;
  }
  return second;
}

/** 抓取单条提交源码的 IPC 通道（与 cf-clear-session 同形：只回对象，绝不把异常抛回渲染进程） */
ipcMain.handle('cf-fetch-submission', async (e, payload) => {
  try {
    // 与题解共用同一个浏览器窗口 → 也必须共用串行队列，否则两次导航会互相打断
    return await withBrowserNav(() => fetchSubmissionSource(payload));
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.log('[cf] 提交源码通道异常: ' + msg);
    return { ok: false, reason: msg.slice(0, 160) };
  }
});

/* ---------------- 官方题解（Editorial）抓取 ---------------- */

/**
 * 题解在 Codeforces 上的形态（逆向自 CF 的页面结构，**两段式发现**）：
 *
 *   ① 题目页侧边栏有一个 "Contest materials" 圆角框，里面可能有 `Tutorial` 链接，
 *      指向 `/blog/entry/<id>`。**不是每道题/每场比赛都有**——老比赛常没有，所以这里天然是"尽力而为"。
 *      侧边栏选择器是 `.roundbox.sidebox`，但 CF 改版会动 class，所以再加一条
 *      "题目页里任何指向 /blog/entry/ 的链接"作为兜底。
 *   ② 那个 blog entry 是**整场比赛的题解**（一篇讲 A~F）。正文里按题分节
 *      （`<h3>A. 标题</h3>` 这类，或 `<strong>A</strong>` / `Problem A`），
 *      有时还套一层 CF 自己的折叠框（`.spoiler`）。
 *
 * 关键取舍：**找不到就如实说找不到**，绝不猜、绝不把别的题的小节塞过来。
 * 上层（复习界面）据此显示"本题没有官方题解"，而不是拿一篇不相干的文章糊弄学员。
 */

const CF_EDITORIAL_TIMEOUT_MS = 100000;   // 整体上限（单次调用）
const CF_EDITORIAL_NAV_GAP_MS = 2500;

/**
 * 浏览器通道的**全局串行队列**。
 *
 * 为什么必须有：复盘要逐题抓题解/源码，如果并发发起多个导航，同一个内嵌窗口会被
 * 多次 loadURL 抢用（后一次导航打断前一次的 Cloudflare 挑战）—— 结果是全部超时，
 * 用户看到"等了十分钟没反应"。
 * 所以：同一时刻只允许一个浏览器操作在跑，后来者排队（而不是失败）。
 * 单次调用自带超时，所以队列不会被某项永久卡住。
 *
 * ⚠️ 注意：这个锁**不跨进程**。web 模式（node server.js）没有浏览器通道，用不到。
 */
let browserNavLock = Promise.resolve();
function withBrowserNav(fn) {
  const run = browserNavLock.then(fn, fn);
  browserNavLock = run.then(() => undefined, () => undefined);
  return run;
}
let lastEditorialNavAt = 0;

function waitEditorialNavGap() {
  const wait = CF_EDITORIAL_NAV_GAP_MS - (Date.now() - lastEditorialNavAt);
  if (wait <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, wait));
}

/** 导航到一个页面并轮询到"真实页面渲染完成"（挑战页会被识别出来继续等） */
async function gotoAndProbe(url, probeExpr, opts) {
  const o = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + (o.timeoutMs || CF_EDITORIAL_TIMEOUT_MS);
  const tries = o.tries || 2;
  const win0 = ensureCfWindow(false);
  applyCfProxy(win0.webContents.session);
  const sameUrl = (a, b) => String(a || '').split('?')[0].replace(/\/+$/, '') === String(b || '').split('?')[0].replace(/\/+$/, '');

  // ⓪ 快路径：窗口**已经停在这个页面上**（比如刚用过人工兜底窗口）→ 直接探测，不重新导航。
  //    为什么关键：重复 loadURL 会让 Cloudflare **重新发一次挑战**，而挑战在隐藏窗口里经常不过。
  //    实测（同一 URL）：人工可见窗口能瞬间落地（finalUrl 就是目标页），
  //    而自动化"再导航一次"却 timeout —— 差别就在有没有重新触发挑战。
  try {
    const cur = win0.webContents.getURL() || '';
    if (sameUrl(cur, url)) {
      const st0 = await win0.webContents.executeJavaScript(probeExpr);
      if (st0 && !st0.challenge && st0.ready === 'complete' && st0.marker) {
        console.log('[cf] 复用已打开的页面（跳过重复导航）: ' + url);
        return { landing: cur, state: st0, cfWindow: win0 };
      }
    }
  } catch (e) { /* 探测失败就当没命中，走正常导航 */ }

  // ⓪' 会话预热（每个进程只做一次，幂等）：把"新进程第一枪必然被 CF 拒"消耗在首页上。
  //     放在快路径之后：万一窗口已经停在目标页（人工兜底窗口刚用过），不能被预热导航带走。
  try { await warmCfSession(win0); } catch (e) { /* 预热失败不阻塞抓取 */ }

    // 人工兜底窗口一旦显示过，同一会话分区里就已有 cf_clearance；
    //    这时优先用**屏内可见窗口**导航（命中率明显更高，且没有额外代价）。
  let preferVisible = false;
  try { preferVisible = !!(cfWindow && !cfWindow.isDestroyed() && cfWindow.isVisible()); } catch (e) { preferVisible = false; }
  if (preferVisible) {
    // 已经进入"人工兜底"模式：把窗口摆到屏内，别再放屏幕外——离屏窗口会被当作被遮挡而节流
    bringCfWindowOnScreen(cfWindow);
  }

  let landing = '';
  let state = null;
  for (let nav = 1; nav <= tries && Date.now() < deadline; nav++) {
    const win = (preferVisible || nav > 1) ? ensureCfWindow(true) : win0;
    void win0;
    await waitEditorialNavGap();
    lastEditorialNavAt = Date.now();
    console.log('[cf] 题解页导航 #' + nav + (win !== win0 ? '（屏幕外可见窗口）' : '（隐藏窗口）') + ': ' + url);
    // 只等"这一次导航结束"，不用 did-finish-load 判成功：挑战页自己也会触发 did-finish-load，
    // 之后 CF 还会再跳一次（跳到 target 或站点根）。成败一律交给下面的 DOM 轮询。
    try { await win.loadURL(url); } catch (e) { console.log('[cf] 题解页加载中断（' + ((e && e.message) || e) + '），继续看落地页'); }
    if (process.env.CFCOACH_DEBUG_EDITORIAL) {
      try { await win.webContents.executeJavaScript('window.__cfEditorialDebug = true;'); } catch (e) { /* ignore */ }
    }
    const attemptDeadline = Math.min(deadline, Date.now() + (o.attemptMs || 26000));
    let polls = 0;
    while (Date.now() < attemptDeadline) {
      await sleep(700);
      polls++;
      try { landing = win.webContents.getURL() || ''; } catch (e) { landing = ''; }
      try {
        // 把探针包一层 try/catch 再交给渲染进程执行。
        // 直接 executeJavaScript(probeExpr) 时，探针内部一旦抛错，Electron 只会回一句
        // "Script failed to execute"，**看不到真正的错误**（为了这句废话我排查了很久）。
        // 包一层之后，错误信息会作为正常返回值带回来。
        const wrapped = '(function(){ try { return { __ok: true, value: (' + probeExpr + ') }; }'
          + ' catch (e) { return { __ok: false, error: String(e && (e.message || e)), stack: String(e && e.stack || "").split("\\n").slice(0,3).join(" | ") }; } })()';
        const res = await win.webContents.executeJavaScript(wrapped);
        if (res && res.__ok === false) {
          diagLog('probe 抛错: ' + res.error + ' @ ' + res.stack);
          state = null;
          continue;
        }
        state = res ? res.value : null;
      } catch (e) {
        diagLog('executeJavaScript 失败: ' + ((e && e.message) || e));
        state = null;
        continue;
      }
      if (!state) continue;
      // 诊断：每次轮询都记一行（挑战页的标题/可见性/正文长度是判断"卡在哪"的唯一线索）
      if (polls % 4 === 1) {
        let title = '';
        try { title = await win.webContents.executeJavaScript('document.title'); } catch (e) { /* ignore */ }
        diagLog('poll#' + nav + '/' + polls + ' url=' + landing + ' title=' + JSON.stringify(title)
          + ' challenge=' + !!state.challenge + ' marker=' + !!state.marker + ' ready=' + state.ready
          + ' visible=' + (() => { try { return win.isVisible(); } catch (e) { return '?'; } })());
      }
      if (state.challenge) continue;         // 反爬挑战还在跑
      // 就绪判定：
      //   ① 常规：DOM 完成且页面有内容标记；
      //   ② **正文已渲染**：如果调用方给了 isReady，就用它来判断"真正要的东西出现了没有"。
      //      为什么需要 ②：CF 的题解块是渲染出来的，DOM ready 之后还会再补一段，
      //      只看 ready+marker 会**过早收工**，于是遇到"页面在、正文还没出来"的间歇性失败
      //      （实测：同样一题时好时坏，耗时只有 2~3 秒 —— 那是没等它渲染完）。
      if (state.ready === 'complete' && state.marker) {
        if (!o.isReady || o.isReady(state)) break;
        if (polls % 4 === 1) diagLog('已就绪但正文未到齐，继续等（polls=' + polls + '）');
      }
    }
    diagLog('nav#' + nav + ' 结束: landing=' + landing + ' marker=' + !!(state && state.marker)
      + ' challenge=' + !!(state && state.challenge));
    // 页面结构诊断：**这才是定位"页面明明加载了但 marker=false"的唯一手段**
    // （实测教训：一直以为是 Cloudflare 挑战没过，实际是页面到手了、但我的选择器没命中）
    if (!(state && state.marker)) {
      try {
        const info = await win.webContents.executeJavaScript(`(function(){
          var chainOf = function (el) {
            var out = [];
            var cur = el;
            for (var d = 0; d < 7 && cur; d++) {
              var c = String(cur.className || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
              out.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (c ? '.' + c : '')
                + '(' + String(cur.textContent || '').length + ')');
              cur = cur.parentElement;
            }
            return out.join(' < ');
          };
          // 找正文里最大的那个 spoiler（题解块），沿祖先链看它挂在谁下面
          var sps = document.querySelectorAll('.spoiler');
          var best = null, bestLen = 0;
          for (var i = 0; i < sps.length; i++) {
            var len = String(sps[i].textContent || '').length;
            if (len > bestLen) { bestLen = len; best = sps[i]; }
          }
          var ttyp = document.querySelectorAll('.ttypography');
          var bigTtyp = null, bigLen = 0;
          for (var j = 0; j < ttyp.length; j++) {
            var l2 = String(ttyp[j].textContent || '').length;
            if (l2 > bigLen) { bigLen = l2; bigTtyp = ttyp[j]; }
          }
          return {
            title: document.title,
            url: location.href,
            hasTopic: !!document.querySelector('.topic'),
            hasPostText: !!document.querySelector('.post__text'),
            hasContentWithSidebar: !!document.querySelector('.content-with-sidebar'),
            spoilers: sps.length,
            biggestSpoilerChain: best ? chainOf(best) : null,
            biggestSpoilerHasLetterLink: best ? !!best.querySelector('a[href*="/problem/"]') : false,
            biggestSpoilerHead: best ? String(best.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : null,
            biggestTtypChain: bigTtyp ? chainOf(bigTtyp) : null,
            biggestTtypHead: bigTtyp ? String(bigTtyp.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : null
          };
        })()`);
        diagLog('pageinfo: ' + JSON.stringify(info));
      } catch (e) { diagLog('pageinfo 失败: ' + e.message); }
    }
    if (state && state.marker && !state.challenge) break;
  }
  return { landing: landing, state: state, cfWindow: ensureCfWindow(false) };
}

/** ① 从题目页侧边栏找题解链接 */
const PROBE_PROBLEM_MATERIALS = `(function () {
  var flat = function (el) { return el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; };
  var title = String(document.title || '');
  var challenge = /just a moment|attention required|checking your browser/i.test(title)
    || !!document.querySelector('#challenge-running') || !!document.querySelector('#challenge-stage');
  var marker = !!document.querySelector('.problem-statement') || /problem/i.test(title);
  // 侧边栏的 Contest materials 框：优先在它内部找；找不到就退回"整页任何 blog/entry 链接"
  var boxes = document.querySelectorAll('.roundbox.sidebox, .sidebox');
  var candidates = [];
  var push = function (a) {
    if (!a) return;
    var href = String(a.getAttribute('href') || '');
    var m = href.match(/\\/blog\\/entry\\/(\\d+)/);
    if (!m) return;
    var label = flat(a);
    if (candidates.some(function (c) { return c.id === m[1]; })) return;
    candidates.push({ id: m[1], label: label, href: href });
  };
  for (var i = 0; i < boxes.length; i++) {
    var txt = flat(boxes[i]).toLowerCase();
    if (txt.indexOf('contest materials') < 0 && txt.indexOf('tutorial') < 0) continue;
    var as = boxes[i].querySelectorAll('a');
    for (var j = 0; j < as.length; j++) push(as[j]);
  }
  if (!candidates.length) {
    var all = document.querySelectorAll('a[href*="/blog/entry/"]');
    for (var k = 0; k < all.length; k++) push(all[k]);
  }
  // 优先认 label 里写着 Tutorial/Editorial 的（侧边栏里同时可能有 announcement 等链接）
  candidates.sort(function (a, b) {
    var score = function (c) { return /tutorial|editorial|题解/i.test(c.label) ? 0 : 1; };
    return score(a) - score(b);
  });
  return {
    ready: document.readyState,
    challenge: challenge,
    marker: marker,
    hasContestMaterials: boxes.length > 0,
    tutorial: candidates.length ? candidates[0] : null,
    all: candidates.slice(0, 6)
  };
})()`;

/**
 * ② 从 blog entry 抽正文 —— **按结构抽**，不是整页打平。
 *
 * 真实结构（实测 entry/94581 得到，跑之前靠猜是错的）：
 *   div.topic.has-topic-id                       ← 主楼（评论区是 .post__text，绝不能取它）
 *     div.title > a[href="/blog/entry/N"] > p    ← 标题
 *     div.content > div.ttypography             ← 正文
 *        p（开场白）
 *        p > a[href="/contest/1567/problem/A"]   ← 题目链接
 *        div.spoiler
 *          b.spoiler-title                        ← "Solution"
 *          div.spoiler-content
 *            div > h3 > a[href=".../problem/A"]   ← **本题题号在链接里**
 *            div.ttypography > ...                ← 本题正文（含 MathJax 噪声）
 *
 * 所以：一个 spoiler = 一道题，题号从 h3 里的链接 href 取（比从标题文本猜可靠得多）。
 * 早先的版本把整页 textContent 打平，结果 MathJax 的重复字形把行结构全冲掉，
 * 切分自然失败（sliced=false），而且抓到的还可能是评论。
 */
const PROBE_EDITORIAL_BODY = `(function () {
  var flat = function (el) { return el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; };
  var title = String(document.title || '');
  var challenge = /just a moment|attention required|checking your browser/i.test(title)
    || !!document.querySelector('#challenge-running') || !!document.querySelector('#challenge-stage');
  // 诊断收集数组（重写探针时漏掉过它，导致探针整个抛 ReferenceError —— 特此注明别再漏）
  var diag = [];

  /**
   * 版式无关的定位（这是被真实页面教训出来的）：
   *   · .topic 这类类名会随 CF 改版变化，但"**题解块里带一个指向 /problem/X 的链接**"
   *     是题解内容本身的语义 —— 只要它在，正文就一定渲染出来了。
   *   · 正文容器 = 那个含有这类 spoiler 的最大 .ttypography；拿不到就退回 .content。
   *
   * 实测结构（entry/157126，2026-09）：
   *   div.has-topic-id.topic > div.content > div.ttypography        ← 正文
   *     div.spoiler > div.spoiler-content > div > h3 > a[href="/contest/2267/problem/A"]
   * 注意：页面里还有一个"Did you like the problem?"的 spoiler，里面是 <script>，
   * 不含题号链接 —— 所以判定必须要求 problem 链接存在，否则会把它当成题解块。
   */
  var isSolutionSpoiler = function (sp) {
    return !!sp.querySelector('a[href*="/problem/"]');
  };
  var allSpoilers = document.querySelectorAll('.spoiler');
  var solSpoilers = [];
  for (var i = 0; i < allSpoilers.length; i++) if (isSolutionSpoiler(allSpoilers[i])) solSpoilers.push(allSpoilers[i]);

  // 正文容器：优先"含题解块的 ttypography"，兜底 content / pageContent
  var host = null;
  if (solSpoilers.length) {
    var cur = solSpoilers[0];
    while (cur && cur !== document.body) {
      if (cur.classList && cur.classList.contains('ttypography')) { host = cur; break; }
      cur = cur.parentElement;
    }
    if (!host) host = solSpoilers[0].parentElement;
  }
  if (!host) host = document.querySelector('.topic .content') || document.querySelector('.content') || document.querySelector('#pageContent');

  // marker = "题解内容真的在页面上"：有题解块，**或者**正文容器里已经有可观文本
  // （老比赛没有 spoiler 结构，是纯 h3 + 段落排版）
  var hostLen = host ? String(host.textContent || '').length : 0;
  var marker = solSpoilers.length > 0 || hostLen > 800;

  if (!host) return { ready: document.readyState, challenge: challenge, marker: false, sections: [], intro: '', html: '', diag: ['no host'] };

  var stripNoise = function (root) {
    var junk = root.querySelectorAll('script:not([type="math/tex"]):not([type="math/tex; mode=display"]), style');
    for (var k = 0; k < junk.length; k++) { if (junk[k].parentNode) junk[k].parentNode.removeChild(junk[k]); }
    return root;
  };

  /**
   * 转义辅助：本函数体**整个在模板字面量里**，所以正则里不能直接写单反斜杠 ——
   * 它会被当成转义序列：正则的空白类会被吃掉，反向引用那种写法甚至直接报
   * "Octal escape sequences are not allowed in template strings"（实测踩到）。
   * 所以凡是需要正则的地方，一律 fromCharCode(92) 拼出反斜杠再 new RegExp。
   * 注意：注释里也不要出现反斜杠或反引号，它们同样会破坏模板字面量。
   */
  var BS = String.fromCharCode(92);
  var tagRe = new RegExp('<' + '[^>]*' + '>', 'g');
  var wsRe = new RegExp(BS + 's+', 'g');

  /** 去掉一串 MathML 里的标签，只留可见符号（<msub><mi>s</mi><mi>i</mi></msub> → "si"） */
  var stripTags = function (html) {
    return String(html || '').replace(tagRe, '');
  };

  /**
   * 把数学公式换成**可读文本**，然后返回 HTML 字符串。
   *
   * 为什么必须在浏览器里做（而不是服务端用正则）：MathJax v2 的标记是
   *   <span class="MathJax" data-mathml="…">
   *     <nobr aria-hidden="true"><span class="math">…好多层嵌套 span…</span></nobr>
   *     <script type="math/tex">s_i</script>
   *   </span>
   * 嵌套层级深且不固定，用字符串/正则在服务端处理后，公式常常被整块删掉 ——
   * 正文变成 "Consider all pairs  and ."（读起来通顺、公式位全空），
   * 这比报错危险得多：模型会照着残缺句子编推导。
   * 浏览器里有真正的 DOM，"按选择器取节点 + 直接替换成文本节点"是可靠的做法。
   */
  var replaceMath = function (root) {
    // ⚠️ 选择器**只取最外层**（.MathJax / mjx-container），不要同时取里面的
    // script[type=math/tex]：那样同一个公式会被处理两次（内层 script 先被换成文本，
    // 外层再取一次时又能找到它），输出就变成公式重复两遍（实测踩到）。
    // 内层 script 的 TeX 由外层分支自己 querySelector 取。
    // 另注：本函数体在模板字面量里，注释与代码都不能出现反引号（用 fromCharCode(96) 代替）。
    var nodes = root.querySelectorAll('.MathJax, mjx-container');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (!n.parentNode) continue;
      var tex = '';
      if (n.tagName === 'SCRIPT') {
        tex = String(n.textContent || '').trim();
      } else {
        // ① 最优：内嵌的 TeX 原文（最可读，s_{n-i+1} 这种）
        var s = n.querySelector('script[type^="math/tex"]');
        if (s) tex = String(s.textContent || '').trim();
        // ② 次选：data-mathml 里的符号序列
        if (!tex) {
          var mm = String(n.getAttribute('data-mathml') || '');
          if (mm) tex = stripTags(mm).replace(wsRe, ' ').trim();
        }
        // ③ 兜底：节点自身的文本（可能是渲染出来的重复字形）
        if (!tex) tex = String(n.textContent || '').replace(wsRe, ' ').trim();
      }
      // 公式统一用反引号包起来（服务端当行内代码渲染）
      var BT = String.fromCharCode(96);
      var txt = document.createTextNode(tex ? (' ' + BT + tex + BT + ' ') : ' ');
      n.parentNode.replaceChild(txt, n);
    }
    return String(root.innerHTML || '');
  };

  var intro = '';
  var introP = host.querySelector('p');
  if (introP && solSpoilers.length) intro = flat(introP).slice(0, 400);

  var sections = [];
  for (var s = 0; s < solSpoilers.length; s++) {
    var sp = solSpoilers[s];
    var letter = null;
    var a = sp.querySelector('a[href*="/problem/"]');
    if (a) {
      var m = String(a.getAttribute('href') || '').match(new RegExp('/problem/([A-Za-z][0-9]?)'));
      if (m) letter = m[1].toUpperCase();
    }
    if (!letter) {
      var h = sp.querySelector('h1, h2, h3, h4, strong, b');
      if (h) {
        var hm = flat(h).match(/^\\s*(?:Problem\\s+|Task\\s+)?([A-Z]\\d?)\\b/);
        if (hm) letter = hm[1].toUpperCase();
      }
    }
    if (!letter) continue;
    var inner = sp.querySelector('.spoiler-content') || sp;
    // 拷贝 → 去噪 → 公式转文本 → 取 HTML（顺序不能换：公式节点要在序列化前替换掉）
    var clone = replaceMath(stripNoise(inner.cloneNode(true)));
    sections.push({
      letter: letter,
      title: flat(sp.querySelector('.spoiler-title')) || flat(inner.querySelector('h1,h2,h3,h4')) || '',
      html: String(clone)
    });
  }

  // 没有结构化题解块时，整篇正文兜底（sliced 会因此为 false，界面会如实提示）
  var wholeHtml = '';
  if (!sections.length) {
    var whole = stripNoise(host.cloneNode(true));
    var drop = whole.querySelectorAll('.comment, .comments, .reply, .replies, [id^="comment"]');
    for (var d = 0; d < drop.length; d++) { if (drop[d].parentNode) drop[d].parentNode.removeChild(drop[d]); }
    wholeHtml = replaceMath(whole);
  }

  if (window.__cfEditorialDebug) {
    var chain = [];
    var pc = host;
    for (var q = 0; q < 4 && pc; q++) {
      var c = String(pc.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
      chain.push(pc.tagName.toLowerCase() + (c ? '.' + c : ''));
      pc = pc.parentElement;
    }
    diag.push('HOST | ' + chain.join(' < ') + ' | len=' + hostLen);
    diag.push('SOLUTION_SPOILERS | ' + solSpoilers.length + ' 个（页面共 ' + allSpoilers.length + ' 个 .spoiler）；识别题号：'
      + sections.map(function (x) { return x.letter; }).join(','));
  }
  return {
    ready: document.readyState,
    challenge: challenge,
    marker: marker,
    title: String(document.title || ''),
    intro: intro,
    sections: sections,
    html: wholeHtml,
    diag: diag
  };
})()`;


/**
 * 把一段 HTML 转成可读文本、按题切分 —— 这两步已经搬到 `lib/cfreview.js`
 * （纯函数，可以单元测试；Electron 主进程的代码没法在测试里跑）。
 */
const cfReviewLib = require(path.join(ROOT_DIR, 'lib', 'cfreview.js'));

/**
 * 行级切分的结果是否**真的**是我们要的那道题。
 *
 * 为什么需要这道闸：`splitEditorialByProblem` 切不出来时会把**整篇**原样返回（sliced=false），
 * 而整篇的开头是比赛的第一题。如果调用方要的是 C 题、却把"整篇"当成 C 题交付，
 * 用户拿到的就是**A 题的题解冒充 C 题**——错误内容比没有内容危险得多（模型会照着它讲）。
 * 所以这里要求：切分结果的开头必须真的是本题的标题（"2267C …" / "C. …" / "Problem C"）。
 */
function lineSplitOk(cut, letter) {
  if (!cut || !cut.content) return false;
  const want = String(letter || '').toUpperCase();
  if (!want) return true;
  const head = String(cut.content).trim().slice(0, 200);
  // 接受：C. / C - / Problem C / 2267C / C 单独成词
  return new RegExp('(?:^|[^A-Za-z0-9])' + want + '(?![A-Za-z0-9])', 'i').test(head);
}

/**
 * 抓取某道题的官方题解。永不对调用方抛异常：
 *   { ok: true, entryId, url, content, sliced, source: 'problem-page'|'direct' }
 *   { ok: false, reason: 'no-tutorial-link' | 'not-found' | 'timeout' | '<短消息>' }
 *
 * @param {object} o contestId / index / entryId / budgetMs（本题总预算，默认 35s）
 */
function fetchEditorial(input) {
  const o = input || {};
  const budgetMs = Math.max(8000, Math.min(Number(o.budgetMs) || 35000, 100000));
  // 走全局串行队列：同一时刻只有一个浏览器操作，避免多个导航互相打断挑战
  return withBrowserNav(() => fetchEditorialInner(o, budgetMs));
}

async function fetchEditorialInner(o, budgetMs) {
  const contestId = String(o.contestId == null ? '' : o.contestId).trim();
  const letter = String(o.index == null ? '' : o.index).trim().toUpperCase();
  const entryId = o.entryId ? String(o.entryId).trim() : '';
  if (!entryId && (!/^\d{1,12}$/.test(contestId) || !/^[A-Z]\d?$/.test(letter))) {
    return { ok: false, reason: '参数不合法：需要 contestId + index（或直接给 entryId）' };
  }
  const started = Date.now();
  const left = () => Math.max(6000, budgetMs - (Date.now() - started));
  try {
    let targetEntry = entryId;
    // ① 先上题目页找 Tutorial 链接（除非调用方已经知道 entry 号）
    if (!targetEntry) {
      const problemUrl = 'https://codeforces.com/contest/' + contestId + '/problem/' + letter;
      // 题目页只给一半预算：它是"可选的一步"，不该把整题预算吃光
      const half = Math.max(6000, Math.round(budgetMs * 0.5));
      const r1 = await gotoAndProbe(problemUrl, PROBE_PROBLEM_MATERIALS, {
        timeoutMs: half, attemptMs: Math.max(6000, Math.round(half * 0.8))
      });
      if (!r1.state || r1.state.challenge) {
        return { ok: false, reason: 'timeout', hint: '题目页没能过反爬挑战（已放弃找题解链接以省时间）。可以再试一次，或先手动打开一次该题页面。' };
      }
      if (!r1.state.tutorial || !r1.state.tutorial.id) {
        console.log('[cf] 题目页没有 Tutorial 链接: ' + problemUrl);
        return {
          ok: false,
          reason: 'no-tutorial-link',
          hint: '这道题（或这场比赛）在 Codeforces 上没有官方题解链接——不是每场都有。'
        };
      }
      targetEntry = r1.state.tutorial.id;
      console.log('[cf] 找到官方题解链接: blog/entry/' + targetEntry + '（labelled "' + (r1.state.tutorial.label || '') + '"）');
    }
    // ② 打开题解正文（用剩下的全部预算）
    //
    // 这一段外面套了**重试**：实测"偶尔取不到题解"就是这个位置 ——
    // CF 有时会返回一个已经加载完、但题解内容还没渲染出来的页面（marker 为真、正文却是空），
    // 旧实现一看抽不到文字就直接返回 not-found，用户看到的就是"这道题取不到题解"，
    // 而手动重试一次往往就好了（间歇性失败）。现在最多再试一次，仍然不行才如实报错。
    const entryUrl = 'https://codeforces.com/blog/entry/' + targetEntry;
    let r2 = null;
    let parts = [];
    let sliced = false;
    let heading = null;
    let secs = [];
    let entryTitle = '';
    let entryDiag = null;
    for (let round = 1; round <= 2; round++) {
      const budget = left();
      r2 = await gotoAndProbe(entryUrl, PROBE_EDITORIAL_BODY, {
        timeoutMs: budget,
        attemptMs: Math.max(8000, Math.round(budget * (round === 1 ? 0.6 : 0.75))),
        // 要的那一节**真的出现**了才算就绪（见 gotoAndProbe 里的说明）：
        // 只要整篇 → 有任意题解块即可；要某一题 → 必须看到那一题的块
        isReady: (st) => {
          const list = Array.isArray(st.sections) ? st.sections : [];
          if (!list.length) return false;
          if (!letter) return true;
          return list.some((s) => String(s.letter).toUpperCase() === letter);
        }
      });
      if (!r2.state || !r2.state.marker || r2.state.challenge) {
        diagLog('题解页未就绪(round' + round + '): landing=' + r2.landing
          + ' marker=' + (r2.state && r2.state.marker) + ' challenge=' + (r2.state && r2.state.challenge));
        continue;
      }
      parts = [];
      const intro = cfReviewLib.editorialHtmlToText(r2.state.intro || '');
      if (intro) parts.push(intro);
      secs = Array.isArray(r2.state.sections) ? r2.state.sections : [];
      entryTitle = r2.state.title || '';
      entryDiag = r2.state.diag;
      if (!letter) {
        // 只要整篇：有题解块就用，没有就用整页 HTML
        const all = secs.map((s) => {
          const t = cfReviewLib.editorialHtmlToText(s.html);
          return t ? (s.title ? '【' + s.title + '】\n' : '') + t : '';
        }).filter(Boolean).join('\n\n');
        if (all) parts.push(all);
        else if (r2.state.html) parts.push(cfReviewLib.editorialHtmlToText(r2.state.html));
        sliced = false;
        break;
      }
      const mine = secs.find((s) => String(s.letter).toUpperCase() === letter);
      if (mine) {
        sliced = true;
        heading = mine.title || null;
        const t = cfReviewLib.editorialHtmlToText(mine.html);
        if (t) parts.push(t);
      } else if (r2.state.html) {
        // 没有结构化题解块（老比赛用纯文本 h3 排版）→ 退回行级切分。
        // ⚠️ 用 lineSplitOk 判定"切出来的到底是不是本题"：
        // 切分失败时 splitEditorialByProblem 会把**整篇**返回，而整篇的开头是第一题（A）——
        // 曾经因此把 A 的题解当成 C 的贴出去（静默的错误数据，比报错危险得多）。
        const whole = cfReviewLib.editorialHtmlToText(r2.state.html);
        const cut = cfReviewLib.splitEditorialByProblem(whole, letter);
        if (lineSplitOk(cut, letter)) {
          sliced = !!cut.sliced;
          heading = cut.heading || null;
          if (cut.content) parts.push(cut.content);
        } else {
          diagLog('行级切分未命中本题(round' + round + ')：expected=' + letter
            + ' 实际开头=' + JSON.stringify(String(cut.content || '').slice(0, 60)));
        }
      }
      // 抽到内容就算成功；否则再试一轮（这就是"偶尔取不到"的兜底）
      if (parts.join('\n\n').trim().length >= 40) break;
      diagLog('题解正文为空(round' + round + '): entry=' + targetEntry
        + ' 题解块=' + secs.length + '（' + secs.map((s) => s.letter).join(',') + '）'
        + ' 有整页HTML=' + !!r2.state.html + ' → 再试一次');
    }
    if (!r2 || !r2.state || !r2.state.marker || r2.state.challenge) {
      console.log('[cf] 题解页未就绪：landing=' + r2.landing);
      return {
        ok: false, reason: 'timeout', entryId: targetEntry, url: entryUrl,
        hint: '题解页没能在预算内加载出来。多为短时间抓太多次被 Codeforces 限流；等一会儿再试通常就好。'
      };
    }
    if (!letter) {
      const text0 = parts.join('\n\n').trim();
      console.log('[cf] 题解整篇抓取: entry ' + targetEntry + '（' + secs.length + ' 个题解块）');
      return {
        ok: true, entryId: targetEntry, url: entryUrl, title: entryTitle,
        content: text0, fullText: text0, fullLength: text0.length,
        sliced: false, heading: null, letterMentioned: true, whole: true,
        diag: process.env.CFCOACH_DEBUG_EDITORIAL ? entryDiag : undefined
      };
    }

    // 到这里 parts 已经在重试循环里填好了（命中结构 / 退回行级切分都在循环内完成）
    const text = parts.join('\n\n').trim();
    if (!text || text.length < 40) {
      diagLog('题解最终仍为空: entry=' + targetEntry + ' 题号=' + letter
        + ' 题解块=' + secs.length + '（' + secs.map((s) => s.letter).join(',') + '）');
      return {
        ok: false, reason: 'not-found', entryId: targetEntry, url: entryUrl,
        hint: '题解页打开了，但没有抽到本题的正文（可能这场题解的排版比较特殊，或短时间内抓太多被限流）。'
          + '稍后重试一次通常就好。'
      };
    }
    if (sliced) {
      console.log('[cf] 题解按结构切出第 ' + letter + ' 题（' + secs.length + ' 个题解块：'
        + secs.map((s) => s.letter).join(',') + '）');
    }
    // 内容里若连题目字母都没出现，多半切错了 → 如实标注，让上层自己决定要不要用
    const mentionsLetter = cfReviewLib.editorialMentionsLetter(text, letter);
    console.log('[cf] 题解抓取成功: entry ' + targetEntry + '（正文 ' + text.length + ' 字符'
      + (sliced ? '，已切出第 ' + letter + ' 题' : '，**未能精确切出本题**') + '）');
    if (process.env.CFCOACH_DEBUG_EDITORIAL && entryDiag) {
      entryDiag.forEach((d) => diagLog('[cf] 题解诊断: ' + d));
    }
    return {
      ok: true,
      entryId: targetEntry,
      url: entryUrl,
      title: entryTitle,
      content: text,
      fullText: text,
      fullLength: text.length,
      sliced: sliced,
      heading: heading,
      letterMentioned: mentionsLetter,
      // 诊断数据只在显式打开调试开关时回传（平时不回传给模型，省 token）
      diag: process.env.CFCOACH_DEBUG_EDITORIAL ? entryDiag : undefined
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[cf] 题解抓取失败: ' + msg);
    return { ok: false, reason: msg.slice(0, 160) };
  }
}

/** 题解抓取 IPC 通道（同样只回对象，绝不抛异常） */
ipcMain.handle('cf-fetch-editorial', async (e, payload) => {
  try {
    return await fetchEditorial(payload);
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.log('[cf] 题解通道异常: ' + msg);
    return { ok: false, reason: msg.slice(0, 160) };
  }
});

/* ---------------- 反爬挑战的"人工兜底" ---------------- */

/**
 * 打开一个**可见**的浏览器窗口，让 Cloudflare 挑战真正跑完（用户能看到并手动通过验证码）。
 *
 * 为什么需要它：抓题面/题解/源码都依赖 cf_clearance cookie，而挑战在**隐藏窗口**里
 * 经常不通过（实测：同一个 URL，隐藏窗口反复 timeout，屏幕外的可见窗口能过）。
 * 自动化失败时给用户一个明确的出口：点一下、等挑战过去、cookie 就存进同一个 session 分区，
 * 之后所有抓取都能直接用。
 *
 * @param {object} o url（必填） / waitMs（等多久后返回，默认 45 秒）
 * @returns {Promise<{ok:boolean, url:string, waitedMs:number, note:string}>}
 */
async function openChallengeWindow(input) {
  const o = input || {};
  const url = String(o.url || '').trim();
  if (!/^https?:\/\/codeforces\.com\//i.test(url)) {
    return { ok: false, error: '只允许打开 Codeforces 的链接' };
  }
  const waitMs = Math.max(5000, Math.min(Number(o.waitMs) || 45000, 180000));
  let win;
  try {
    // 复用同一个抓取窗口（同一个 persist 分区 → cookie 共享），但这次**放到屏幕内且获得焦点**。
    // 为什么不是"屏幕外可见"：Chromium 会把完全离屏的窗口当作被遮挡，节流渲染与计时器；
    // 而 Cloudflare 的挑战是时序敏感的 JS —— 被节流就过不去（这正是"用户浏览器正常、
    // 应用内窗口频繁要过挑战"的原因）。所以人工兜底这一下必须在屏内。
    win = ensureCfWindow(true);
    applyCfProxy(win.webContents.session);
    bringCfWindowOnScreen(win);
    await win.loadURL(url).catch(() => {});
    // 挑战通过后 CF 常会跳到站点根目录，再导航回目标页（与 fetchHtmlViaBrowser 同一套处理）
    await new Promise((r) => setTimeout(r, Math.min(6000, waitMs / 4)));
    const landing = (() => { try { return win.webContents.getURL() || ''; } catch (e) { return ''; } })();
    if (landing.split('?')[0] !== url.split('?')[0] && landing.replace(/\/+$/, '') === 'https://codeforces.com') {
      await win.loadURL(url).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, Math.max(0, waitMs - Math.min(6000, waitMs / 4))));
    const finalUrl = (() => { try { return win.webContents.getURL() || ''; } catch (e) { return ''; } })();
    console.log('[cf] 人工兜底窗口已打开/等待结束: ' + finalUrl);
    return {
      ok: true, url, finalUrl, waitedMs: waitMs,
      passed: finalUrl.split('?')[0] === url.split('?')[0],
      note: '窗口已打开并等待 ' + Math.round(waitMs / 1000) + ' 秒。如果挑战还没过，请在窗口里手动完成验证；通过后 cookie 会留在应用内，后续抓取直接可用。'
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

ipcMain.handle('cf-open-challenge-window', async (e, payload) => {
  try {
    return await openChallengeWindow(payload);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
});

/**
 * 打开 Codeforces 登录页，让用户在**应用内浏览器**里登录一次。
 *
 * 为什么必须这么做（实测确认的根因）：CF 现在要求**登录后才能查看提交源码**。
 * 未登录时访问 `/contest/<cid>/submission/<sid>`（哪怕是别人的公开提交）
 * 会被直接 302 到首页 `https://codeforces.com/`，所以抓到的永远是"提交不存在"。
 * 抓取窗口用的是 `persist:cfcoach-fetch` 分区，登录一次 cookie 就长期留在那里，
 * 之后所有提交/题解抓取都直接用这份登录态。
 *
 * @param {object} o waitMs 等待多久（默认 180 秒，够用户输账号密码 + 过验证码）
 * @returns {Promise<object>} { ok, finalUrl, loggedIn, waitedMs, note }
 */
async function openCfLogin(input) {
  const o = input || {};
  const waitMs = Math.max(30000, Math.min(Number(o.waitMs) || 180000, 300000));
  let win;
  try {
    win = ensureCfWindow(true);
    applyCfProxy(win.webContents.session);
    bringCfWindowOnScreen(win);
    const loginUrl = 'https://codeforces.com/enter';
    console.log('[cf] 打开登录页: ' + loginUrl);
    await win.loadURL(loginUrl).catch(() => {});
    const deadline = Date.now() + waitMs;
    let loggedIn = false;
    let who = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      // 判定"是否已登录"：CF 登录后导航栏会显示用户名链接并隐藏 "Enter" 链接
      try {
        const st = await win.webContents.executeJavaScript(`(function () {
          var enter = document.querySelector('a[href="/enter"]');
          var me = document.querySelector('a[href^="/profile/"]');
          var title = String(document.title || '');
          return {
            url: location.href,
            hasEnter: !!enter,
            handle: me ? String(me.textContent || '').trim() : '',
            title: title
          };
        })()`);
        who = (st && st.handle) || '';
        loggedIn = !!(st && !st.hasEnter && who);
        // 部分版式下导航栏没有 /profile 链接，退一步：只要不在登录页且能看到上传/提交入口也算
        if (!loggedIn && st && /codeforces\.com\/?$/.test(st.url) && !st.hasEnter) loggedIn = true;
        if (loggedIn) break;
      } catch (e) { /* 页面跳转中，继续等 */ }
    }
    const finalUrl = (() => { try { return win.webContents.getURL() || ''; } catch (e) { return ''; } })();
    console.log('[cf] 登录窗口结束: loggedIn=' + loggedIn + ' handle=' + who + ' url=' + finalUrl);
    if (loggedIn) {
      // 登录成功后必须**清掉"无权查看"的记忆**：
      // 那个开关是"未登录时不再反复弹窗口"的闸门，登录后它继续生效会把所有抓取都挡掉
      // （实测：登录明明成功了，抓源码还是立刻返回 not-allowed）。
      cfPermissionDenied = false;
      try {
        const ses = session.fromPartition('persist:cfcoach-fetch');
        // 把 cookie 立刻刷到磁盘：Chromium 平时是延迟落盘的，
        // 进程被强杀（用户直接关窗口/任务管理器）时登录态会丢 —— 实测就丢过一次。
        if (ses.cookies && typeof ses.cookies.flushStore === 'function') await ses.cookies.flushStore();
        console.log('[cf] 登录 cookie 已落盘');
      } catch (e) { console.log('[cf] cookie 落盘失败（不影响本次会话）: ' + ((e && e.message) || e)); }
    }
    return {
      ok: true, loggedIn: loggedIn, handle: who || null, finalUrl: finalUrl, waitedMs: waitMs,
      note: loggedIn
        ? ('已登录' + (who ? '（' + who + '）' : '') + '，登录态已保存在应用内的抓取会话里，之后抓源码/题解都能用。')
        : '没有检测到登录状态。请在打开的窗口里完成登录（含验证码），然后回来重试一次。'
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

ipcMain.handle('cf-open-login', async (e, payload) => {
  try {
    return await withBrowserNav(() => openCfLogin(payload));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
});

/* ---------------- 冒烟自检（CI / 开发验证用） ---------------- */

function runSmoke(win) {
  // 硬超时保险：默认 45 秒未完成即强制退出，绝不悬挂窗口/进程。
  // 可用 CHATBOX_SMOKE_TIMEOUT 放宽：这套流程现在要跑一段**真实 SSE**
  // （mock-delay 2.5s/1.5s/0.8s + 讲解生成 + 两次页面重载 + 开头 3s 等待），
  // 机器慢一点 45 秒就不够 —— 超时被当成"测试失败"会掩盖真正的结果，所以留一个可调口子。
  const smokeBudgetMs = Number(process.env.CHATBOX_SMOKE_TIMEOUT) > 0
    ? Number(process.env.CHATBOX_SMOKE_TIMEOUT) : 45000;
  const killTimer = setTimeout(() => {
    console.log('SMOKE_TIMEOUT ' + Math.round(smokeBudgetMs / 1000) + 's');
    isQuitting = true;
    app.exit(1);
  }, smokeBudgetMs);
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

      // ---- 侧边栏：对话文件夹 + 多选批量操作（全部走真实点击，不直接调内部函数）----
      const folderState = await win.webContents.executeJavaScript(`(async function () {
        var out = { steps: [] };
        var jpost = function (p, body, method) {
          return fetch(p, { method: method || 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
        };
        var c1 = await jpost('/api/conversations', {});
        var c2 = await jpost('/api/conversations', {});
        out.convIds = [c1.id, c2.id];
        await window.CF_COACH.refreshList();
        out.itemsBefore = document.querySelectorAll('#conv-list .conv-item').length;
        // ① 用界面新建文件夹：点按钮 → 弹窗输入 → 确定
        document.querySelector('#btn-new-folder').click();
        await new Promise(function (r) { setTimeout(r, 200); });
        var input = document.querySelector('[data-prompt-input]');
        out.promptShown = !!input;
        if (input) { input.value = '线段树'; document.querySelector('#modal-root [data-yes]').click(); }
        await new Promise(function (r) { setTimeout(r, 800); });
        out.folderHeads = Array.prototype.map.call(document.querySelectorAll('.conv-folder-name'),
          function (e) { return e.textContent; });
        // ② 把第一个对话移进文件夹（条目上的文件夹按钮 → 菜单里选文件夹）
        var first = document.querySelector('#conv-list .conv-item');
        var movedId = first ? first.getAttribute('data-id') : '';
        if (first) first.querySelector('[data-act="folder"]').click();
        await new Promise(function (r) { setTimeout(r, 200); });
        var items = Array.prototype.slice.call(document.querySelectorAll('.menu-pop .menu-item'));
        var target = items.filter(function (b) { return b.textContent.indexOf('线段树') >= 0; })[0];
        out.menuHasFolder = !!target;
        if (target) target.click();
        await new Promise(function (r) { setTimeout(r, 900); });
        var inFolder = document.querySelector('.conv-folder .conv-item');
        out.movedIntoFolder = !!inFolder && inFolder.getAttribute('data-id') === movedId;
        // ③ 多选：开 → 勾选 → 计数 → 批量归档
        document.querySelector('#btn-multiselect').click();
        await new Promise(function (r) { setTimeout(r, 250); });
        out.bulkVisible = !document.querySelector('#sb-bulk').hidden;
        out.checkboxes = document.querySelectorAll('.conv-check').length;
        var pickTarget = document.querySelector('#conv-list .conv-item');
        if (pickTarget) pickTarget.click();
        await new Promise(function (r) { setTimeout(r, 250); });
        out.picked = document.querySelectorAll('.conv-item.picked').length;
        out.bulkCount = document.querySelector('#sb-bulk-count').textContent;
        var archBtn = document.querySelector('#sb-bulk [data-bulk="archive"]');
        if (archBtn) archBtn.click();
        await new Promise(function (r) { setTimeout(r, 1200); });
        out.activeAfterArchive = (await fetch('/api/conversations?archived=0').then(function (r) { return r.json(); })).conversations.length;
        out.bulkHiddenAfter = document.querySelector('#sb-bulk').hidden;
        // 收尾：删掉冒烟建的文件夹（对话交给后面的统一清理）
        var fs2 = await fetch('/api/folders').then(function (r) { return r.json(); });
        for (var i = 0; i < (fs2.folders || []).length; i++) {
          if (fs2.folders[i].name === '线段树') await fetch('/api/folders/' + fs2.folders[i].id, { method: 'DELETE' });
        }
        return out;
      })()`);
      console.log('SMOKE_FOLDERS ' + JSON.stringify(folderState));
      const foldersOk = folderState.promptShown && folderState.menuHasFolder && folderState.movedIntoFolder
        && folderState.folderHeads.indexOf('线段树') >= 0
        && folderState.bulkVisible && folderState.checkboxes >= 2 && folderState.picked === 1
        && /已选 1 项/.test(folderState.bulkCount)
        && folderState.activeAfterArchive === folderState.itemsBefore - 1
        && folderState.bulkHiddenAfter === true;

      // ---- CF 取题面 → 题面要**真的出现在输入框里，并且输入框要长高** ----
      // 真实反馈："扒题面之后对话框还是原样，看不到粘贴的题面信息"。
      // 光断言 value 里有文字不够：用户看不到就是 bug，所以同时量高度。
      const importState = await win.webContents.executeJavaScript(`(async function () {
        var out = {};
        var conv = await fetch('/api/conversations', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (r) { return r.json(); });
        out.convId = conv.id;
        await window.CF_COACH.refreshList();
        await window.CF_COACH.openConversation(conv.id);
        await new Promise(function (r) { setTimeout(r, 400); });
        var btn = document.querySelector('#btn-cf-import');
        out.btnVisible = !!btn && !btn.hidden;
        if (btn) btn.click();
        await new Promise(function (r) { setTimeout(r, 250); });
        var inp = document.querySelector('[data-prompt-input]');
        out.promptShown = !!inp;
        if (inp) { inp.value = '1800C'; document.querySelector('#modal-root [data-yes]').click(); }
        // 等抓取完成（mock CF 很快，但要给解析留时间）
        for (var i = 0; i < 40; i++) {
          await new Promise(function (r) { setTimeout(r, 250); });
          var box = document.querySelector('#input');
          if (box && box.value && box.value.indexOf('Powering the Hero') >= 0) break;
        }
        var input = document.querySelector('#input');
        out.valueLen = input ? input.value.length : 0;
        out.hasStatement = !!input && input.value.indexOf('Powering the Hero') >= 0;
        out.height = input ? Math.round(input.getBoundingClientRect().height) : 0;
        out.inlineHeight = input ? input.style.height : '';
        out.scrollable = input ? (input.scrollHeight > input.clientHeight + 2) : false;
        var r = input ? input.getBoundingClientRect() : { width: 0 };
        out.width = Math.round(r.width);
        var cw = document.querySelector('.composer');
        out.composerWidth = cw ? Math.round(cw.getBoundingClientRect().width) : 0;
        // ---- 用户手动粘贴（真实路径：设值 + input 事件）——这才是日常用法 ----
        var box = document.querySelector('#input');
        box.value = ('CF 2269D 题面：In SauSaGe City, there are n different flavors of sausages. ' +
          'Reyhaneh keeps a_i ($a_i < 16$) sausages of flavor i in the royal warehouse. ').repeat(12);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(function (r) { setTimeout(r, 300); });
        out.pasteInputLen = box.value.length;
        out.pasteHeight = Math.round(box.getBoundingClientRect().height);
        out.pasteScrollHeight = box.scrollHeight;
        out.pasteClientHeight = box.clientHeight;
        out.pasteMaxHeight = getComputedStyle(box).maxHeight;
        out.pasteWhiteSpace = getComputedStyle(box).whiteSpace;
        out.pasteWrapAttr = box.getAttribute('wrap') || '(默认 soft)';
        out.pasteRows = box.rows;
        out.pasteDisabled = box.disabled;
        // ---- 关键回归：**不触发任何事件**也要长高（field-sizing 由浏览器负责）----
        // 用户的原话是"粘贴是正常的，但对话框一直只有一行" —— 说明以前那条路依赖
        // "事件必须每次都触发"，只要有一条路径漏了，框子就永远一行。这里刻意不派发事件。
        var box2 = document.querySelector('#input');
        box2.value = ('In SauSaGe City, there are n different flavors of sausages. ').repeat(30);
        await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
        await new Promise(function (r) { setTimeout(r, 250); });
        out.noEventHeight = Math.round(box2.getBoundingClientRect().height);
        out.fieldSizing = (typeof CSS !== 'undefined' && CSS.supports) ? CSS.supports('field-sizing', 'content') : false;
        box2.value = '';
        await new Promise(function (r) { setTimeout(r, 250); });
        // 发出去之后框子要缩回去（否则一直占着半屏）
        out.clearedHeight = Math.round(box2.getBoundingClientRect().height);
        // ---- 失败路径：取不到的题号必须**弹出说明原因的对话框**，而不是偷偷往输入框塞模板 ----
        // 真实反馈："扒题面之后对话框还是原样，看不到题面信息" —— 当时失败被静默处理了。
        var btn2 = document.querySelector('#btn-cf-import');
        if (btn2) btn2.click();
        await new Promise(function (r) { setTimeout(r, 250); });
        var inp2 = document.querySelector('[data-prompt-input]');
        if (inp2) { inp2.value = '7777A'; document.querySelector('#modal-root [data-yes]').click(); }
        var failModal = null;
        for (var j = 0; j < 40; j++) {
          await new Promise(function (r) { setTimeout(r, 250); });
          var mods = document.querySelectorAll('#modal-root .modal');
          if (mods.length) { failModal = mods[mods.length - 1]; break; }
        }
        out.failDialog = !!failModal;
        out.failTitle = failModal ? String((failModal.querySelector('.modal-title') || {}).textContent || '') : '';
        out.failBody = failModal ? String((failModal.querySelector('.modal-body') || {}).textContent || '').slice(0, 160) : '';
        out.failButtons = failModal ? !!(failModal.querySelector('[data-cf-paste]') && failModal.querySelector('[data-cf-open]')) : false;
        if (failModal) {
          var pasteBtn = failModal.querySelector('[data-cf-paste]');
          if (pasteBtn) pasteBtn.click();   // 用户主动选择"我自己粘贴题面" → 这时才允许填模板
        }
        await new Promise(function (r) { setTimeout(r, 200); });
        out.inputAfterFail = String(document.querySelector('#input').value || '').length;
        await fetch('/api/conversations/' + conv.id, { method: 'DELETE' }).catch(function () {});
        return out;
      })()`);
      console.log('SMOKE_IMPORT ' + JSON.stringify(importState));
      // 判据：题面进了输入框、输入框明显长高（不是一行）、宽度跟随输入区（不是被压成细条）
      const importOk = importState.btnVisible && importState.promptShown && importState.hasStatement
        && importState.height >= 300 && importState.width > 300
        && importState.width >= importState.composerWidth - 80
        && importState.pasteHeight >= 300 && importState.noEventHeight >= 300
        && importState.clearedHeight <= 60
        && importState.failDialog && importState.failButtons
        && /没有比赛|没有题号|不存在/.test(importState.failBody)
        && importState.inputAfterFail > 0;

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

      /* ---- 并发工作台（**技能驱动的新架构走法**）----
       * 回归目标：三个代码 Agent 真并发时，界面按角色归属、耗时真实 —— 曾经按"最后一个还在跑的条目"
       * 匹配事件，并发下两个 Agent 显示"0s 完成"，看起来像并行没生效。
       *
       * 架构变化后的走法：/api/chat 不再直接拉起流水线，而是跑**工具循环**；
       * 流水线由 `cf_verify` 工具拉起。所以夹具（mock-llm）会先回一个 cf_verify 的 tool_call，
       * 工具执行时才发生"三 Agent 并发"。这里同时断言工具条出现 —— 那正是新链路的可见证据。 */
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
          // 工具条数量：新架构下"教练调了工具"这件事的唯一可见证据
          chips: document.querySelectorAll('.tool-chip').length,
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
      // 发一条真实消息。把"点了但没发出去"的原因也带回来 —— 早先只记 sent:true，
      // 于是"没选中模型 / toast 报错"这类原因被吞掉，只看到工作台空空如也（无法定位）。
      const sent = await win.webContents.executeJavaScript(`(function () {
        var out = { ok: false, why: '', toast: '', model: '' };
        var inp = document.querySelector('#input');
        var btn = document.querySelector('#btn-send');
        var label = document.querySelector('#model-select-label');
        out.model = label ? label.textContent : '(no label)';
        if (!inp || !btn) { out.why = 'missing #input or #btn-send'; return out; }
        inp.value = 'CF 1800C 讲解一下';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        btn.click();
        out.ok = true;
        var t = document.querySelector('.toast-wrap, .toasts, [data-toast]');
        out.toast = t ? String(t.textContent).slice(0, 160) : '';
        out.streaming = btn.classList.contains('stop');
        return out;
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
      const chipCount = Math.max.apply(null, wbSamples.concat([wbAfter || {}]).map((s) => s.chips || 0));
      console.log('SMOKE_WORKBENCH ' + JSON.stringify({
        sent, maxRunning, chips: chipCount, during: wbSamples.map((s) => s.metas), after: wbAfter && wbAfter.metas
      }));
      // chipCount ≥ 1：工具循环真的跑起来了（否则工作台里的三个 Agent 根本无从产生）
      const paraOk = sent.ok && chipCount >= 1 && maxRunning >= 3
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
      console.log('SMOKE_OVERALL ' + (hitOk && clickOk && coachOk && richOk && vizOk && addMenuOk && stackOk && settingsOk && modelOk && paraOk && foldersOk && importOk && trayOk && revealOk ? 'PASS' : 'FAIL'));
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
