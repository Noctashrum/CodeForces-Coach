/**
 * lib/sandbox/guard.js —— 运行 LLM 生成代码时的 Node 侧沙箱守卫。
 *
 * 【重要：这是"缓解"，不是可靠隔离】
 * lib/sandbox.js 通过 NODE_OPTIONS=--require <本文件绝对路径> 让本模块在
 * 用户脚本之前执行，把 net/tls/http/https/dns/fetch 与 fs 常用入口换成带检查的版本。
 * 它挡不住下面这些：
 *   * 进程内 C++ 绑定直连：process.binding('fs') / internalBinding 之类；
 *   * child_process 之外的逃逸（本文件会一并封掉 child_process，见下）；
 *   * Worker/裸 socket 等未覆盖的 API（覆盖面已尽量铺开，但不保证穷尽）；
 *   * 真正的原生代码（C/C++ 通道）——那需要 job object / 容器 / 低权限账户；
 *   * 用户代码自己把被 patch 的函数改回去（require('fs') 拿到的是同一个模块对象，
 *     所以它能改回来 —— 这是"缓解"档的固有上限）。
 * 真正的隔离要在操作系统层面做（受限账户 + ACL + 防火墙规则）。这里只求挡住
 * "题面里藏了提示注入，诱导模型生成一段偷读 ~/.ssh 或对外发请求的代码" 这一档。
 *
 * 环境变量（由 lib/sandbox.js 设置）：
 *   SANDBOX_DIR       允许自由读写的目录（题目程序的工作目录），空 = 不限制文件访问
 *   SANDBOX_ALLOW_NET '0' = 禁止网络（默认），'1' = 不干预
 * 所有 patch 都用 try/catch 包住：失败就静默跳过，绝不因为守卫自身出错而
 * 让用户的题目程序崩溃；守卫也绝不往 stdout/stderr 写任何东西（会被对拍误判成 WA）。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT_RAW = process.env.SANDBOX_DIR || '';
const ALLOW_NET = process.env.SANDBOX_ALLOW_NET === '1';

/** 规范化沙箱根目录：去尾分隔符 + Windows 大小写不敏感 */
function normRoot(p) {
  let s = path.resolve(String(p));
  const sep = path.sep;
  while (s.length > 3 && s.endsWith(sep)) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

let ROOT = '';
try {
  ROOT = ROOT_RAW ? normRoot(ROOT_RAW) : '';
} catch (e) {
  ROOT = '';
}

// 必须在任何 patch 之前抓下原始实现：fs.realpathSync 也在我们的 patch 名单里，
// 如果检查逻辑调用被包过的版本 → checkPath → realpathSafe → ... 会无限递归。
const ORIG_REALPATH = fs.realpathSync;
const ORIG_REALPATH_NATIVE = fs.realpathSync && fs.realpathSync.native;

const NET_MSG = '沙箱：已禁止网络访问';

/**
 * 解析成"已展开 .. 与符号链接/junction"的绝对真实路径。
 * 注意：必须用 ORIG_REALPATH（patch 前的原始函数），否则会无限递归。
 * 两个坑：
 *  1) fs.realpathSync.native 在部分 Windows/Node 组合上会直接抛错（实测 Node 24 + Win
 *     对 junction 路径抛 ERR undefined），所以必须再退回纯 JS 版 fs.realpathSync ——
 *     它同样是 native 实现，能正确展开 junction。两个都失败才认为解析不出来。
 *  2) 对"不存在的路径"要逐级向上找第一个存在的祖先并 realpath，再把剩余部分接回去；
 *     否则 realpath 抛错会被误判成"放行"。
 */
function realpathOf(p) {
  try {
    return ORIG_REALPATH(p);
  } catch (e) { /* 试下一个 */ }
  try {
    if (ORIG_REALPATH_NATIVE) return ORIG_REALPATH_NATIVE(p);
  } catch (e) { /* 解析不出来 */ }
  return null;
}

function realpathSafe(p) {
  const abs = path.resolve(String(p));
  const direct = realpathOf(abs);
  if (direct) return direct;
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.push(path.basename(cur));
    cur = parent;
    const real = realpathOf(cur);
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real;
  }
  return abs;
}

/** 目标路径是否落在沙箱目录内（大小写不敏感；已解析 .. 穿越与符号链接） */
function insideSandbox(target) {
  if (!ROOT) return true; // 没配置沙箱目录 = 不限制文件访问
  let rp;
  try {
    rp = realpathSafe(target);
  } catch (e) {
    return false;
  }
  if (process.platform === 'win32') rp = rp.toLowerCase();
  if (rp === ROOT) return true;
  return rp.startsWith(ROOT + path.sep);
}

function deny(target) {
  throw new Error('沙箱：拒绝访问沙箱目录之外的路径 ' + String(target));
}

/**
 * 检查一个路径参数；非路径类型（整数 fd / null）直接放行，
 * 交给原函数去处理或报它自己的错 —— 守卫只关心"能解析成路径的输入越权"这一件事。
 * 注意 Buffer 也是合法路径类型（Node 接受 Buffer 当路径），必须解码后检查，
 * 否则 `fs.writeFileSync(Buffer.from('C:/Windows/...'), x)` 就是一条绕过。
 */
function checkPath(target) {
  if (target == null) return true;
  let p = target;
  if (typeof p !== 'string') {
    if (typeof p === 'number') return true;      // 已打开的 fd：运行器给的句柄，放行
    if (p instanceof URL) p = p.pathname;        // file:// URL
    else if (Buffer.isBuffer(p)) {
      p = p.toString('utf8');
      if (p.indexOf('\u0000') >= 0) {
        try { p = target.toString('utf16le'); } catch (e) { return true; }
      }
    } else return true;
  }
  if (insideSandbox(p)) return true;
  deny(p);
  return false;
}

/** 包装一个同步/普通函数：调用前逐个检查指定位置的参数 */
function wrapFn(obj, name, argIndexes) {
  try {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    if (orig.__sandboxWrapped) return;
    const wrapped = function (...args) {
      for (const i of argIndexes) {
        if (i < args.length) checkPath(args[i]);
      }
      return orig.apply(this, args);
    };
    wrapped.__sandboxWrapped = true;
    wrapped.__sandboxOrig = orig;
    try {
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
    } catch (e) { /* ignore */ }
    obj[name] = wrapped;
  } catch (e) { /* 守卫绝不能因为自己 patch 失败而影响用户程序 */ }
}

/** 包装成固定抛错的函数（用于网络入口） */
function blockFn(obj, name, msg) {
  try {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    const blocked = function () {
      throw new Error(msg || NET_MSG);
    };
    blocked.__sandboxWrapped = true;
    blocked.__sandboxOrig = orig;
    obj[name] = blocked;
  } catch (e) { /* ignore */ }
}

/**
 * 判断当前调用是否来自 Node 内部模块。
 * 只看最靠近顶部的几帧 —— 不能用"整个栈里是否出现 node:internal/"，
 * 因为用户脚本的栈底永远有 node:internal/main/run_main_module，那样会一律放行（实测漏拦）。
 */
function callerIsNodeInternal() {
  try {
    const stack = new Error().stack || '';
    const frames = stack.split('\n').slice(1, 5); // 跳过 "Error" 那一行，取最上面 4 帧
    let internal = 0;
    for (const f of frames) {
      if (f.indexOf('node:internal/') >= 0) internal++;
    }
    return internal >= 2;
  } catch (e) {
    return false; // 拿不到栈就按用户代码处理，宁可拦
  }
}

/**
 * 包成"普通调用抛错、内部调用放行"的函数。
 * 用途：net.Socket 这个构造函数不能无差别封死 —— Node 自己在 stdout 是管道时会
 * 用 new Socket({fd:1}) 包一个写流（node:internal 里的 createWritableStdioStream），
 * 封死会把 console.log 一起打死（实测：管道下进程直接崩）。而 new net.Socket()
 * 又是最典型的裸 socket 用法，不封就漏。
 */
function blockFnAllowInternal(obj, name, msg) {
  try {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    if (orig.__sandboxWrapped) return;
    const wrapped = function (...args) {
      if (!callerIsNodeInternal()) throw new Error(msg || NET_MSG);
      return new orig(...args);
    };
    wrapped.__sandboxWrapped = true;
    wrapped.__sandboxOrig = orig;
    try {
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
    } catch (e) { /* ignore */ }
    obj[name] = wrapped;
  } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------- 安装守卫 */

if (ROOT || !ALLOW_NET) {
  /* ---- 0) 进程工作目录（chdir 本身不是泄漏，但它是相对路径越权的跳板） ------ */
  try {
    const origChdir = process.chdir;
    process.chdir = function (dir) {
      checkPath(dir);
      return origChdir.call(process, dir);
    };
    process.chdir.__sandboxWrapped = true;
    process.chdir.__sandboxOrig = origChdir;
  } catch (e) { /* ignore */ }
  try {
    if (typeof fs.chdir === 'function') wrapFn(fs, 'chdir', [0]);
  } catch (e) { /* ignore */ }

  /* ---- 1) 网络 -------------------------------------------------------- */
  if (!ALLOW_NET) {
    try {
      const net = require('net');
      // Socket 构造函数：用户代码里 new net.Socket() 要拦（可建出裸 socket），
      // 但 Node 内部为 stdout 管道建 socket 要放行 —— 见 blockFnAllowInternal 注释。
      blockFnAllowInternal(net, 'Socket', NET_MSG + '（net.Socket）');
      // 连接动作：任何真正的连接都必然经过 connect()，堵它既精确又不漏。
      blockFn(net, 'connect', NET_MSG + '（net.connect）');
      blockFn(net, 'createConnection', NET_MSG + '（net.createConnection）');
      blockFn(net, 'createServer', NET_MSG + '（net.createServer）');
      try {
        const proto = net.Socket && net.Socket.prototype;
        if (proto) {
          blockFn(proto, 'connect', NET_MSG + '（net.Socket.prototype.connect）');
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }

    try {
      const tls = require('tls');
      blockFn(tls, 'connect', NET_MSG + '（tls.connect）');
      blockFn(tls, 'createServer', NET_MSG + '（tls.createServer）');
    } catch (e) { /* ignore */ }

    try {
      const http = require('http');
      blockFn(http, 'request', NET_MSG + '（http.request）');
      blockFn(http, 'get', NET_MSG + '（http.get）');
      blockFn(http, 'createServer', NET_MSG + '（http.createServer）');
    } catch (e) { /* ignore */ }

    try {
      const https = require('https');
      blockFn(https, 'request', NET_MSG + '（https.request）');
      blockFn(https, 'get', NET_MSG + '（https.get）');
      blockFn(https, 'createServer', NET_MSG + '（https.createServer）');
    } catch (e) { /* ignore */ }

    try {
      const dns = require('dns');
      blockFn(dns, 'lookup', NET_MSG + '（dns.lookup）');
      blockFn(dns, 'resolve', NET_MSG + '（dns.resolve）');
      blockFn(dns, 'resolve4', NET_MSG + '（dns.resolve4）');
      blockFn(dns, 'resolve6', NET_MSG + '（dns.resolve6）');
      if (dns.promises) {
        blockFn(dns.promises, 'lookup', NET_MSG + '（dns.promises.lookup）');
        blockFn(dns.promises, 'resolve', NET_MSG + '（dns.promises.resolve）');
      }
    } catch (e) { /* ignore */ }

    try {
      const http2 = require('http2');
      blockFn(http2, 'connect', NET_MSG + '（http2.connect）');
      blockFn(http2, 'createServer', NET_MSG + '（http2.createServer）');
    } catch (e) { /* ignore */ }

    try {
      if (typeof globalThis.fetch === 'function') {
        const blockedFetch = function () {
          return Promise.reject(new Error(NET_MSG + '（fetch）'));
        };
        blockedFetch.__sandboxWrapped = true;
        globalThis.fetch = blockedFetch;
      }
    } catch (e) { /* ignore */ }

    // 子进程是绕过"进程内网络 patch"的最短路径（node -e 没有守卫、curl 完全不受管），
    // 对拍用的题目程序不需要开子进程，这里一并封掉。
    try {
      const cp = require('child_process');
      const spawnMsg = '沙箱：已禁止启动子进程（child_process）';
      for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        blockFn(cp, n, spawnMsg + '：' + n);
      }
    } catch (e) { /* ignore */ }
  }

  /* ---- 2) 文件系统 ----------------------------------------------------- */
  if (ROOT) {
    // 同步入口
    for (const n of ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync',
                     'unlinkSync', 'rmdirSync', 'rmSync', 'mkdirSync', 'readdirSync',
                     'statSync', 'lstatSync', 'realpathSync', 'copyFileSync',
                     'renameSync', 'truncateSync', 'chmodSync', 'readlinkSync',
                     'accessSync', 'opendirSync', 'createReadStream', 'createWriteStream',
                     'watch', 'watchFile']) {
      wrapFn(fs, n, [0]);
    }
    // 回调式入口
    for (const n of ['readFile', 'writeFile', 'appendFile', 'open', 'unlink', 'rmdir',
                     'rm', 'mkdir', 'readdir', 'stat', 'lstat', 'realpath', 'copyFile',
                     'rename', 'truncate', 'chmod', 'readlink', 'access', 'opendir']) {
      wrapFn(fs, n, [0]);
    }
    // 双路径参数入口
    for (const n of ['copyFileSync', 'renameSync', 'linkSync', 'symlinkSync']) {
      wrapFn(fs, n, [0, 1]);
    }
    for (const n of ['copyFile', 'rename', 'link', 'symlink', 'cp', 'cpSync']) {
      wrapFn(fs, n, [0, 1]);
    }
    // Promise API
    try {
      const p = fs.promises;
      for (const n of ['readFile', 'writeFile', 'appendFile', 'open', 'unlink', 'rmdir',
                       'rm', 'mkdir', 'readdir', 'stat', 'lstat', 'realpath', 'copyFile',
                       'rename', 'truncate', 'chmod', 'readlink', 'access', 'opendir']) {
        wrapFn(p, n, [0]);
      }
      for (const n of ['copyFile', 'rename', 'link', 'symlink', 'cp']) {
        wrapFn(p, n, [0, 1]);
      }
    } catch (e) { /* ignore */ }

    // 自我标识（供调试确认守卫已加载；不写 stdout/stderr）
    try {
      process.__sandboxGuard = { dir: ROOT, allowNet: ALLOW_NET };
    } catch (e) { /* ignore */ }
  }
}
