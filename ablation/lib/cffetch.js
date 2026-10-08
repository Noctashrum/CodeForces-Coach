#!/usr/bin/env node
/**
 * ablation/lib/cffetch.js — 从 Codeforces「扒题」，给消融测试台复用应用**自己**的取题通道。
 *
 * 为什么不让测试台自己写一份抓取：
 *   题面页有 Cloudflare 反爬，能过挑战的只有"真实 Chromium + 屏内可见窗口 + 不伪造 UA +
 *   挑战页不重复导航"这一整套（electron/main.js 里那些注释全是踩出来的）。测试台照抄一份
 *   必然漂移，抄漏一条就变成"抓不到题"——所以这里**直接复用**应用：起一个 Electron 子进程，
 *   走它现成的 CHATBOX_CF_API_TEST 自检通道，再把完整题面写盘回传。
 *
 * 为什么用文件回传而不是 stdout：本机某些受限运行环境不允许"父进程用管道读子进程输出"，
 * 而 GUI 子系统的 exe 在 Windows 上本来也没有控制台。写一个 JSON 文件两种环境都成立，
 * 失败原因（含反爬/题号不存在）也照样写盘，调用方不会只剩一句"超时"。
 *
 * 用法（探针/脚本）：
 *   const { fetchProblem, toStoreProblem, parseRef } = require('./lib/cffetch');
 *   const r = await fetchProblem('1800C');           // 或题目链接
 *   if (r.ok) console.log(r.problem.statement);
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const env = require('./env');

const ROOT = path.join(__dirname, '..', '..');

/**
 * 解析"题号"输入：1800C / 1800 C / 1800c / 题目链接（problem 页或 contest 页）。
 * 解析不出来返回 null（调用方给一句人话，而不是让正则错到别处去）。
 */
function parseRef(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,5})\s*([A-Za-z][0-9]?)$/);
  if (m) return { contestId: parseInt(m[1], 10), index: m[2].toUpperCase() };
  m = s.match(/problemset\/problem\/(\d{1,5})\/([A-Za-z][0-9]?)/i)
    || s.match(/contest\/(\d{1,5})\/problem\/([A-Za-z][0-9]?)/i)
    || s.match(/problem\/(\d{1,5})\/([A-Za-z][0-9]?)/i);
  if (m) return { contestId: parseInt(m[1], 10), index: m[2].toUpperCase() };
  return null;
}

/** 找 Electron 可执行文件（开发目录里的 electron 包；也支持 CFCOACH_ELECTRON 覆盖） */
function electronPath() {
  const cands = [];
  if (process.env.CFCOACH_ELECTRON) cands.push(process.env.CFCOACH_ELECTRON);
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') cands.push(path.join(dist, 'electron.exe'));
  else if (process.platform === 'darwin') cands.push(path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  else cands.push(path.join(dist, 'electron'));
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* 继续找 */ } }
  // 兜底：读 electron 包的 path.txt 自己拼路径。
  // ⚠️ 这里**绝对不能** `require('electron')` —— 二进制缺失时它会当场静默下载 100+ MB（实测踩过），
  // 一个"取题探针"不该有这种副作用。
  const pkgDir = path.join(ROOT, 'node_modules', 'electron');
  try {
    const rel = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
    if (rel && fs.existsSync(path.join(pkgDir, 'dist', rel))) return path.join(pkgDir, 'dist', rel);
  } catch { /* ignore */ }
  return null;
}

function tail(file, lines) {
  try {
    const t = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return t.slice(-(lines || 8)).join('\n');
  } catch { return ''; }
}

/**
 * 取一道题：返回 { ok:true, problem }（CF 原始结构：statement/samples/title/rating/tags…）
 *           或 { ok:false, error }（人话原因：反爬没过去 / 题号不存在 / 超时…）
 * @param {string} ref           题号或题目链接
 * @param {{timeoutMs?:number, log?:Function, debug?:boolean, cfBase?:string}} [opts]
 */
function fetchProblem(ref, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const t0 = Date.now();
  const parsed = parseRef(ref);
  if (!parsed) {
    return Promise.resolve({ ok: false, error: '看不懂这个题号：写成 1800C（比赛号+题号）或直接贴题目链接', ms: 0 });
  }
  const exe = electronPath();
  if (!exe) {
    return Promise.resolve({
      ok: false, ms: 0,
      error: '找不到 Electron：取题必须借应用内嵌的 Chromium 过 CF 反爬。'
        + '请在项目目录跑 npm i（装 electron 二进制），或设 CFCOACH_ELECTRON 指向 electron 可执行文件。'
    });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfcoach-cf-'));
  const jsonFile = path.join(tmp, 'problem.json');
  const logFile = path.join(tmp, 'electron.log');
  const refArg = parsed.contestId + parsed.index;
  const timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : 180000;

  // 工作台"抓题"是实测把整机拖到黑屏的那个入口（可见窗口里跑 Cloudflare 挑战页 → 显卡驱动复位）。
  // 所以**默认只允许隐藏窗口**：过不了挑战就如实失败，宁可不抓。要恢复"隐藏失败后改可见"的老行为，
  // 显式设 CFCOACH_CF_ALLOW_VISIBLE=1（并且建议同时设 CFCOACH_CF_SAFE_GPU=1 关掉硬件加速）。
  const allowVisible = process.env.CFCOACH_CF_ALLOW_VISIBLE === '1';
  const hiddenOnly = !allowVisible || process.env.CFCOACH_CF_HIDDEN_ONLY === '1';
  log('取题 ' + refArg + '：起应用内嵌浏览器（'
    + (hiddenOnly ? '只允许隐藏窗口，过不了挑战即失败' : '隐藏窗口 → 过不了挑战再用可见窗口')
    + '，可能要 10–60 秒）');
  let fd = null;
  let child = null;
  try {
    fd = fs.openSync(logFile, 'a');
    child = spawn(exe, [ROOT], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        // 取真题：必须显式指定 CF_BASE，否则 CHATBOX_SMOKE=1 会把 CF 指向本地 mock
        CF_BASE: o.cfBase || 'https://codeforces.com',
        CHATBOX_SMOKE: '1',            // 跳过单实例锁：用户的应用开着也能取题
        CHATBOX_CF_API_TEST: refArg,
        CHATBOX_CF_JSON: jsonFile,
        ...(hiddenOnly ? { CFCOACH_CF_HIDDEN_ONLY: '1' } : {}),
        ...(o.debug ? { CFCOACH_DEBUG_EDITORIAL: '1' } : {})
      }),
      // 输出重定向到文件（不是管道）：受限环境里管道读子进程会被拒，且 GUI 版 exe 没有控制台
      stdio: ['ignore', fd, fd],
      windowsHide: true
    });
  } catch (e) {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
    return Promise.resolve({ ok: false, error: '启动 Electron 失败：' + ((e && e.message) || e), ms: Date.now() - t0 });
  }

  return new Promise((resolve) => {
    let done = false;
    let exited = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
      try { if (child && !exited) child.kill(); } catch { /* ignore */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      // 失败时把"为什么没退到可见窗口"说清楚：默认就是不让它弹可见窗口（那条路会把整机拖到黑屏）
      if (r && r.ok === false && hiddenOnly && !/CFCOACH_CF_ALLOW_VISIBLE/.test(String(r.error || ''))) {
        r = Object.assign({}, r, {
          error: String(r.error || '取题失败')
            + '｜本次只允许隐藏窗口（工作台抓题默认如此：可见取题窗口实测会把整机拖到黑屏）。'
            + '确实需要可见窗口时设 CFCOACH_CF_ALLOW_VISIBLE=1，并建议同时设 CFCOACH_CF_SAFE_GPU=1；'
            + '更稳的办法是用"导应用缓存"把题面/题解导进来，不必联网取题。'
        });
      }
      resolve(Object.assign({ ms: Date.now() - t0 }, r));
    };
    child.on('exit', () => {
      exited = true;
      // 进程退出后文件可能刚写好，给它一点余量再看一眼
      setTimeout(() => { if (!done && !fs.existsSync(jsonFile)) finish({ ok: false, error: '取题进程退出但没有写回结果', logTail: tail(logFile) }); }, 400);
    });
    child.on('error', (e) => finish({ ok: false, error: '无法启动 Electron：' + ((e && e.message) || e), logTail: tail(logFile) }));
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (fs.existsSync(jsonFile)) {
        let parsedJson = null;
        try { parsedJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { /* 半截文件，下一轮再读 */ }
        if (parsedJson) {
          if (parsedJson.ok && parsedJson.problem) {
            const p = parsedJson.problem;
            log('取题成功：' + p.title + '（题面 ' + String(p.statement || '').length + ' 字，样例 '
              + (p.samples || []).filter((s) => s.input != null).length + ' 组'
              + ((p.warnings || []).length ? '，告警 ' + p.warnings.length + ' 条' : '') + '）');
            finish({ ok: true, problem: p });
          } else {
            finish({ ok: false, error: String(parsedJson.error || '取题失败'), logTail: tail(logFile) });
          }
          return;
        }
      }
      if (Date.now() > deadline) {
        finish({ ok: false, error: '取题超时（' + Math.round(timeoutMs / 1000) + ' 秒）：CF 反爬挑战没过，或网络到不了 codeforces.com', logTail: tail(logFile) });
      }
    }, 400);
  });
}

/**
 * CF 题目 → 测试台的题库条目（uistore.save 认的形状）。
 * id 用 1800C 这种题号（与工作区 key、判分配对一致）。
 */
function toStoreProblem(p) {
  const id = String(p.contestId) + String(p.index).toUpperCase();
  return {
    id,
    title: p.title || p.name || id,
    rating: p.rating || '',
    url: p.sourceUrl || ('https://codeforces.com/contest/' + p.contestId + '/problem/' + p.index),
    statement: p.statement || '',
    samples: (p.samples || []).filter((s) => s.input != null),
    note: (p.tags || []).length ? ('tags: ' + p.tags.join(', ')) : '',
    source: 'cf'
  };
}

/* ------------------------------------------------------------------ *
 * 应用自己的题面缓存（<DATA_DIR>/cf-problems/<题号>.json）
 *
 * 为什么要有这条路：CF 的反爬是**概率性**的 —— 现场抓题经常整轮被抓（Cloudflare 403），
 * 但用户在应用里点开某道题时抓成功过一次，题面就已经落盘了（lib/cf.js 的 writeProblemCache）。
 * 直接把这份缓存导进测试台，比现场再抓一次可靠得多，也少交一次"挑战"的学费。
 * 缓存结构和 fetchProblem 返回的 problem 完全一样，所以 toStoreProblem 能直接复用。
 * ------------------------------------------------------------------ */

/** 应用数据目录：与模型配置同一个目录（env.dataDir 负责挑：仓库 data/ 或打包产物 dist/<...>/data/），
 *  这样"模型配置来自 A、题面缓存却去 B 找"这种自相矛盾不会发生 */
function appDataDir(opts) {
  const o = opts || {};
  return o.dataDir || env.dataDir();
}

/** 题面缓存目录 */
function appCacheDir(opts) {
  return path.join(appDataDir(opts), 'cf-problems');
}

/** 缓存里已有哪些题号（如 ['4A','1800C']，按题号排序）；目录不存在就返回空数组 */
function listAppCache(opts) {
  try {
    return fs.readdirSync(appCacheDir(opts))
      .filter((f) => /\.json$/i.test(f))
      .map((f) => f.replace(/\.json$/i, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 读缓存里的一道题：返回 CF 原始结构（同 fetchProblem 的 problem），没有或文件坏了返回 null。
 * @param {string|{contestId:number,index:string}} ref 题号（4A / 4 A / 题目链接）或已解析的 {contestId,index}
 */
function readAppCache(ref, opts) {
  const parsed = (ref && typeof ref === 'object' && ref.contestId != null)
    ? { contestId: ref.contestId, index: String(ref.index || '').toUpperCase() }
    : parseRef(ref);
  if (!parsed) return null;
  const id = String(parsed.contestId) + String(parsed.index).toUpperCase();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appCacheDir(opts), id + '.json'), 'utf8'));
    if (!raw || !raw.statement) return null;
    if (raw.contestId == null) { raw.contestId = parsed.contestId; raw.index = parsed.index; }
    return raw;
  } catch {
    return null;
  }
}

module.exports = {
  fetchProblem, parseRef, toStoreProblem, electronPath,
  appDataDir, appCacheDir, listAppCache, readAppCache
};
