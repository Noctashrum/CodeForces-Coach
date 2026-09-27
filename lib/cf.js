/**
 * lib/cf.js — Codeforces 客户端（零依赖）
 * - 题面：抓取 https://codeforces.com/problemset/problem/{contestId}/{index} 网页并解析
 *   （标题、时限/内存、正文、输入输出格式、样例；CF 的 $$$...$$$ 公式转成标准 LaTeX 分隔符）
 * - 元数据：官方 API contest.standings（rating / tags）
 * - 用户：官方 API user.info（rating / 段位）
 * - 简单内存缓存 + 失败降级；CF_BASE 环境变量可覆盖（测试用）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CF_BASE = (process.env.CF_BASE || 'https://codeforces.com').replace(/\/+$/, '');
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBLEMSET_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map();

/** 数据目录（由 server.js 注入）：用于题目总表落盘缓存，断网也能查 rating/tags */
let cacheDir = null;
function setCacheDir(dir) {
  cacheDir = dir || null;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  cache.delete(key);
  return undefined;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 64) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/* ---------------- 题面落盘缓存：抓成功过一次，之后断网/被反爬也能用 ---------------- */
/** 题面缓存目录（数据目录下的 cf-problems/）；由 setCacheDir 一起注入 */
function problemCacheFile(contestId, index) {
  if (!cacheDir) return null;
  return path.join(cacheDir, 'cf-problems', String(contestId) + String(index).toUpperCase() + '.json');
}
function readProblemCache(contestId, index) {
  const f = problemCacheFile(contestId, index);
  if (!f) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || !j.statement || String(j.statement).length < 200) return null;
    return j;
  } catch (e) { return null; }
}
function writeProblemCache(contestId, index, result) {
  const f = problemCacheFile(contestId, index);
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(result), 'utf8');
  } catch (e) { /* 缓存写失败不影响主流程 */ }
}

/**
 * 抓取日志：**追加**到数据目录下的 cf-fetch.log（滚动保留最近 200 行）。
 * 为什么需要：打包版没有控制台，反爬失败时用户拿不到任何线索；有了它，"翻日志"才真的能翻。
 */
function logFetch(line) {
  console.log('[cf] ' + line);
  if (!cacheDir) return;
  try {
    const f = path.join(cacheDir, 'cf-fetch.log');
    const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : [];
    prev.push(new Date().toISOString() + ' ' + line);
    fs.writeFileSync(f, prev.slice(-200).join('\n'), 'utf8');
  } catch (e) { /* ignore */ }
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  // 明确只接受桌面版布局（CF 会按 cookie/参数 决定给 m1 移动版）
  'Cache-Control': 'no-cache'
};

/**
 * 请求桌面版：给 URL 补上 CF 的 mobile=false 参数。
 * CF 的移动版偏好存在 cookie/URL 参数里（?mobile=true/false），
 * 我们永远显式要桌面版——既不解析移动版页面，也不会让会话停留在移动版状态。
 */
function desktopUrl(url) {
  const s = String(url || '');
  if (!/codeforces\.com/i.test(s)) return s;
  if (/[?&]mobile=/.test(s)) return s.replace(/([?&])mobile=[^&]*/i, '$1mobile=false');
  return s + (s.indexOf('?') >= 0 ? '&' : '?') + 'mobile=false';
}

/** 判断拿到的页面是不是 CF 移动版（m1/m2 布局） */
function looksMobile(html, finalUrl) {
  if (/^https?:\/\/(m1|m2)\.codeforces\.com/i.test(String(finalUrl || ''))) return true;
  const head = String(html || '').slice(0, 6000);
  if (/m1\.codeforces\.com|m2\.codeforces\.com/i.test(head)) return true;
  // 移动版页面特征：有 "Desktop version" 链接 且 没有桌面版的 problem-statement / 顶部导航
  const hasDesktopLink = /Desktop version|desktop version|mobile=false/i.test(head);
  const hasDesktopShell = /<div id="pageContent"|<div class="problem-statement|id="header"/i.test(head);
  return hasDesktopLink && !hasDesktopShell;
}

/**
 * 浏览器抓取通道：Codeforces 题面页有 Cloudflare 反爬（普通 HTTP 请求会拿到 403 挑战页），
 * Electron 主进程会注入一个「用内嵌 Chromium 加载页面」的实现，可自动通过 JS 挑战。
 */
let browserFetcher = null;
function setBrowserFetcher(fn) {
  browserFetcher = typeof fn === 'function' ? fn : null;
  console.log('[cf] 浏览器抓取通道: ' + (browserFetcher ? '已启用' : '未启用'));
}

/** 判断响应是否是反爬挑战页（而非真实题面） */
function looksBlocked(status, text) {
  if (status === 403 || status === 503) return true;
  const head = String(text || '').slice(0, 3000);
  return /Just a moment|browser is being checked|cf-mitigated|Enable JavaScript and cookies|challenge-platform/i.test(head);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&minus;/g, '-')
    .replace(/&le;/g, '≤')
    .replace(/&ge;/g, '≥')
    .replace(/&ne;/g, '≠')
    .replace(/&times;/g, '×')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

/** 把 CF 的 $$$ 公式分隔符转换为前端 KaTeX 可识别的 $$ / $ */
function normalizeMath(s) {
  return s
    .replace(/\$\$\$\$([\s\S]+?)\$\$\$\$/g, function (m, tex) { return '$$' + tex + '$$'; })
    .replace(/\$\$\$([\s\S]+?)\$\$\$/g, function (m, tex) { return '$' + tex + '$'; });
}

/** HTML 片段 → 纯文本/markdown（保留公式、换行、列表结构） */
function htmlToText(html) {
  let s = String(html || '');
  // 去掉脚本/样式/复制按钮等
  s = s.replace(/<(script|style|svg|button)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<input[\s\S]*?>/gi, '');
  // 块级元素换行
  s = s.replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|section|table)>/gi, '\n');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<h[1-6][^>]*>/gi, '\n\n### ');
  s = s.replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<(td|th)[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // 折叠多余空行
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalizeMath(s);
}

/* ---------------- 通用 HTML 结构工具 ---------------- */

/** 从 html[start] 处的 <tag ...> 起，找到配对的 </tag> 之后的位置（找不到返回 -1） */
function sliceBalancedTag(html, start, tag) {
  if (start < 0) return -1;
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let i = start;
  let depth = 0;
  while (i < html.length) {
    const openAt = html.indexOf(open, i);
    const closeAt = html.indexOf(close, i);
    if (closeAt < 0) return -1;
    if (openAt >= 0 && openAt < closeAt) {
      depth++;
      i = openAt + open.length;
    } else {
      depth--;
      i = closeAt + close.length;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function sliceBalancedDiv(html, start) {
  return sliceBalancedTag(html, start, 'div');
}

/** 取 <div class="cls">…</div> 整块的纯文本 */
function divBlockText(html, cls) {
  const at = html.indexOf('<div class="' + cls + '"');
  if (at < 0) return '';
  const end = sliceBalancedDiv(html, at);
  const seg = html.slice(at, end > 0 ? end : Math.min(html.length, at + 800));
  return htmlToText(seg.replace(/<div class="property-title">[\s\S]*?<\/div>/gi, '')).replace(/\s*\n\s*/g, ' ').trim();
}

/** 按 class 遍历 <span> 块，fn 返回替换内容 */
function mapSpansByClass(html, cls, fn) {
  const marker = '<span class="' + cls + '"';
  let out = '';
  let i = 0;
  for (;;) {
    const at = html.indexOf(marker, i);
    if (at < 0) { out += html.slice(i); break; }
    out += html.slice(i, at);
    const end = sliceBalancedTag(html, at, 'span');
    if (end < 0) { out += html.slice(at); break; }
    out += fn(html.slice(at, end));
    i = end;
  }
  return out;
}

/**
 * MathJax 渲染块 → $TeX$。
 * 结构（MathJax v2 on CF）：<span class="MathJax">…渲染结果…</span><script type="math/tex">TeX</script>
 * —— TeX 源是渲染 span 的**后继兄弟节点**（也可能在 span 内部），两者都处理。
 * 这样既得到干净的 LaTeX（前端 KaTeX 可渲染、模型也好读），又消除重复文本。
 */
function mathJaxToTex(html) {
  const marker = '<span class="MathJax"';
  let out = '';
  let i = 0;
  for (;;) {
    const at = html.indexOf(marker, i);
    if (at < 0) { out += html.slice(i); break; }
    out += html.slice(i, at);
    const end = sliceBalancedTag(html, at, 'span');
    if (end < 0) { out += html.slice(at); break; }
    const block = html.slice(at, end);
    let next = end;
    let tex = null;
    const inner = block.match(/<script[^>]*type="math\/tex[^"]*"[^>]*>([\s\S]*?)<\/script>/i);
    if (inner) {
      tex = inner[1];
    } else {
      const after = html.slice(end, end + 400);
      const m = after.match(/^\s*<script[^>]*type="math\/tex[^"]*"[^>]*>([\s\S]*?)<\/script>/i);
      if (m) { tex = m[1]; next = end + m[0].length; }
    }
    if (tex != null) {
      const t = decodeEntities(tex).replace(/\s+/g, ' ').trim();
      out += t ? ('$' + t + '$') : '';
    } else {
      // 没有 TeX 源（图片渲染等）：保留可读文本，只去掉给读屏软件的隐藏副本
      out += mapSpansByClass(block, 'MJX_Assistive_MathML', function () { return ''; });
    }
    i = next;
  }
  return out;
}

/**
 * 预处理 HTML：浏览器抓取通道拿到的是 MathJax **渲染后**的 DOM，
 * 与 CF 原始 HTML 结构差别很大（每个公式都有渲染副本 + 隐藏 MathML 副本 + TeX 脚本），
 * 必须先规整再解析：
 * 1) MathJax 渲染块 → $TeX$（消除重复文本，公式可被 KaTeX 渲染）
 * 2) 隐藏预览整块删除
 * 3) 剩余 <script>/<style>/注释 整块删除（含内容）
 *    —— 之前把 `<script` 当题面结束标记，导致题面在第一个公式处被截断
 */
function normalizeRenderedDom(html) {
  let s = String(html || '');
  s = mapSpansByClass(s, 'MathJax_Preview', function () { return ''; });
  s = mathJaxToTex(s);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  return s;
}

/** 从题面页 HTML 提取题面（含样例） */
function parseProblemPage(html, contestId, index) {
  const page = normalizeRenderedDom(html);
  const startM = page.search(/<div class="problem-statement/i);
  if (startM < 0) {
    const err = new Error('未能从 Codeforces 页面解析题面（页面结构可能已变化）');
    err.code = 'CF_PARSE';
    throw err;
  }
  const rest = page.slice(startM);

  // header 块（标题 / 时限 / 内存）——用配对 div 精确切出
  const headerStart = rest.search(/<div class="header">/i);
  const headerEnd = headerStart >= 0 ? sliceBalancedDiv(rest, headerStart) : -1;
  const headerHtml = headerEnd > 0 ? rest.slice(headerStart, headerEnd) : '';
  const titleM = headerHtml.match(/<div class="title">([\s\S]*?)<\/div>/i);
  const title = titleM ? htmlToText(titleM[1]) : (index + '. Problem');
  const timeLimit = divBlockText(headerHtml, 'time-limit').replace(/^time limit per test\s*/i, '').trim();
  const memoryLimit = divBlockText(headerHtml, 'memory-limit').replace(/^memory limit per test\s*/i, '').trim();

  // 正文：header 之后 → 样例/注释之前（注意：绝不能用 <script 当结束标记）
  const bodyStart = headerEnd > 0 ? headerEnd : (rest.indexOf('>') + 1);
  const stops = [
    '<div class="sample-tests"', '<div class="sample-test"',
    '<div class="note"', '<div class="problem-statement-footer'
  ];
  let bodyEnd = rest.length;
  stops.forEach(function (m) {
    const at = rest.indexOf(m, bodyStart);
    if (at >= 0 && at < bodyEnd) bodyEnd = at;
  });
  const statement = htmlToText(rest.slice(bodyStart, Math.max(bodyStart, bodyEnd)));

  // 样例（兼容 sample-tests / sample-test 两种 class、<pre> 带属性的渲染版，
  //        以及「每组样例一个 sample-test」与「一个 sample-test 内多组」两种结构）
  const samples = [];
  const sampleAt = page.search(/<div class="sample-tests?"/i);
  if (sampleAt >= 0) {
    const areaEnd = sliceBalancedDiv(page, sampleAt);
    const sampleArea = page.slice(sampleAt, areaEnd > 0 ? areaEnd : Math.min(page.length, sampleAt + 60000));
    // 按出现顺序收集所有 input/output 标记，input 与紧随其后的 output 配成一组
    const marks = [];
    const markRe = /<div class="(input|output)">/gi;
    let mm;
    while ((mm = markRe.exec(sampleArea)) !== null) marks.push({ kind: mm[1], at: mm.index });
    let pending = null;
    for (const mk of marks) {
      const blockEnd = sliceBalancedDiv(sampleArea, mk.at);
      const block = sampleArea.slice(mk.at, blockEnd > 0 ? blockEnd : sampleArea.length);
      const pre = block.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
      const text = pre ? htmlToText(pre[1]).replace(/\r/g, '').trimEnd() : null;
      if (mk.kind === 'input') {
        if (pending) samples.push(pending);
        pending = { input: text != null ? text : '', output: '' };
      } else if (pending) {
        pending.output = text != null ? text : '';
        samples.push(pending);
        pending = null;
      }
    }
    if (pending) samples.push(pending);
    const noteAt = sampleArea.indexOf('<div class="note">');
    if (noteAt >= 0) {
      const noteEnd = sliceBalancedDiv(sampleArea, noteAt);
      const noteBlock = sampleArea.slice(noteAt, noteEnd > 0 ? noteEnd : sampleArea.length);
      const note = htmlToText(noteBlock);
      if (note) samples.push({ note });
    }
  }
  return {
    title,
    timeLimit,
    memoryLimit,
    statement,
    samples
  };
}

/** 网络超时（毫秒）：CF 直连不通时必须快速失败，不能把界面拖死 */
const FETCH_TIMEOUT_MS = Number(process.env.CF_TIMEOUT_MS || 12000);

function timeoutSignal() {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
}

/** 组合「超时」与「外部取消（用户点停止）」两个信号 */
function combinedSignal(external) {
  const t = timeoutSignal();
  if (!external) return t;
  if (!t) return external;
  return (typeof AbortSignal !== 'undefined' && AbortSignal.any) ? AbortSignal.any([t, external]) : external;
}

/** 是否是超时/网络中断错误 */
function isTimeoutError(e) {
  if (!e) return false;
  const name = e.name || '';
  const code = (e.cause && e.cause.code) || e.code || '';
  return name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'ETIMEDOUT';
}

async function fetchJson(url, opts) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: combinedSignal(opts && opts.signal) });
  } catch (e) {
    if (opts && opts.signal && opts.signal.aborted) throw new Error('已取消');
    if (isTimeoutError(e)) throw new Error('访问 Codeforces 超时（' + Math.round(FETCH_TIMEOUT_MS / 1000) + ' 秒）：当前网络可能无法直连，可在设置中配置本地代理');
    throw new Error('无法访问 Codeforces：' + ((e.cause && e.cause.code) || e.message));
  }
  if (!res.ok) throw new Error('Codeforces 请求失败 HTTP ' + res.status);
  return res.json();
}

/**
 * 抓取网页文本：先普通 HTTP；若被 Cloudflare 反爬拦截，改用内嵌 Chromium（Electron）过挑战。
 */
async function fetchText(url, opts) {
  let status = 0;
  let text = '';
  let netError = null;
  const target = desktopUrl(url);
  try {
    const res = await fetch(target, { headers: HEADERS, signal: combinedSignal(opts && opts.signal) });
    status = res.status;
    text = await res.text();
    // 明确的 404/410：这个地址上**没有东西**（换 URL 再试是有意义的，别当成反爬）
    if (status === 404 || status === 410) {
      const err = new Error('Codeforces 返回 HTTP ' + status + '（这个地址上没有内容）');
      err.kind = 'not-found';
      err.status = status;
      throw err;
    }
    if (!looksBlocked(status, text) && text.length > 800) {
      if (looksMobile(text, res.url)) {
        throw new Error('Codeforces 返回了移动版页面（CF 的 mobile 偏好存在 cookie/URL 参数里）。'
          + '本工具只解析桌面版：请稍后重试，或在浏览器打开 https://codeforces.com/?mobile=false 切回桌面版。');
      }
      return text;
    }
  } catch (e) {
    // 404 这类"确定性结论"要直接抛出去（走浏览器通道也没用），其余才记成 netError 继续兜底
    if (e && (e.kind === 'not-found' || /移动版页面/.test(e.message || ''))) throw e;
    netError = e;
  }
  if (opts && opts.signal && opts.signal.aborted) throw new Error('已取消');

  // 反爬兜底：内嵌浏览器加载（Electron 环境）。
  // **两段式**：先用隐藏窗口（安静、快）；若挑战没过，再用"可见但在屏幕外"的窗口重试 ——
  // Cloudflare 的挑战脚本会因为窗口不可见（document.hidden / 没有渲染帧）而拒绝通过，
  // 这是"以前能抓、现在稳定被拦"最可能的原因（实测：同一台机器隐藏窗口失败、可见窗口成功）。
  if (browserFetcher) {
    const attempts = [
      { visible: false, why: '隐藏窗口' },
      { visible: true, why: '可见窗口（隐藏窗口没过挑战时改用）' }
    ];
    for (const att of attempts) {
      if (opts && opts.signal && opts.signal.aborted) throw new Error('已取消');
      try {
        if (att.visible && typeof browserFetcher.length === 'number' && browserFetcher.length === 1) {
          // 注入的抓取器只接受一个参数（旧签名）：可见模式无法传达 → 只试一次，别白等
          continue;
        }
        const html = await browserFetcher(target, { visible: att.visible });
        if (html && html.length > 800 && !looksBlocked(200, html)) {
          if (looksMobile(html, '')) {
            throw new Error('Codeforces 返回了移动版页面（CF 的 mobile 偏好存在 cookie/URL 参数里）。'
              + '本工具只解析桌面版：请稍后重试，或在浏览器打开 https://codeforces.com/?mobile=false 切回桌面版。');
          }
          console.log('[cf] 浏览器抓取成功（' + att.why + '）');
          return html;
        }
        console.log('[cf] 浏览器抓取未通过（' + att.why + '）：内容长度 ' + (html ? html.length : 0));
      } catch (e) {
        console.log('[cf] 浏览器抓取失败（' + att.why + '）: ' + (e && e.message));
        if (/移动版页面/.test(e && e.message || '')) throw e;
        // "地址本身不成立"（题号/比赛不存在/无权限）不是反爬问题：换可见窗口重试也没用，
        // 只会让用户白等十几秒。直接抛出去，让下面按总表给出准确结论。
        if (e && e.notFound) throw e;
      }
    }
  }
  if (opts && opts.signal && opts.signal.aborted) throw new Error('已取消');

  if (netError) {
    if (isTimeoutError(netError)) {
      throw new Error('访问 Codeforces 超时（' + Math.round(FETCH_TIMEOUT_MS / 1000) + ' 秒）：当前网络无法直连，可在设置中配置本地代理后重试，或直接把题面粘贴到输入框。');
    }
    throw new Error('无法访问 Codeforces：' + (netError.cause && netError.cause.code ? netError.cause.code : netError.message));
  }
  if (status === 403 || looksBlocked(status, text)) {
    throw new Error('题面抓取被 Codeforces 反爬拦截（Cloudflare 403）。可尝试：① 在设置中配置本地代理（如 http://127.0.0.1:7890）；'
      + '② 直接把题面粘贴到输入框。题目难度与标签已通过官方 API 获取。');
  }
  if (!text) throw new Error('Codeforces 返回了空内容');
  return text;
}

/**
 * 抓取题面页：校验落地页是否为目标题目页。
 *
 * ⚠️ 这里必须把两种失败**分清楚**，因为它们的出路完全不同：
 *   ① 反爬挑战（Cloudflare 拦了）→ 出路是"过挑战 / 配代理 / 粘贴题面"；
 *   ② 这道题根本不存在（题号写错、比赛不在公开总表里、gym 无权限）→
 *      CF 会把请求 302 到首页或别的题，页面**没有** Cloudflare 特征。
 * 旧实现一律报"被反爬重定向"，于是用户看到"被拦截了"，其实是题号不存在
 * （真实事故：用户查 2269D，而 2269 只有 A/B 两题，界面上却显示"题面被反爬拦截"）。
 */
async function fetchProblemPage(url, contestId, index, opts) {
  const text = await fetchText(url, opts);
  const stmtRe = /<div class="problem-statement/;
  const blocked = looksBlocked(200, text);
  const antiBotErr = '题面抓取被 Codeforces 反爬拦截（Cloudflare）。可尝试：① 在设置中配置本地代理；'
    + '② 稍后重试；③ 直接把题面粘贴到输入框。';
  /**
   * 错误必须带**结构化类型**，不能靠上层拿正则去猜文案：
   * 曾经上层用 /反爬|挑战/ 判断"要不要换个 URL 再试"，结果这句话里的"既不是挑战页"
   * 被当成了"遇到挑战" → 第一个 URL 一失败就放弃，备用 URL 永远试不到（e2e 抓到的真事故）。
   *   kind='blocked'  反爬拦截（换 URL 没用，直接抛）
   *   kind='not-page' 不是题目页（值得换 URL 再试）
   *   kind='not-found' 明确 404
   */
  if (!stmtRe.test(text)) {
    if (blocked) {
      const err = new Error(antiBotErr);
      err.kind = 'blocked';
      throw err;
    }
    const err = new Error('题面抓取失败：这个地址返回的不是题目页（既没有题面结构，也没有反爬挑战特征）——'
      + '通常是**这道题不存在或不可见**（题号写错 / 比赛未公开 / gym 需要权限）。'
      + '请核对题号；也可以直接把题面粘贴到输入框。');
    err.kind = 'not-page';
    throw err;
  }
  const redirectErr = '题面抓取失败：Codeforces 返回的不是目标题目（请求的页面被重定向到别处，'
    + '通常是**题号不存在**；也可能是反爬）。请核对题号；也可以直接把题面粘贴到输入框。';

  // 校验 1：页面自身的 <title>Problem - 1800C - Codeforces</title> 必须对应请求的题目
  const pageTitleM = text.match(/<title>\s*Problem\s*-\s*([0-9]+)\s*([A-Za-z][0-9]?)\s*-\s*Codeforces/i);
  const titleMismatch = !!(pageTitleM && (String(pageTitleM[1]) !== String(contestId)
    || String(pageTitleM[2]).toUpperCase() !== String(index).toUpperCase()));

  // 校验 2：题面里的标题（如 "C. Powering the Hero"）应包含目标序号
  const want = String(index).toUpperCase() + '.';
  const head = text.slice(text.search(stmtRe), text.search(stmtRe) + 4000);
  const titleM = head.match(/<div class="title">([\s\S]{0,200}?)<\/div>/);
  const stmtTitle = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : '';
  const stmtMismatch = !!(stmtTitle && stmtTitle.toUpperCase().indexOf(want) !== 0 && stmtTitle.indexOf(String(contestId)) < 0);

  if (titleMismatch || stmtMismatch) {
    const got = pageTitleM ? (pageTitleM[1] + pageTitleM[2]) : '';
    const err = new Error(redirectErr
      + (got ? '（实际拿到的是 ' + got + '）' : '')
      + (stmtTitle ? '（页面标题：' + stmtTitle.slice(0, 40) + '）' : ''));
    err.kind = 'not-page';
    throw err;
  }
  return text;
}

/**
 * 全量题目总表（contestId+index → name/rating/tags）。
 * 说明：CF 的 contest.standings 现在对非 gym 比赛只允许「不带任何附加参数」的匿名请求，
 * 老写法 ?contestId=&from=&count= 会直接 400；而 problemset.problems 一次返回全部题目（约 2MB），
 * 落盘缓存 24 小时，既能补 rating/tags，也能在断网/被反爬时离线可用。
 */
let problemsetMap = null;
let problemsetLoading = null;
let problemsetRetryAfter = 0;   // 拉取失败后的退避时间（避免每次查元数据都重试 2MB 请求）
// 注意：CF_BASE 被覆盖（测试用 mock）时不落盘，避免 mock 数据与真实数据互相污染
const PERSIST_PROBLEMSET = !process.env.CF_BASE;
const PROBLEMSET_FILE = () => (cacheDir && PERSIST_PROBLEMSET ? path.join(cacheDir, 'cache', 'problemset.json') : null);

function buildProblemsetMap(list) {
  const map = new Map();
  for (const p of list) {
    if (!p || p.contestId == null) continue;
    map.set(String(p.contestId) + String(p.index).toUpperCase(), {
      name: p.name || '', rating: p.rating || 0, tags: p.tags || []
    });
  }
  return map;
}

async function getProblemsetIndex() {
  if (problemsetMap) return problemsetMap;
  if (problemsetLoading) return problemsetLoading;
  if (Date.now() < problemsetRetryAfter) return null;
  problemsetLoading = (async () => {
    const file = PROBLEMSET_FILE();
    let disk = null;
    try {
      if (file && fs.existsSync(file)) disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { /* 缓存损坏则忽略 */ }
    const fresh = disk && disk.at && (Date.now() - disk.at < PROBLEMSET_TTL_MS) && Array.isArray(disk.problems) && disk.problems.length;
    if (fresh) return (problemsetMap = buildProblemsetMap(disk.problems));
    try {
      const j = await fetchJson(CF_BASE + '/api/problemset.problems');
      const problems = (j && j.result && j.result.problems) || [];
      if (problems.length) {
        try {
          if (file) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ at: Date.now(), problems }));
          }
        } catch (e) { /* 写缓存失败不影响功能 */ }
        console.log('[cf] 题目总表已更新：' + problems.length + ' 题');
        return (problemsetMap = buildProblemsetMap(problems));
      }
    } catch (e) {
      console.log('[cf] 题目总表获取失败: ' + e.message);
    }
    // 过期的磁盘缓存也好过没有
    if (disk && Array.isArray(disk.problems) && disk.problems.length) {
      return (problemsetMap = buildProblemsetMap(disk.problems));
    }
    problemsetRetryAfter = Date.now() + 10 * 60 * 1000;
    return null;
  })();
  try { return await problemsetLoading; } finally { problemsetLoading = null; }
}

/**
 * 比赛总表（CF 官方 API，无 Cloudflare）：用来**快速**判断"这个比赛号到底存不存在"。
 *
 * 为什么需要：题号写错时，CF 会把题目页 302 到首页/别的题，浏览器通道要耗 20~40 秒才失败，
 * 然后报一句含糊的"不是目标题目"。有了比赛总表，比赛号不存在就能**立刻**说清楚
 * （真实事故：用户查 2698D，白等半分钟，还被告知"被反爬拦截"）。
 * 缓存 24 小时，失败退避 10 分钟——它只是用来"更早给出准确原因"，拿不到就退回原来的行为。
 */
let contestSet = null;
let contestLoading = null;
let contestRetryAfter = 0;
const CONTEST_TTL_MS = 24 * 60 * 60 * 1000;

async function getContestIndex() {
  if (contestSet) return contestSet;
  if (contestLoading) return contestLoading;
  if (Date.now() < contestRetryAfter) return null;
  contestLoading = (async () => {
    const file = PROBLEMSET_FILE();
    const cfile = file ? path.join(path.dirname(file), 'contest-list.json') : null;
    let disk = null;
    try {
      if (cfile && fs.existsSync(cfile)) disk = JSON.parse(fs.readFileSync(cfile, 'utf8'));
    } catch (e) { /* 缓存损坏则忽略 */ }
    if (disk && disk.at && (Date.now() - disk.at < CONTEST_TTL_MS) && Array.isArray(disk.ids) && disk.ids.length) {
      return (contestSet = new Set(disk.ids.map(String)));
    }
    /**
     * ⚠️ CF 的 contest.list 语义有坑（实测）：**`?gym=true` 只返回 gym 比赛**，
     * 常规比赛一场都没有；不带参数或 `gym=false` 才是常规比赛（也不含 gym）。
     * 只取一边就会把另一边误判成"比赛不存在"（我踩过：1799 被说成不存在）。
     * 所以两边都取，取并集；单个失败不影响另一边。
     */
    const grab = async (q) => {
      try {
        const j = await fetchJson(CF_BASE + '/api/contest.list' + q);
        return ((j && j.result) || []).map((c) => String(c.id));
      } catch (e) {
        console.log('[cf] 比赛总表获取失败(' + (q || '全部') + '): ' + e.message);
        return [];
      }
    };
    const [regular, gyms] = await Promise.all([grab(''), grab('?gym=true')]);
    const ids = [...new Set(regular.concat(gyms))];
    if (ids.length) {
      try {
        if (cfile) {
          fs.mkdirSync(path.dirname(cfile), { recursive: true });
          fs.writeFileSync(cfile, JSON.stringify({ at: Date.now(), ids }));
        }
      } catch (e) { /* 写缓存失败不影响功能 */ }
      console.log('[cf] 比赛总表已更新：常规 ' + regular.length + ' + gym ' + gyms.length + ' = ' + ids.length + ' 场');
      return (contestSet = new Set(ids));
    }
    if (disk && Array.isArray(disk.ids) && disk.ids.length) return (contestSet = new Set(disk.ids.map(String)));
    contestRetryAfter = Date.now() + 10 * 60 * 1000;
    return null;
  })();
  try { return await contestLoading; } finally { contestLoading = null; }
}

/**
 * 某场比赛的题号清单（**权威且及时**）。
 *
 * ⚠️ 为什么不能用 problemset 总表下"没有这个题号"的结论：
 * 刚结束的比赛，题目还没进 problemset。实测 2269（Round 1124，当天结束）：
 *   problemset.problems   → 只有 A、B
 *   contest.standings     → A B C D E F（D 确实存在）
 * 用总表判定就会**把存在的题说成不存在**（真实事故：用户查 2269D 被回了一句"没有题号 D"）。
 * contest.standings 不带附加参数时 CF 允许匿名调用（带 from/count 才会 400），gym 需要登录、失败就返回 null。
 *
 * @returns {Promise<Array<{index,name,rating,tags}>|null>} null = 拿不到（此时**不允许**下否定结论）
 */
const contestProblemsCache = new Map();
const contestProblemsLoading = new Map();
async function fetchContestProblems(contestId) {
  const id = String(contestId);
  if (contestProblemsCache.has(id)) return contestProblemsCache.get(id);
  if (contestProblemsLoading.has(id)) return contestProblemsLoading.get(id);
  const p = (async () => {
    let out = null;
    try {
      const j = await fetchJson(CF_BASE + '/api/contest.standings?contestId=' + encodeURIComponent(id));
      const problems = (j && j.result && j.result.problems) || [];
      if (problems.length) {
        out = problems.map((x) => ({
          index: String(x.index || '').toUpperCase(),
          name: x.name || '',
          rating: x.rating || 0,
          tags: x.tags || []
        }));
      }
    } catch (e) {
      out = null;   // gym / 无权限 / 网络失败：拿不到就不能下结论
    }
    contestProblemsCache.set(id, out);
    contestProblemsLoading.delete(id);
    return out;
  })();
  contestProblemsLoading.set(id, p);
  return p;
}

/** 这道题在 CF 上的规范地址：gym 走 /gym，其余走 /contest（比赛页对**新旧比赛**都成立） */
function problemUrls(contestId, index) {
  const id = String(contestId);
  const idx = String(index).toUpperCase();
  const isGym = /^\d{6,}$/.test(id) && Number(id) >= 100000;
  return isGym
    ? [CF_BASE + '/gym/' + id + '/problem/' + idx]
    : [CF_BASE + '/contest/' + id + '/problem/' + idx, CF_BASE + '/problemset/problem/' + id + '/' + idx];
}

/** 后台预热题目总表（启动时调用；失败静默） */
function warmup() {
  getProblemsetIndex().catch(() => {});}

/** 获取题目元数据（rating/tags/name），失败返回 null（不阻塞） */
async function fetchProblemMeta(contestId, index) {
  const key = 'meta:' + contestId + index;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let meta = null;

  /**
   * 顺序很重要：**先总表（本地、便宜），未命中再问这场比赛自己的题表**。
   * 反过来（或只用总表）会出真事故：刚结束的比赛题目还没进总表，
   * 只查总表就会把存在的题判成"查不到"，界面显示"题目不存在"（2269D 就是这么被误报的）。
   */
  const idx = await getProblemsetIndex().catch(() => null);
  if (idx) {
    const p = idx.get(String(contestId) + String(index).toUpperCase());
    if (p) meta = { name: p.name, rating: p.rating, tags: p.tags };
  }
  if (!meta) {
    const cp = await fetchContestProblems(contestId).catch(() => null);
    if (cp) {
      const p = cp.find((x) => x.index === String(index).toUpperCase());
      if (p) meta = { name: p.name, rating: p.rating || null, tags: p.tags || [] };
    }
  }
  if (!meta) {
    // 兜底：仅 gym 允许带参数调用 contest.standings（非 gym 现在只接受不含任何附加参数的匿名请求）
    if (Number(contestId) >= 100000) {
      try {
        const j = await fetchJson(CF_BASE + '/api/contest.standings?contestId=' + contestId + '&from=1&count=1');
        const problems = (j && j.result && j.result.problems) || [];
        const p = problems.find((x) => String(x.index).toUpperCase() === String(index).toUpperCase());
        if (p) meta = { name: p.name, rating: p.rating, tags: p.tags || [] };
      } catch (e) { /* 元数据只是增强，失败不抛 */ }
    }
  }
  cacheSet(key, meta);
  return meta;
}

/** 获取完整题面（网页解析 + 元数据）
 *  opts.signal 支持用户点「停止」时立刻取消抓取（浏览器通道最长 60 秒，不取消会一直等） */
async function fetchProblem(contestId, index, opts) {
  contestId = parseInt(contestId, 10);
  index = String(index || '').toUpperCase();
  if (!(contestId > 0) || !/^[A-Z][0-9]?$/.test(index)) {
    throw new Error('题目编号格式不正确（示例：1800 C 或 1800C）');
  }
  const key = 'problem:' + contestId + index;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  // 题号预校验用的**权威来源**是这场比赛自己的题表（contest.standings），见下面 fetchContestProblems。
  // 刻意不在这里读 problemset 总表：它对刚结束的比赛不完整，用它判定会把存在的题说成不存在。
  const noSuchIndex = 'Codeforces ' + contestId + ' 没有题号 ' + index + '；该比赛的题号是：';
  /**
   * 判"题号不存在"的权威来源是**这场比赛自己的题表**（contest.standings），
   * 不是 problemset 总表 —— 刚结束的比赛题目还没进总表，用总表会把存在的题说成不存在（2269D 真事故）。
   * 但 standings 要一次网络请求，所以只在**总表里查不到**时才去问它：
   * 老题（总表里有）走本地快路径，新题（总表里没有）才多花一次请求换取正确性。
   */
  const psIdx = await getProblemsetIndex().catch(() => null);
  const inProblemset = !!(psIdx && psIdx.get(String(contestId) + index));
  const contestProblems = inProblemset ? null : await fetchContestProblems(contestId).catch(() => null);
  const contestIndexes = contestProblems ? contestProblems.map((p) => p.index) : null;
  if (!inProblemset && contestIndexes && contestIndexes.length && contestIndexes.indexOf(index) < 0) {
    throw new Error(noSuchIndex + contestIndexes.join(' / ') + '。请改用正确题号（题目难度与标签仍然可用）。');
  }
  // 比赛号本身不存在 → 立刻说清楚，别去浏览器里空等 20~40 秒
  if (!inProblemset && !contestProblems && (!psIdx || ![...psIdx.keys()].some((k) => k.startsWith(String(contestId))))) {
    const contests = await getContestIndex().catch(() => null);
    if (contests && !contests.has(String(contestId))) {
      throw new Error('Codeforces 上没有比赛 ' + contestId + '（题号写错了？）。'
        + '请核对比赛号——形如 1800C 表示比赛 1800 的 C 题；也可以直接把题面粘贴到输入框。');
    }
  }

  let html;
  let pageUrl = '';
  let lastErr = null;
  // 按规范地址依次尝试：比赛页（对新旧比赛都成立）→ problemset 页（老题兼容）
  for (const candidate of problemUrls(contestId, index)) {
    try {
      html = await fetchProblemPage(candidate, contestId, index, opts);
      pageUrl = candidate;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      logFetch('抓取尝试失败 ' + candidate + '：' + String(e.message || '').slice(0, 100));
      // 只有"这个地址不成立"才值得换下一个 URL；反爬拦截换 URL 没意义（每个地址都会被同样拦）
      const retriable = (e && (e.kind === 'not-page' || e.kind === 'not-found' || e.notFound === true));
      if (!retriable) break;
    }
  }
  if (lastErr) {
    // 抓取失败 → 先看落盘缓存（同一道题以前抓成功过就能离线用）
    const cached = readProblemCache(contestId, index);
    if (cached) {
      logFetch('抓取失败（' + String(lastErr.message).slice(0, 80) + '）→ 改用题面缓存 ' + contestId + index);
      cacheSet(key, cached);
      return Object.assign({}, cached, {
        fromCache: true,
        warnings: (cached.warnings || []).concat(['本次联网抓取失败，使用的是本地缓存的题面与样例（内容为上次成功抓取的结果）'])
      });
    }
    /**
     * 失败原因必须**说准**（用户看到的"被反爬拦截"曾经把"题号不存在"也说成反爬，
     * 于是他去查代理、以为 CF 封了他）。判据只用**权威来源**：
     *   · contest.standings 说没这个题号 → 题号写错；
     *   · 比赛总表说没这场比赛 → 比赛号写错；
     *   · 否则保留原始抓取原因（可能是反爬，也可能是别的问题）。
     */
    const msg = String(lastErr.message || '');
    const looksNotFound = !!(lastErr && (lastErr.kind === 'not-page' || lastErr.kind === 'not-found'
      || lastErr.notFound === true || /不是目标题目|没有题面结构|不可见|被重定向/.test(msg)));
    if (looksNotFound && contestIndexes && contestIndexes.length) {
      logFetch('题号不存在 ' + contestId + index + '（该比赛题号：' + contestIndexes.join('/') + '）');
      throw new Error(noSuchIndex + contestIndexes.join(' / ') + '。请改用正确题号（题目难度与标签仍然可用）。');
    }
    if (looksNotFound && !contestProblems) {
      const contests = await getContestIndex().catch(() => null);
      if (contests && !contests.has(String(contestId))) {
        logFetch('比赛不存在 ' + contestId);
        throw new Error('Codeforces 公开题表里没有比赛 ' + contestId
          + '——它可能是 gym / 未公开比赛，或者比赛号写错了。请核对比赛号；也可以直接把题面粘贴到输入框。');
      }
    }
    logFetch('抓取失败且无缓存 ' + contestId + index + '：' + msg.slice(0, 120));
    throw lastErr;
  }
  const parsed = parseProblemPage(html, contestId, index);
  const meta = await fetchProblemMeta(contestId, index);

  // 完整性校验：抓到的题面若被截断 / 缺样例，必须显式告诉用户与模型，
  // 否则模型会拿着半道题硬讲（历史事故：题面在第一个公式处被截断，模型全程误解题意）。
  const warnings = [];
  const pairs = parsed.samples.filter((s) => s.input != null);
  if (!parsed.statement || parsed.statement.length < 300) {
    warnings.push('题面正文仅 ' + (parsed.statement || '').length + ' 字，可能未完整抓取');
  } else if (!/Output/i.test(parsed.statement)) {
    warnings.push('题面缺少 Output 段落，可能被截断');
  }
  if (!pairs.length) warnings.push('未解析到官方样例输入输出（无法对拍验证）');
  if (!parsed.timeLimit || !parsed.memoryLimit) warnings.push('未解析到时限/内存');
  if (warnings.length) console.log('[cf] 题面完整性告警 ' + contestId + index + ': ' + warnings.join('；'));

  const result = Object.assign({ contestId, index, sourceUrl: pageUrl }, parsed, meta || {}, { warnings });
  cacheSet(key, result);
  writeProblemCache(contestId, index, result);   // 落盘：以后断网/被反爬也能用
  logFetch('抓取成功 ' + contestId + index + '（题面 ' + String(result.statement || '').length + ' 字，样例 '
    + pairs.length + ' 组' + (warnings.length ? '，告警 ' + warnings.length + ' 条' : '') + '）');
  return result;
}

/** 获取用户信息与水平评估 */
async function fetchUser(handle) {
  handle = String(handle || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(handle)) throw new Error('Codeforces 用户名格式不正确');
  const key = 'user:' + handle.toLowerCase();
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const j = await fetchJson(CF_BASE + '/api/user.info?handles=' + encodeURIComponent(handle));
  const users = (j && j.result) || [];
  if (!users.length) throw new Error('Codeforces 上找不到用户 ' + handle);
  const u = users[0];
  const rating = u.rating || 0;
  let levelText, levelDesc;
  if (rating < 1200) { levelText = '新秀 (Newbie)'; levelDesc = '入门阶段：讲解要放慢节奏，补充基础概念、语法细节和每一步的推导'; }
  else if (rating < 1400) { levelText = 'Pupil'; levelDesc = '基础阶段：重点讲透核心思路与易错点，代码逐行解释'; }
  else if (rating < 1600) { levelText = 'Specialist'; levelDesc = '进阶阶段：可略过基础语法，聚焦算法选择、复杂度分析与实现细节'; }
  else if (rating < 1900) { levelText = 'Expert'; levelDesc = '熟练阶段：讲解点到为止，重点讨论边界情况、优化与证明'; }
  else if (rating < 2100) { levelText = 'Candidate Master'; levelDesc = '高水平：直接给关键观察与证明，讨论可优化的常数与替代做法'; }
  else { levelText = 'Master+'; levelDesc = '顶尖水平：简洁给出核心洞察与证明，可讨论题目扩展与更难的变体'; }
  const result = {
    handle: u.handle,
    rating,
    rank: u.rank || '',
    maxRating: u.maxRating || 0,
    maxRank: u.maxRank || '',
    levelText,
    levelDesc
  };
  cacheSet(key, result);
  return result;
}

/** 聚合用户 AC 题目统计（用于学员信息卡） */
async function fetchSolvedStats(handle) {
  handle = String(handle || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(handle)) throw new Error('Codeforces 用户名格式不正确');
  const key = 'solved:' + handle.toLowerCase();
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const j = await fetchJson(CF_BASE + '/api/user.status?handle=' + encodeURIComponent(handle) + '&from=1&count=1000');
  const subs = (j && j.result) || [];
  const solvedMap = new Map();
  const byTag = {};
  const byRating = {};
  const recent = [];
  for (const s of subs) {
    if (!s || s.verdict !== 'OK' || !s.problem) continue;
    const pr = s.problem;
    const k = pr.contestId + pr.index;
    if (solvedMap.has(k)) continue;
    solvedMap.set(k, { contestId: pr.contestId, index: pr.index, name: pr.name || '', rating: pr.rating || 0, tags: pr.tags || [] });
    recent.push({ contestId: pr.contestId, index: pr.index, name: pr.name || '', rating: pr.rating || 0 });
    (pr.tags || []).forEach((t) => { byTag[t] = (byTag[t] || 0) + 1; });
    if (pr.rating) byRating[String(pr.rating)] = (byRating[String(pr.rating)] || 0) + 1;
  }
  const list = [...solvedMap.values()];
  const rated = list.filter((p) => p.rating);
  const stats = {
    handle,
    totalSubmissions: subs.length,
    solvedCount: list.length,
    avgSolvedRating: rated.length ? Math.round(rated.reduce((s, p) => s + p.rating, 0) / rated.length) : 0,
    byRating,
    topTags: Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tag, count]) => ({ tag, count })),
    recentSolved: recent.slice(0, 15)
  };
  cacheSet(key, stats);
  return stats;
}

/** 近期 rating 变化历史（用于折线图） */
async function fetchRatingHistory(handle) {
  handle = String(handle || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(handle)) throw new Error('Codeforces 用户名格式不正确');
  const key = 'rating:' + handle.toLowerCase();
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const j = await fetchJson(CF_BASE + '/api/user.rating?handle=' + encodeURIComponent(handle));
  const list = (j && j.result) || [];
  const out = list.map((r) => ({
    contestId: r.contestId,
    contestName: r.contestName || '',
    rank: r.rank,
    oldRating: r.oldRating,
    newRating: r.newRating,
    ratingUpdatedAt: r.ratingUpdateTimeSeconds ? r.ratingUpdateTimeSeconds * 1000 : null
  }));
  cacheSet(key, out);
  return out;
}

/** 只读缓存（不发起网络请求）：用于「我的」页秒开，网络数据随后异步补齐 */
function peekUser(handle) {
  const h = String(handle || '').trim().toLowerCase();
  return h ? cacheGet('user:' + h) : undefined;
}

function peekSolved(handle) {
  const h = String(handle || '').trim().toLowerCase();
  return h ? cacheGet('solved:' + h) : undefined;
}

function peekRating(handle) {
  const h = String(handle || '').trim().toLowerCase();
  return h ? cacheGet('rating:' + h) : undefined;
}

module.exports = {
  fetchProblem, fetchUser, fetchSolvedStats, fetchRatingHistory, fetchProblemMeta,
  setBrowserFetcher, setCacheDir, warmup, peekUser, peekSolved, peekRating, CF_BASE,
  desktopUrl, looksMobile,
  // 供测试/诊断使用
  parseProblemPage
};
