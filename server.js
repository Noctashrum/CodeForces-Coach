/**
 * cf-coach — 本地优先的大模型对话客户端服务端
 * 特性：
 *  - 零依赖（仅 Node >= 18 内置模块）
 *  - 所有数据保存在本地 data/ 目录（config.json + 每个会话一个 JSON 文件）
 *  - 聊天代理：OpenAI 兼容接口 / Anthropic 接口，SSE 流式透传
 *  - 会话归档（物理移动到 data/archive/）
 *  - 仅监听 127.0.0.1，不暴露到局域网
 * 启动：node server.js   （PORT / HOST 环境变量可覆盖）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cf = require('./lib/cf');
const runner = require('./lib/runner');
const workspace = require('./lib/workspace');
const harness = require('./lib/harness');
const statementLib = require('./lib/statement');
const profileLib = require('./lib/profile');
const pricing = require('./lib/pricing');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录：桌面打包版通过 CHATBOX_DATA_DIR 指向可执行文件旁的 data/（便携式），
// 开发/web 模式默认使用项目内 data/
const DATA_DIR = process.env.CHATBOX_DATA_DIR
  ? path.resolve(process.env.CHATBOX_DATA_DIR)
  : path.join(ROOT, 'data');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const ARCH_DIR = path.join(DATA_DIR, 'archive');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3210', 10);
const APP_VERSION = '1.0.0';

/* ---------------- 基础工具 ---------------- */

/**
 * stdout 写入防护：作为 Electron 内嵌服务运行时父进程管道可能已断开，
 * 此时任何 console.log 都会抛 EPIPE（未捕获会让主进程崩溃弹窗）。这里统一吞掉。
 */
(function guardStdio() {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') stream.on('error', () => { /* 忽略写入失败 */ });
  }
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = function () { try { origLog.apply(null, arguments); } catch (e) { /* ignore */ } };
  console.error = function () { try { origErr.apply(null, arguments); } catch (e) { /* ignore */ } };
})();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR); ensureDir(CONV_DIR); ensureDir(ARCH_DIR);
cf.setCacheDir(DATA_DIR);   // 题目总表落盘缓存（data/cache/problemset.json），断网也能查 rating/tags
workspace.setRoot(DATA_DIR); // 每题工作区（data/workspace/<会话id>/）：题解 / 暴力 / 生成器缓冲区

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    // 文件损坏时备份并重建
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
    return fallback;
  }
}

function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(file); } catch {}
    fs.renameSync(tmp, file);
  }
}

function writeJSONAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch { reject(new HttpError(400, 'JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 配置 ---------------- */

const DEFAULT_CONFIG = {
  version: 1,
  theme: 'dark',                    // light | dark | auto（CF 教练默认深色）
  sendShortcut: 'enter',            // enter | ctrlenter
  systemPrompt: '',                 // 保留字段（教练模式下由教练提示词接管）
  defaultProviderId: '',            // 默认模型服务
  defaultModel: '',                 // 默认模型名
  defaultParams: { temperature: 0.6, topP: 1, maxTokens: 0 },
  cfHandle: '',                     // Codeforces 用户名（讲解深度与信息卡数据来源）
  cfProxy: '',                      // 题面抓取用的本地代理（可选，如 http://127.0.0.1:7890）
  defaultCoachLang: 'cpp',          // 讲解语言：cpp | python
  agentModels: {},                  // 多 Agent 分工模型：{ solution|brute|gen|explainer: "providerId::model" }
  maxOutputTokens: 0,               // 单次输出上限（max_tokens）：0 = 不指定，用服务商默认
                                    // （推理型模型设小了会把预算全花在思考上，正文反而拿不到；
                                    //   富讲解默认靠服务商上限，用户显式设置时才发这个字段）
  pricing: {},                      // 单价覆盖（元/百万 token）：{ "providerId::model": { in, out } }
  sandbox: true,                    // 代码沙箱（限制生成代码读写沙箱目录之外的文件 / 访问网络；缓解措施）
  sandboxAllowNetwork: false,       // 是否允许生成代码访问网络（默认禁止）
  quickPrompts: [
    '帮我写一份本周工作周报的模板',
    '解释一下量子纠缠的基本原理',
    '用 Python 实现一个快速排序并逐行注释',
    '把这段文字翻译成英文并润色：今天天气很好，我们去公园散步吧。',
    '帮我规划一个三天两夜的杭州旅行路线',
    '写一首关于秋天的五言绝句'
  ],
  providers: []
  // provider: { id, name, type: 'openai'|'anthropic', baseUrl, apiKey,
  //             extraHeaders: {}, models: [], stream: true, createdAt, isDefault? }
};

let config = null;
function loadConfig() {
  if (!config) {
    const disk = readJSON(CONFIG_FILE, null);
    config = Object.assign({}, DEFAULT_CONFIG, disk || {});
    config.defaultParams = Object.assign({}, DEFAULT_CONFIG.defaultParams, (disk && disk.defaultParams) || {});
    config.providers = Array.isArray(config.providers) ? config.providers : [];
    config.quickPrompts = Array.isArray(config.quickPrompts) && config.quickPrompts.length
      ? config.quickPrompts : DEFAULT_CONFIG.quickPrompts;
    runner.setSandbox({ enabled: config.sandbox !== false, allowNetwork: config.sandboxAllowNetwork === true });
  }
  return config;
}
function saveConfig() {
  writeJSONAtomic(CONFIG_FILE, config);
  runner.setSandbox({ enabled: config.sandbox !== false, allowNetwork: config.sandboxAllowNetwork === true });
}

/* ---------------- 会话存储 ---------------- */

function convDir(archived) { return archived ? ARCH_DIR : CONV_DIR; }
function convPath(id) {
  if (fs.existsSync(path.join(CONV_DIR, id + '.json'))) return path.join(CONV_DIR, id + '.json');
  if (fs.existsSync(path.join(ARCH_DIR, id + '.json'))) return path.join(ARCH_DIR, id + '.json');
  return path.join(CONV_DIR, id + '.json');
}
function loadConv(id) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(id)) return null;
  const p = convPath(id);
  const c = readJSON(p, null);
  if (!c || c.id !== id) return null;
  return c;
}
function saveConv(conv) {
  const from = convPath(conv.id);
  const to = path.join(convDir(!!conv.archived), conv.id + '.json');
  if (from !== to && fs.existsSync(from)) {
    writeFileAtomic(to, JSON.stringify(conv, null, 2));
    try { fs.unlinkSync(from); } catch {}
  } else {
    writeFileAtomic(to, JSON.stringify(conv, null, 2));
  }
}
function deleteConvFile(id) {
  const p = convPath(id);
  try { fs.unlinkSync(p); } catch {}
}

function newConversation(extra) {
  const now = Date.now();
  const cfg = loadConfig();
  return Object.assign({
    id: uid('c_'),
    title: '新对话',
    providerId: cfg.defaultProviderId || '',
    model: cfg.defaultModel || '',
    systemPrompt: '',
    params: { temperature: null, topP: null, maxTokens: null },
    mode: 'coach',         // coach（纯算法教练）；chat 仅为历史兼容保留
    lang: null,            // 讲解语言：null=全局默认，cpp | python
    intent: 'full',        // 提问意图：full | hint | explain | debug | idea
    rich: false,           // 富讲解模式：允许输出可视化 HTML 组件（更耗 token）
    cfProblem: null,       // { contestId, index, title }
    problemMeta: null,     // 题目分类：{ rating, knowledge[], summary, tags[], contest, source }
    createdAt: now,
    updatedAt: now,
    archived: false,
    pinned: false,
    messages: []
  }, extra || {});
}

/** 会话写锁：同一会话的并发修改串行化 */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * 正在生成中的会话集合。
 * 关键：消息的 status='streaming' 只是**持久化痕迹**，进程被强杀 / 响应中断 /
 * 异常路径都可能让它留在文件里；判断「是否真的在生成」必须以这个内存集合为准，
 * 否则会话会被永久卡住（表现为：重新生成报「正在生成中」、界面一直转圈）。
 */
/** 正在生成中的会话 → 立即停止句柄（用户点"停止"时用，不依赖 socket 关闭时机） */
const runStops = new Map();
const activeGenerations = new Set();

/** 清理陈旧的 streaming 状态（没有真实生成在跑时），返回是否有改动 */
function repairStaleStreaming(conv) {
  if (!conv || !Array.isArray(conv.messages)) return false;
  if (activeGenerations.has(conv.id)) return false;
  let dirty = false;
  for (const m of conv.messages) {
    if (m && m.status === 'streaming') {
      m.status = (m.content || m.reasoning) ? 'stopped' : 'error';
      if (m.status === 'error' && !m.error) m.error = '生成被中断';
      dirty = true;
    }
  }
  return dirty;
}

/* ---------------- 内容工具 ---------------- */

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (p && p.type === 'text') return p.text;
      if (p && p.type === 'image_url') return '[图片]';
      return '';
    }).join('');
  }
  return '';
}

function contentHasImage(content) {
  return Array.isArray(content) && content.some((p) => p && p.type === 'image_url');
}

function contentPreview(content, max = 80) {
  const t = contentText(content).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function estTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

/** 转换为上游消息（OpenAI 兼容） */
function toOpenAIMessage(msg) {
  if (Array.isArray(msg.content)) return { role: msg.role, content: msg.content };
  return { role: msg.role, content: String(msg.content || '') };
}

/** 转换为上游消息（Anthropic） */
function toAnthropicMessage(msg) {
  if (Array.isArray(msg.content)) {
    const blocks = [];
    for (const part of msg.content) {
      if (!part) continue;
      if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
      if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
        const m = part.image_url.url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/i);
        if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } });
      }
    }
    if (blocks.length) return { role: msg.role, content: blocks };
    return null;
  }
  const t = String(msg.content || '').trim();
  if (!t) return null;
  return { role: msg.role, content: t };
}

/* ---------------- 上游请求 ---------------- */

function joinUrl(base, rel) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  return b + '/' + String(rel).replace(/^\/+/, '');
}

function buildUpstream(provider, model, context, system, params) {
  const extra = provider.extraHeaders || {};
  if (provider.type === 'anthropic') {
    const messages = [];
    for (const msg of context) {
      if (msg.role === 'system') continue;
      const m = toAnthropicMessage(msg);
      if (m) messages.push(m);
    }
    const body = {
      model,
      max_tokens: (params && params.maxTokens > 0) ? params.maxTokens : 8192,
      stream: provider.stream !== false,
      messages
    };
    if (system) body.system = system;
    if (params && params.temperature != null) body.temperature = params.temperature;
    if (params && params.topP != null) body.top_p = params.topP;
    const headers = {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      ...extra
    };
    return { url: joinUrl(provider.baseUrl, 'v1/messages'), headers, body };
  }
  // OpenAI 兼容
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const msg of context) {
    if (msg.role === 'system') continue;
    const m = toOpenAIMessage(msg);
    if (m.role === 'assistant' && !String(m.content || '').trim()) continue;
    messages.push(m);
  }
  const body = {
    model,
    stream: provider.stream !== false,
    messages
  };
  if (params && params.temperature != null) body.temperature = params.temperature;
  if (params && params.topP != null) body.top_p = params.topP;
  if (params && params.maxTokens > 0) body.max_tokens = params.maxTokens;
  // 流式结尾返回 usage（token 统计的来源）。默认开启：绝大多数 OpenAI 兼容服务支持，
  // 不支持的会在请求阶段报错，callLLM 会自动去掉这个字段重试一次。
  if (provider.includeUsage !== false && provider.type !== 'anthropic') body.stream_options = { include_usage: true };
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + (provider.apiKey || ''),
    ...extra
  };
  return { url: joinUrl(provider.baseUrl, 'chat/completions'), headers, body };
}

function friendlyError(err) {
  if (!err) return '未知错误';
  if (err instanceof HttpError) return err.message;
  const msg = err.message || String(err);
  if (err.cause && err.cause.code === 'ECONNREFUSED') return '无法连接到模型服务（连接被拒绝），请检查 Base URL 与网络';
  if (err.cause && err.cause.code === 'ENOTFOUND') return '无法解析模型服务域名，请检查 Base URL';
  if (err.cause && err.cause.code === 'ECONNRESET') return '模型服务连接被重置';
  return msg.length > 300 ? msg.slice(0, 300) : msg;
}

/** 从上游错误响应中提取可读信息 */
async function upstreamErrorText(res) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      if (j.error) {
        if (typeof j.error === 'string') return j.error;
        return j.error.message || JSON.stringify(j.error);
      }
      if (j.message) return j.message;
    } catch {}
    return text.slice(0, 400);
  } catch {
    return 'HTTP ' + res.status;
  }
}

/* ---------------- 流式解析 ---------------- */

/**
 * 统一解析上游 SSE 流，产出事件：
 *   delta {text}, reasoningDelta {text}, usage {promptTokens, completionTokens, model}, finish {}
 * 返回 { contentType } 供错误处理使用（收到 content-type 时回调）
 */
async function pumpUpstream(res, emit) {
  // 回读 content-type：在 fetch 之后通过 res.headers 判断是否走 SSE
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    // 非流式 JSON（服务端忽略了 stream:true 或返回错误）
    if (!res.ok) {
      throw new Error(await upstreamErrorText(res));
    }
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      // Anthropic 非流式
      if (j.type === 'message') {
        const txt = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        emit({ type: 'delta', text: txt });
        if (j.usage) emit({ type: 'usage', promptTokens: j.usage.input_tokens, completionTokens: j.usage.output_tokens });
        emit({ type: 'finish', reason: j.stop_reason || '' });
        return;
      }
      // OpenAI 非流式
      if (j.choices && j.choices[0] && j.choices[0].message) {
        emit({ type: 'delta', text: j.choices[0].message.content || '' });
        if (j.choices[0].message.reasoning_content) emit({ type: 'reasoningDelta', text: j.choices[0].message.reasoning_content });
        if (j.usage) emit({ type: 'usage', promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens });
        emit({ type: 'finish', reason: j.choices[0].finish_reason || '' });
        return;
      }
    } catch {}
    throw new Error('上游返回了无法识别的响应格式');
  }
  if (!res.ok) {
    // SSE 错误流也要读完 body
    await res.text().catch(() => {});
    throw new Error('模型服务返回错误 HTTP ' + res.status);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pendingEvent = null; // anthropic 的 event: 行
  // 收到结束标记后，部分上游不会主动断开 SSE 连接；短暂宽限后主动掐断，
  // 防止聊天卡在"生成中"（客户端光标一直闪烁）
  let finished = false;
  const markFinish = () => { finished = true; };

  const handleDataLine = (data) => {
    if (data === '[DONE]') { emit({ type: 'finish' }); markFinish(); return; }
    let j = null;
    try { j = JSON.parse(data); } catch { return; }
    if (!j) return;
    // Anthropic 事件
    if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta' && j.delta.text) emit({ type: 'delta', text: j.delta.text });
      if (j.delta.type === 'thinking_delta' && j.delta.thinking) emit({ type: 'reasoningDelta', text: j.delta.thinking });
      if (j.delta.type === 'signature_delta') { /* 忽略 */ }
      return;
    }
    if (j.type === 'message_start' && j.message && j.message.usage) {
      emit({ type: 'usage', promptTokens: j.message.usage.input_tokens });
      return;
    }
    if (j.type === 'message_delta') {
      if (j.usage && j.usage.output_tokens != null) emit({ type: 'usage', completionTokens: j.usage.output_tokens });
      if (j.delta && j.delta.stop_reason) { emit({ type: 'finish', reason: j.delta.stop_reason }); markFinish(); }
      return;
    }
    if (j.type === 'message_stop') { emit({ type: 'finish' }); markFinish(); return; }
    if (j.type === 'error') {
      throw new Error((j.error && (j.error.message || j.error.type)) || '上游返回错误');
    }
    // OpenAI 兼容
    if (j.choices && j.choices[0]) {
      const d = j.choices[0].delta || {};
      if (d.content) emit({ type: 'delta', text: d.content });
      if (d.reasoning_content) emit({ type: 'reasoningDelta', text: d.reasoning_content });
      // finish_reason 必须如实带出去：'length' 表示被输出上限截断（正文可能为空），
      // 上层据此决定"去掉上限重试"或给学员一个诚实的截断原因，而不是含糊的"校验没过"
      if (j.choices[0].finish_reason) { emit({ type: 'finish', reason: j.choices[0].finish_reason }); markFinish(); }
    }
    if (j.usage) {
      emit({ type: 'usage', promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens,
        cacheHitTokens: j.usage.prompt_cache_hit_tokens, cacheMissTokens: j.usage.prompt_cache_miss_tokens });
    }
  };

  const processLine = (line) => {
    const l = line.replace(/\r$/, '');
    if (!l || l.startsWith(':')) return;
    if (l.startsWith('event:')) { pendingEvent = l.slice(6).trim(); return; }
    if (l.startsWith('data:')) {
      const data = l.slice(5).trim();
      if (pendingEvent === 'error' && data) {
        pendingEvent = null;
        let j = null; try { j = JSON.parse(data); } catch {}
        throw new Error((j && j.error && (j.error.message || j.error.type)) || '上游返回错误');
      }
      pendingEvent = null;
      handleDataLine(data);
    }
  };

  // 带超时的读取：结束前容忍长时间静默（思考型模型），结束后 2.5 秒无数据即收尾
  const readWithTimeout = (ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('__STALL__')), ms);
    });
    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
  };

  while (true) {
    let step;
    try {
      step = await readWithTimeout(finished ? 2500 : 600000);
    } catch (e) {
      if (e.message === '__STALL__') break; // 上游挂起不关流 → 正常收尾
      throw e;
    }
    const { done, value } = step;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      processLine(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) processLine(buf.trim());
  // 释放上游连接（挂起不关流的情况）：取消失败不影响收尾
  try { await reader.cancel(); } catch (e) { /* ignore */ }
}

/* ---------------- HTTP 路由 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { sendJSON(res, 400, { error: '非法路径' }); return; }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    sendJSON(res, 404, { error: 'Not Found' }); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { sendJSON(res, 404, { error: 'Not Found' }); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------------- API 处理 ---------------- */

function listConversations(query) {
  const q = String(query || '').toLowerCase().trim();
  const wantArch = q.includes('archived:') ? true : undefined;
  const out = [];
  for (const dir of [CONV_DIR, ARCH_DIR]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch {}
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
      const c = readJSON(path.join(dir, f), null);
      if (!c || !c.id) continue;
      if (wantArch !== undefined && !!c.archived !== wantArch) continue;
      if (q) {
        const hay = (c.title + ' ' + c.messages.map((m) => contentText(m.content)).join(' ')).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const last = c.messages.length ? c.messages[c.messages.length - 1] : null;
      out.push({
        id: c.id,
        title: c.title,
        providerId: c.providerId,
        model: c.model,
        archived: !!c.archived,
        pinned: !!c.pinned,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        preview: last ? contentPreview(last.content) : '',
        problemMeta: c.problemMeta || null,
        lastRole: last ? last.role : null
      });
    }
  }
  out.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return out;
}

/* ==================== 算法教练：工具与提示词 ==================== */

function truncStr(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

const LANG_NAMES = { cpp: 'C++23', python: 'Python 3' };

const COACH_INTENTS = {
  full: '完整讲解：按标准流程给出题面拆解、思路、复杂度分析、验证过的完整代码与逐行讲解。',
  hint: '思路提示：用户卡住了，只给关键观察、转化思路与算法方向（含目标复杂度），【不要给完整代码】，可以用伪代码或关键片段。',
  explain: '题干解读：用户没看懂题，只解释题意、样例推导与数据范围的含义，不要讲做法。',
  debug: '代码评估：用户可能贴了自己的代码（问为什么 WA/TLE/RE），也可能只提出一个做法（问"这样写行不行 / 用 XX 能不能过"）。'
    + '两种情况走同一条最重的链路：先给代码做体检或给做法做可行性评估，再用暴力解与正解做三方对拍、必要时最小化反例，'
    + '最后重点讲**错因**或**做法与正解的复杂度差距**。不要直接甩一份完全不同的代码。'
};

const INTENT_LABELS = {
  full: '完整讲解', hint: '思路提示', explain: '题干解读', debug: '代码评估'
};

/** 意图归一化：历史会话里可能存着已下线的意图，统一回落 */
function normalizeIntent(raw) {
  const v = String(raw || '');
  if (v === 'idea') return 'debug';    // 旧的「方案可行性」已并入「代码评估」
  if (v === 'proof') return 'full';    // 旧的「证明与优化」已下线
  return COACH_INTENTS[v] ? v : 'full';
}

/** 会话 → 工作区缓存键（按题号共享，同题跨会话复用已验证产物） */
function wsKeyOf(convId) {
  const conv = loadConv(convId);
  if (!conv) throw new HttpError(404, '会话不存在');
  return workspace.keyFor(conv);
}

/** 取本题官方样例（缓存不足时重新抓题）；供 harness 的样例校准复用 */
async function ensureSamples(conv) {
  let samples = (conv.cfProblemSamples || []).filter((s) => s.input != null);
  if (!samples.length && conv.cfProblem) {
    try {
      const fetched = await cf.fetchProblem(conv.cfProblem.contestId, conv.cfProblem.index);
      conv.cfProblemSamples = fetched.samples;
      saveConv(conv);
      samples = fetched.samples.filter((s) => s.input != null);
    } catch (e) {
      console.log('[coach] 重新取题样例失败: ' + e.message);
    }
  }
  return samples;
}

/** 从用户消息里识别 CF 题号 / 链接（编排器自己取题，不再依赖模型调工具） */
function detectCfRef(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 4000) return null;
  const url = s.match(/(?:problemset\/problem|contest\/\d+\/problem)\/(\d+)\/([A-Za-z][0-9]?)/);
  if (url) return { contestId: url[1], index: url[2].toUpperCase() };
  const marked = s.match(/(?:^|[^A-Za-z])(?:CF|Codeforces|codeforces|cf)\s*[-#:：]?\s*(\d{2,5})\s*[-_ ]?\s*([A-Za-z][0-9]?)\b/);
  if (marked) return { contestId: marked[1], index: marked[2].toUpperCase() };
  // 整条消息基本就是一个题号（如 "1800C" / "1800 C"）
  const bare = s.match(/^[^A-Za-z0-9]{0,6}(\d{3,5})\s*[-_ ]?\s*([A-Za-z][0-9]?)[^A-Za-z0-9]{0,6}$/);
  if (bare) return { contestId: bare[1], index: bare[2].toUpperCase() };
  return null;
}

/** 本机运行环境（缓存一次） */
let runtimesCache = null;
async function getRuntimes() {
  if (!runtimesCache) runtimesCache = await runner.availableRuntimes();
  return runtimesCache;
}
function runtimesText(r) {
  return ['C++ (g++17)', 'Python 3', 'Node.js'].map((label, i) => {
    const ok = i === 0 ? r.cpp : (i === 1 ? r.python : r.js);
    return label + (ok ? '可用' : '不可用');
  }).join('；');
}

/** 教练模式的上游请求骨架 */
/** 单个 agent 的模型选择：配置了 agentModels.<role> = "providerId::model" 时用它（例如 brute 用强模型、gen 用便宜模型） */
function resolveAgentTarget(cfg, provider, model, role) {
  const sel = (cfg.agentModels && cfg.agentModels[role]) || '';
  if (sel && sel.indexOf('::') > 0) {
    const idx = sel.indexOf('::');
    const pid = sel.slice(0, idx);
    const mid = sel.slice(idx + 2);
    const p = (cfg.providers || []).find((x) => x.id === pid);
    if (p && mid) return { provider: p, model: mid };
  }
  return { provider, model };
}

/**
 * 调用一个 agent（隔离上下文：单独 system + 单独 messages，不带会话历史）。
 * stream=true 时把增量透传给前端（讲解 agent 的输出就是最终回答）；
 * 其它 agent 的增量走 agentDelta 事件，前端可实时看到"每个 agent 在干什么"。
 */
async function callAgentLLM(o) {
  const cu = coachUpstream(o.provider, o.model, o.messages, o.system, { maxTokens: o.maxTokens || 0 });
  const bodyObj = Object.assign({}, cu.base, { temperature: 0.2 });
  if (o.provider.type === 'anthropic') {
    bodyObj.system = cu.system;
    bodyObj.messages = cu.messages;
  } else {
    bodyObj.messages = cu.messages;
  }
  // 单次调用超时（强模型思考久，给 12 分钟；避免一次卡死吃掉整轮预算）
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, o.callTimeoutMs || 12 * 60 * 1000);
  const onOuterAbort = () => { try { ctrl.abort(); } catch (e) { /* ignore */ } };
  if (o.signal) {
    if (o.signal.aborted) onOuterAbort();
    else o.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(cu.url, {
      method: 'POST',
      headers: cu.headers,
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (o.signal && o.signal.aborted) throw new Error('已取消');
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new Error('单次模型调用超时（12 分钟）');
    throw e;
  }
  // 个别服务不认识 stream_options.include_usage / max_tokens 上限更小 → 去掉/调小后重试一次
  // （token 统计会退化为估算、输出上限回到服务默认值，都不影响讲解本身）
  if (!res.ok && (bodyObj.stream_options || bodyObj.max_tokens)) {
    const detail = await upstreamErrorText(res).catch(() => '');
    let retry = false;
    if (bodyObj.stream_options && /stream_options|include_usage|unknown|unrecognized|invalid.*(field|param)/i.test(detail)) {
      delete bodyObj.stream_options; retry = true;
    }
    if (bodyObj.max_tokens && /max_?tokens|max_completion_tokens|too large|exceed/i.test(detail)) {
      // 服务商不接受这个上限 → **整个去掉**，改用它的默认值（硬压到 8192 反而会把富讲解截断）
      delete bodyObj.max_tokens; retry = true;
    }
    if (retry) {
      res = await fetch(cu.url, {
        method: 'POST', headers: cu.headers, body: JSON.stringify(bodyObj), signal: ctrl.signal
      });
    } else {
      throw new Error(detail || ('上游返回 HTTP ' + res.status));
    }
  }
  let finishReason = '';
  const pumpOnce = async () => {
    let text = '';
    await pumpUpstream(res, (ev) => {
      if (ev.type === 'delta') {
        text += ev.text;
        if (o.onDelta) o.onDelta(ev.text);
      } else if (ev.type === 'reasoningDelta' && o.onReasoning) {
        o.onReasoning(ev.text);
      } else if (ev.type === 'usage' && o.onUsage) {
        o.onUsage(ev);
      } else if (ev.type === 'finish' && ev.reason) {
        finishReason = String(ev.reason);
      }
    });
    return text;
  };
  try {
    if (!res.ok) throw new Error(await upstreamErrorText(res));
    let text = await pumpOnce();
    // 上限把预算吃光（推理型模型常见：思考用满 → finish_reason=length 且正文为空）：
    // 去掉 max_tokens 原样重试一次，把正文救回来；否则学员只会看到"图文文档没生成成功"。
    if (!String(text || '').trim() && bodyObj.max_tokens && /length|max_tokens/i.test(finishReason)) {
      console.log('[llm] 输出被 max_tokens 截断且正文为空（finish_reason=' + finishReason + '）→ 去掉上限重试一次');
      const retryBody = Object.assign({}, bodyObj);
      delete retryBody.max_tokens;
      const retryRes = await fetch(cu.url, {
        method: 'POST', headers: cu.headers, body: JSON.stringify(retryBody), signal: ctrl.signal
      });
      if (retryRes.ok) {
        res = retryRes;
        finishReason = '';
        text = await pumpOnce();
        if (o.onMeta) o.onMeta({ capRetry: true });
      }
    }
    // 无论哪种情况都把 finish_reason 如实上报：harness 用它区分"真空白"与"被长度上限截断"，
    // 并据此换重试话术（截断 → 要求压缩输出，而不是把同一份长要求再发一遍）
    if (o.onMeta && finishReason) o.onMeta({ finishReason });
    return text;
  } finally {
    clearTimeout(timer);
    if (o.signal) { try { o.signal.removeEventListener('abort', onOuterAbort); } catch (e) { /* ignore */ } }
  }
}

function coachUpstream(provider, model, context, system, params) {
  const extra = provider.extraHeaders || {};
  if (provider.type === 'anthropic') {
    const messages = [];
    for (const msg of context) {
      if (msg.role === 'system') continue;
      const m = toAnthropicMessage(msg);
      if (m) messages.push(m);
    }
    return {
      url: joinUrl(provider.baseUrl, 'v1/messages'),
      headers: Object.assign({ 'content-type': 'application/json', 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' }, extra),
      system,
      messages,
      base: { model, max_tokens: (params && params.maxTokens > 0) ? params.maxTokens : 8192, stream: provider.stream !== false }
    };
  }
  const messages = [{ role: 'system', content: system }];
  for (const msg of context) {
    if (msg.role === 'system') continue;
    const m = toOpenAIMessage(msg);
    if (m.role === 'assistant' && !String(m.content || '').trim()) continue;
    messages.push(m);
  }
  return {
    url: joinUrl(provider.baseUrl, 'chat/completions'),
    headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + (provider.apiKey || '') }, extra),
    messages,
    // max_tokens 只在用户**显式设置**时才发（0/未设 = 交给服务商默认）：
    // 推理型模型（如 deepseek-flash）会把预算先花在思考上，硬塞一个上限会出现
    // finish_reason=length 而正文为空的最坏情况（实测过），此时宁可不要上限。
    base: Object.assign({ model, stream: provider.stream !== false },
      (params && params.maxTokens > 0) ? { max_tokens: params.maxTokens } : {})
  };
}

/* ==================== 学员信息卡（长期记忆） ==================== */

const PROFILE_FILE = path.join(DATA_DIR, 'profile-card.json');

function loadProfile() {
  return readJSON(PROFILE_FILE, null);
}
function saveProfile(p) {
  writeJSONAtomic(PROFILE_FILE, p);
}

/** 从模型输出中提取 JSON 对象（容忍代码块包裹与前后缀文本） */
function extractJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch (e) { /* 继续 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* 继续 */ }
  }
  const backtick = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (backtick) {
    try { return JSON.parse(backtick[1].trim()); } catch (e) { /* 继续 */ }
  }
  return null;
}

/** 构造学情分析请求并调用 LLM，返回解析后的卡片字段 */
async function analyzeProfileWithLLM(cfg, provider, model, userInfo, stats, current, evidence) {
  // 兼容两种入参：证据对象 { evidence:[], kinds:[] }，或旧的对话摘要字符串
  const ev = typeof evidence === 'string'
    ? { evidence: ['（对话摘要，仅供参考）' + evidence.slice(0, 1500)], kinds: ['digest'] }
    : (evidence || { evidence: [], kinds: [] });
  const sys = profileLib.ANALYST_SYSTEM;
  const user = [
    '【学员的 Codeforces 硬数据（由系统提供，直接采信）】',
    'handle: ' + userInfo.handle + '，rating: ' + userInfo.rating + '（' + userInfo.rank + '），历史最高: ' + userInfo.maxRating,
    'AC 题目数（近 1000 条提交内）: ' + stats.solvedCount + '，平均难度: ' + stats.avgSolvedRating,
    '高频标签: ' + (stats.topTags || []).slice(0, 10).map((t) => t.tag + '×' + t.count).join('、'),
    '最近 AC: ' + (stats.recentSolved || []).slice(0, 8).map((p) => p.contestId + p.index + '(' + p.rating + ')').join('、'),
    '',
    '【本次得到的「学员本人行为证据」（只能用它，不能用别的）】',
    ev.evidence.length ? ev.evidence.map((x, i) => (i + 1) + '. ' + x).join('\n') : '（无）',
    '（注意：这里没有、也不会有"教练给出的题解/讲解内容"——不要假设学员完成了题解，也不要评价教练的产出。）',
    '',
    '【当前信息卡（请合并更新，不要重复堆叠；证据不足就原样保留）】',
    (current && (current.profileText || (current.strengths || []).length))
      ? JSON.stringify({
        profileText: current.profileText,
        strengths: current.strengths,
        weaknesses: current.weaknesses,
        focus: current.focus
      })
      : '（暂无）',
    '',
    '提醒：只写宏观能力特征；不要出现"本次/这一轮/这道题"；不要写单轮实现细节；每条 ≤12 字。'
  ].join('\n');

  if (provider.type === 'anthropic') {
    const res = await fetch(joinUrl(provider.baseUrl, 'v1/messages'), {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' }, provider.extraHeaders || {}),
      body: JSON.stringify({ model, max_tokens: 1000, stream: false, system: sys, messages: [{ role: 'user', content: user }] })
    });
    if (!res.ok) throw new Error(await upstreamErrorText(res));
    const j = await res.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return extractJson(text);
  }
  const res = await fetch(joinUrl(provider.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + (provider.apiKey || '') }, provider.extraHeaders || {}),
    body: JSON.stringify({
      model,
      temperature: 0.3,
      stream: false,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
    })
  });
  if (!res.ok) throw new Error(await upstreamErrorText(res));
  const j = await res.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message ? (j.choices[0].message.content || '') : '';
  return extractJson(text);
}

let profileUpdateBusy = false;
const PROFILE_LOG = path.join(DATA_DIR, 'profile-log.jsonl');

/**
 * 对话结束后的信息卡更新。
 *
 * 设计：信息卡是**宏观能力画像**，不是流水账。它必须抵御两种污染——
 * 把"教练给出的题解/讲解"算成学员的成果，以及把单轮实现细节写进 strengths/weaknesses。
 * 因此：
 *  ① 机械证据闸门 collectEvidence：只有"学员自己的代码 / 他自己的提问 / 难度明显偏离"才算证据，
 *    没有新证据就**直接跳过**（连模型都不调）；
 *  ② 送给分析师的只有**证据包 + 旧卡**，绝不喂助手讲解正文；
 *  ③ 回来后过 validateCardUpdate 机械守卫：单轮事件、教练产出、实现细节、过长条目一律拒收，
 *    拒收比例过半则整次更新作废（保留旧卡）；
 *  ④ 每次是否更新、拒了什么，写进 profile-log.jsonl 供排查（界面不展示）。
 */
async function updateProfileCard(conv, cfg, ctx) {
  const handle = (cfg.cfHandle || '').trim();
  if (!handle || profileUpdateBusy) return;
  const provider = cfg.providers.find((p) => p.id === conv.providerId)
    || cfg.providers.find((p) => p.id === cfg.defaultProviderId)
    || cfg.providers[0];
  if (!provider) return;
  const model = conv.model || cfg.defaultModel || (provider.models && provider.models[0]) || '';
  if (!model) return;
  const info = ctx || {};

  /* ① 机械证据闸门：没有关于学员本人的新证据就不动信息卡 */
  const ev = profileLib.collectEvidence({
    intent: info.intent,
    userText: info.userText,
    userCode: info.userCode,
    userCodeFailed: !!(info.minimalCase && info.minimalCase.from === 'user-vs-brute'),
    minimalCase: info.minimalCase,
    lang: conv.lang,
    problemMeta: conv.problemMeta || conv.cfProblem,
    cfAvgSolvedRating: (loadProfile() || {}).avgSolvedRating
  });
  if (!ev.ok) {
    console.log('[profile] 本轮没有学员侧的新证据，跳过信息卡更新');
    return;
  }

  profileUpdateBusy = true;
  try {
    const [userInfo, stats] = await Promise.all([
      cf.fetchUser(handle).catch(() => null),
      cf.fetchSolvedStats(handle).catch(() => null)
    ]);
    if (!userInfo || !stats) return;
    const current = loadProfile() || {};
    const parsed = await analyzeProfileWithLLM(cfg, provider, model, userInfo, stats, current, ev);
    const checked = profileLib.validateCardUpdate(parsed, current);
    if (!checked.ok) {
      console.log('[profile] 更新被机械守卫拒绝，保留旧卡（' + checked.rejected.map((r) => r.why).join('；') + '）');
      try {
        fs.appendFileSync(PROFILE_LOG, JSON.stringify({
          at: Date.now(), handle, applied: false, evidence: ev.kinds,
          rejected: checked.rejected, proposed: parsed || null
        }) + '\n');
      } catch (e) { /* ignore */ }
      return;
    }
    const card = Object.assign({}, current, {
      version: 1,
      updatedAt: Date.now(),
      cfHandle: handle,
      rating: userInfo.rating,
      rank: userInfo.rank,
      maxRating: userInfo.maxRating,
      solvedCount: stats.solvedCount,
      avgSolvedRating: stats.avgSolvedRating,
      byRating: stats.byRating,
      topTags: stats.topTags,
      recentSolved: stats.recentSolved,
      profileText: checked.card.profileText,
      strengths: checked.card.strengths,
      weaknesses: checked.card.weaknesses,
      focus: checked.card.focus
    });
    saveProfile(card);
    try {
      fs.appendFileSync(PROFILE_LOG, JSON.stringify({
        at: Date.now(), handle, applied: true, evidence: ev.kinds, evidenceText: ev.evidence,
        rejected: checked.rejected, used: (parsed && parsed.usedEvidence) || [],
        card: { profileText: card.profileText, strengths: card.strengths, weaknesses: card.weaknesses, focus: card.focus }
      }) + '\n');
    } catch (e) { /* ignore */ }
    console.log('[profile] 学员信息卡已更新（' + handle + '，证据 ' + ev.kinds.join('/')
      + (checked.rejected.length ? '，拒收 ' + checked.rejected.length + ' 条' : '') + '）');
  } catch (e) {
    console.log('[profile] 更新失败: ' + (e && e.message));
  } finally {
    profileUpdateBusy = false;
  }
}

/* ==================== token 用量与费用估算 ==================== */
// 逻辑在 lib/pricing.js（可测）：token 优先用服务商返回的 usage，费用按"用户单价 / 内置参考价"估算
const { estimateCost } = pricing;

/* ==================== 题目自动分类 ==================== */

const KNOWLEDGE_CATEGORIES = [
  '贪心', '动态规划', '图论', '数据结构', '数学', '构造', '二分', '双指针', '字符串', '树',
  '数论', '组合数学', '交互', '实现', '搜索', '位运算', '排序', '前缀和', '博弈', '概率', '模拟', '其他'
];

/** 用 LLM 给题目分类（难度预估 + 知识点 + 一句话主题），合并 CF 官方元数据 */
async function classifyProblem(conv, cfg, assistantContent) {
  if (conv.mode === 'chat') return;
  const provider = cfg.providers.find((p) => p.id === conv.providerId)
    || cfg.providers.find((p) => p.id === cfg.defaultProviderId)
    || cfg.providers[0];
  if (!provider) return;
  const model = conv.model || cfg.defaultModel || (provider.models && provider.models[0]) || '';
  if (!model) return;
  const sys = [
    '你是算法竞赛题目分类器。分析题目与讲解内容，输出严格 JSON（不要任何其它文字）：',
    '{"rating": 题目难度预估（CF rating 分，800-3500 整数；若已知官方难度则沿用官方值）,',
    '"knowledge": [知识点分类数组，从这些类别中选 1-3 个：' + KNOWLEDGE_CATEGORIES.join('、') + '],',
    '"summary": "一句话概括题目与解法（20 字以内）"}'
  ].join('\n');
  const problemText = conv.cfProblem
    ? ('CF ' + conv.cfProblem.contestId + conv.cfProblem.index + '「' + conv.cfProblem.title + '」' + (conv.problemMeta && conv.problemMeta.rating ? '，官方难度 ' + conv.problemMeta.rating : ''))
    : '';
  const user = '题目：' + problemText + '\n\n用户提问：' + (conv.messages || []).filter((m) => m.role === 'user').map((m) => contentText(m.content).slice(0, 800)).join('\n---\n').slice(-3000)
    + '\n\n讲解摘要：' + truncStr(assistantContent || '', 3000);
  let parsed = null;
  try {
    if (provider.type === 'anthropic') {
      const res = await fetch(joinUrl(provider.baseUrl, 'v1/messages'), {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' }, provider.extraHeaders || {}),
        body: JSON.stringify({ model, max_tokens: 600, stream: false, system: sys, messages: [{ role: 'user', content: user }] })
      });
      if (!res.ok) throw new Error(await upstreamErrorText(res));
      const j = await res.json();
      parsed = extractJson((j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    } else {
      const res = await fetch(joinUrl(provider.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + (provider.apiKey || '') }, provider.extraHeaders || {}),
        body: JSON.stringify({ model, temperature: 0.2, stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
      });
      if (!res.ok) throw new Error(await upstreamErrorText(res));
      const j = await res.json();
      parsed = extractJson(j && j.choices && j.choices[0] && j.choices[0].message ? (j.choices[0].message.content || '') : '');
    }
  } catch (e) {
    console.log('[classify] 分类失败: ' + (e && e.message));
    return;
  }
  if (!parsed) return;
  const meta = conv.problemMeta || {};
  const official = meta.source === 'cf' ? meta : null;
  const knowledge = (Array.isArray(parsed.knowledge) ? parsed.knowledge : [])
    .map((k) => String(k).trim())
    .filter((k) => k && KNOWLEDGE_CATEGORIES.some((c) => k.indexOf(c) >= 0 || c.indexOf(k) >= 0))
    .slice(0, 3);
  const next = Object.assign({}, meta, {
    rating: official && official.rating ? official.rating : (parsed.rating || meta.rating || null),
    tags: official && official.tags && official.tags.length ? official.tags : (meta.tags || []),
    knowledge: knowledge.length ? knowledge : (meta.knowledge || []),
    summary: parsed.summary || meta.summary || '',
    title: meta.title || conv.title || '',
    contest: meta.contest || null,
    source: meta.source || 'manual',
    classifiedAt: Date.now()
  });
  conv.problemMeta = next;
  saveConv(conv);
  console.log('[classify] 题目已分类: ' + JSON.stringify({ rating: next.rating, knowledge: next.knowledge, summary: next.summary }));
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const convId = String(body.conversationId || '');
  const mode = body.mode === 'edit' ? 'edit' : (body.mode === 'regenerate' ? 'regenerate' : 'send');
  if (!convId) throw new HttpError(400, '缺少 conversationId');
  const convPeek = loadConv(convId);
  if (!convPeek) throw new HttpError(404, '会话不存在');
  if (convPeek.archived) throw new HttpError(400, '已归档的会话不能发送消息，请先恢复');
  // 陈旧 streaming 状态不该阻塞发送 / 重新生成
  if (repairStaleStreaming(convPeek)) saveConv(convPeek);

  const cfg = loadConfig();
  const provider = cfg.providers.find((p) => p.id === convPeek.providerId)
    || cfg.providers.find((p) => p.id === cfg.defaultProviderId)
    || cfg.providers[0];
  if (!provider) throw new HttpError(400, '尚未配置任何模型服务，请先到设置中添加');
  const model = convPeek.model || cfg.defaultModel || (provider.models && provider.models[0]) || '';
  if (!model) throw new HttpError(400, '未选择模型，请在会话设置或输入框中选择');

  if (mode === 'edit' && !body.baseUserMessageId) throw new HttpError(400, '缺少 baseUserMessageId');
  const userContent = body.userContent;
  const userText = contentText(userContent);
  if (mode !== 'regenerate' && !userText && !contentHasImage(userContent)) {
    throw new HttpError(400, '消息内容为空');
  }

  // ---- SSE 响应头 ----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (type, data) => {
    try { res.write('data: ' + JSON.stringify(Object.assign({ type }, data || {})) + '\n\n'); } catch {}
  };
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  let finished = false;
  const finish = () => {
    finished = true;
    activeGenerations.delete(convId);
    runStops.delete(convId);
    clearInterval(hb);
    try { res.end(); } catch {}
  };
  activeGenerations.add(convId);

  const lock = locks.get(convId) || Promise.resolve();
  const run = lock.then(async () => {
    // 拿到锁后重新加载会话，避免与排队中的其它请求产生写覆盖
    const conv = loadConv(convId);
    if (!conv) throw new HttpError(404, '会话不存在');
    if (conv.archived) throw new HttpError(400, '已归档的会话不能发送消息，请先恢复');
    const now = Date.now();
    let msgs = conv.messages.slice();
    let assistantMsgId;

    if (mode === 'regenerate') {
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') throw new HttpError(400, '最后一条不是助手消息，无法重新生成');
      if (last.status === 'streaming' && activeGenerations.has(convId)) throw new HttpError(400, '正在生成中，请先停止');
      last.alternates = last.alternates || [];
      if (last.content || last.reasoning) {
        last.alternates.push({
          content: last.content || '',
          reasoning: last.reasoning || '',
          model: last.model,
          usage: last.usage,
          createdAt: now
        });
      }
      last.content = '';
      last.reasoning = '';
      last.usage = null;
      last.model = model;
      last.status = 'streaming';
      assistantMsgId = last.id;
    } else {
      if (mode === 'edit') {
        const idx = msgs.findIndex((m) => m.id === body.baseUserMessageId);
        if (idx < 0 || msgs[idx].role !== 'user') throw new HttpError(400, '找不到要重编辑的消息');
        msgs = msgs.slice(0, idx);
      }
      msgs.push({
        id: uid('m_'),
        role: 'user',
        content: userContent,
        createdAt: now
      });
      assistantMsgId = uid('m_');
      msgs.push({
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        reasoning: '',
        status: 'streaming',
        model,
        createdAt: now
      });
      if (conv.title === '新对话' && userText) conv.title = contentPreview(userContent, 24);
    }

    const system = (conv.systemPrompt || cfg.systemPrompt || '').trim();
    const context = msgs.filter((m) => m.id !== assistantMsgId);
    const p = {
      temperature: conv.params.temperature != null ? conv.params.temperature : cfg.defaultParams.temperature,
      topP: conv.params.topP != null ? conv.params.topP : cfg.defaultParams.topP,
      maxTokens: conv.params.maxTokens != null ? conv.params.maxTokens : cfg.defaultParams.maxTokens
    };

    conv.messages = msgs;
    conv.updatedAt = now;
    saveConv(conv);
    send('meta', { conversationId: conv.id, assistantMessageId: assistantMsgId, model, providerId: provider.id, mode: conv.mode || 'chat' });

    const ctrl = new AbortController();
    let userStopped = false;   // 是否是"用户点了停止"（区别于连接意外断开）
    const onAbort = () => {
      console.log('[chat] 收到中断信号（客户端断开 / 用户点停止）→ 取消本次生成');
      try { ctrl.abort(); } catch (e) { /* ignore */ }
    };
    // 三种"客户端没了"的信号都接上：实测只看 req 的 'close' 并不可靠
    //（浏览器里点停止会 abort fetch，但服务端未必收到 req 关闭），所以另配一个显式停止端点兜底
    req.on('close', () => { if (!finished) onAbort(); });
    req.on('error', onAbort);
    res.on('close', () => { if (!finished) onAbort(); });
    runStops.set(convId, () => { userStopped = true; onAbort(); });

    let content = '';
    let reasoning = '';
    let usage = null;
    let promptEst = context.reduce((s, m) => s + estTokens(contentText(m.content)), 0);

    /** 统一收尾：把消息状态、已生成内容与**未完成的步骤**一起落盘。
     *  中断/异常都可能发生在任何阶段，所以未完成的 chip 必须在这里收掉，
     *  否则界面（以及刷新后的历史）会一直挂着转圈的"正在生成"。 */
    let assistantTarget = null;   // 函数作用域：收尾逻辑也要能拿到这条消息
    const finalizeStopped = (status, errMsg) => {
      const t = assistantTarget || conv.messages.find((m) => m.id === assistantMsgId);
      if (t) {
        t.content = content;
        t.reasoning = reasoning;
        t.status = status;
        t.error = errMsg || '';
        if (Array.isArray(t.tools) && t.tools.length) {
          t.tools = t.tools.map((c) => (c.state === 'running'
            ? Object.assign({}, c, { state: 'done', ok: false, summary: c.summary || '已中断（生成被停止）' })
            : c));
        }
      }
      conv.updatedAt = Date.now();
      saveConv(conv);
      return t;
    };

    /** 中断/取消：必须把消息状态与已生成内容落盘，否则会留下 status='streaming' 的僵尸消息 */
    const finalizeAborted = () => {
      const has = !!(content || reasoning);
      // 用户主动点停止 → 一律记 'stopped'（哪怕还没收到任何内容，也不该显示成"生成失败"）；
      // 连接意外断开且没有任何内容 → 'error'
      const t = finalizeStopped((userStopped || has) ? 'stopped' : 'error',
        (userStopped || has) ? '' : '生成已取消');
      console.log('[chat] 中断收尾完成（消息状态 ' + (t ? t.status : '无') + '，已落盘）');
      send('stopped', { message: t || null });
    };

    try {
      assistantTarget = conv.messages.find((m) => m.id === assistantMsgId);
      const onEvent = (ev) => {
        if (ev.type === 'delta') {
          content += ev.text;
          if (assistantTarget) assistantTarget.content = content;
          send('delta', { text: ev.text });
        } else if (ev.type === 'reasoningDelta') {
          reasoning += ev.text;
          if (assistantTarget) assistantTarget.reasoning = reasoning;
          send('reasoningDelta', { text: ev.text });
        } else if (ev.type === 'usage') {
          if (ev.promptTokens != null && usage) usage.promptTokens = ev.promptTokens;
          if (ev.completionTokens != null && usage) usage.completionTokens = ev.completionTokens;
          if (ev.cacheHitTokens != null && usage) usage.cacheHitTokens = ev.cacheHitTokens;
          if (ev.cacheMissTokens != null && usage) usage.cacheMissTokens = ev.cacheMissTokens;
          if (!usage) {
            usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens,
              cacheHitTokens: ev.cacheHitTokens, cacheMissTokens: ev.cacheMissTokens };
          }
        }
      };

      // 收尾任务（信息卡 / 题目分类）需要的"学员侧证据"。
      // 必须声明在**教练分支之外**：intent / userCode / userTextFull 都是分支内的局部变量，
      // 分支外直接引用会 ReferenceError（曾被外层 catch 吞掉 → 信息卡与分类双双失效、消息状态被改成 error）
      let postRun = null;
      let runUsage = null;   // 本轮（教练模式）的 token 用量与估算费用
      if (conv.mode === 'coach') {
        // ===== 算法教练模式：多 Agent 编排（共享契约 + 隔离实现）=====
        const rt = runtimesText(await getRuntimes());
        let userInfo = null;
        const handle = (cfg.cfHandle || '').trim();
        if (handle) {
          try { userInfo = await cf.fetchUser(handle); } catch (e) { /* 查询失败不阻塞 */ }
        }
        const lang = conv.lang || cfg.defaultCoachLang || 'cpp';
        let intent = normalizeIntent(conv.intent);   // 方案可行性会在路由后改写为 idea
        const profile = loadProfile();
        const userTextFull = contentText(userContent);

        // 1) 题面与样例：先看会话是否已关联 CF 题；否则从用户消息里识别题号并抓取
        let statement = '';
        let samples = [];
        let cfRef = conv.cfProblem
          ? { contestId: conv.cfProblem.contestId, index: conv.cfProblem.index }
          : detectCfRef(userTextFull);
        if (cfRef) {
          const id = 'cf';
          send('tool', { calls: [{ id, name: 'cf_fetch_problem', args: JSON.stringify(cfRef) }] });
          try {
            const p = await cf.fetchProblem(cfRef.contestId, cfRef.index, { signal: ctrl.signal });
            statement = p.statement || '';
            samples = (p.samples || []).filter((s) => s.input != null);
            conv.cfProblem = { contestId: p.contestId, index: p.index, title: p.title };
            conv.cfProblemSamples = p.samples;
            conv.problemMeta = Object.assign({}, conv.problemMeta || {}, {
              rating: p.rating || (conv.problemMeta && conv.problemMeta.rating) || null,
              tags: (p.tags && p.tags.length) ? p.tags : (conv.problemMeta && conv.problemMeta.tags) || [],
              contest: String(p.contestId),
              source: 'cf',
              title: p.title
            });
            saveConv(conv);
            send('toolResult', { results: [{ id, name: 'cf_fetch_problem', ok: true,
              summary: '已取到 CF ' + p.contestId + p.index + '「' + p.title + '」' + (p.rating ? '（' + p.rating + ' 分）' : '')
                + '，样例 ' + samples.length + ' 组' + ((p.warnings && p.warnings.length) ? '｜⚠ ' + p.warnings.join('；') : '') }] });
          } catch (e) {
            console.log('[coach] 取题失败，改用用户输入: ' + e.message);
            send('toolResult', { results: [{ id, name: 'cf_fetch_problem', ok: false, summary: friendlyError(e) }] });
          }
          // 取题失败 / 页面结构变了导致没解析出样例 → 用**本题缓存过的官方样例**兜底。
          // 一次网络抖动不该把整轮降级成"没有任何 ground truth"，进而白跑一遍手算锚点、
          // 还把"锚点很弱/没有样例"写进验证结论（实测发生过：明明缓存里就有 1 组官方样例）。
          if (!samples.length) {
            const cachedSamples = await ensureSamples(conv);
            if (cachedSamples.length) {
              samples = cachedSamples;
              send('toolResult', { results: [{ id: id + '-cache', name: 'cf_fetch_problem', ok: true,
                summary: '本次没取到样例 → 复用本题缓存的官方样例 ' + cachedSamples.length + ' 组（同一道题的官方数据）' }] });
            }
          }
        } else {
          samples = await ensureSamples(conv);
        }
        const userCode = harness.extractUserCode(userTextFull);
        if (!statement) statement = harness.cleanUserStatement(userTextFull);

        /* ---------- 粘贴题面：先判是不是标准格式，不标准就派【题面整理 Agent】 ----------
         * 粘贴的题面是自由文本（`**输入**` 可能写在句子结尾），若直接进流水线会切不出格式段、样例为 0 组，
         * 于是"没有标尺就不开测"，整条验证链断在这里（哪怕题面里带着十几组样例）。
         * 做法：机械判断 → 不标准就整理成标准形状（正文/输入格式/输出格式/保证/样例）→ 再进流水线。 */
        let normalizeNote = '';
        if (!conv.cfProblem && statement && !conv.statementNormalized) {
          const diag = statementLib.looksStandard(statement, samples);
          const mech = diag.mechanicalSamples || [];
          if (!samples.length && mech.length) { samples = mech; conv.cfProblemSamples = mech; saveConv(conv); }
          // 需要整理的两类情况：① 格式不标准；② 标准但没有可解析的样例（流水线没有锚点）
          const needNorm = !diag.standard || !samples.length;
          if (needNorm) {
            const id = 'norm';
            send('tool', { calls: [{ id, name: 'harness_normalize', args: JSON.stringify({ reasons: diag.reasons }) }] });
            const provider0 = cfg.providers.find((p) => p.id === conv.providerId)
              || cfg.providers.find((p) => p.id === cfg.defaultProviderId) || cfg.providers[0];
            const model0 = conv.model || cfg.defaultModel || (provider0 && provider0.models && provider0.models[0]) || '';
            const nm = (provider0 && model0) ? await statementLib.normalizeWithAgent({
              text: userTextFull,
              mechanicalSamples: mech,
              parseJson: extractJson,
              callAgent: async (opts2) => {
                const tuned = resolveAgentTarget(cfg, provider0, model0, opts2.role);
                return callAgentLLM({
                  provider: tuned.provider, model: tuned.model,
                  system: opts2.system, messages: [{ role: 'user', content: opts2.user }],
                  signal: ctrl.signal, stream: false
                });
              }
            }).catch((e) => ({ ok: false, errors: [e.message] })) : { ok: false, errors: ['没有可用的模型'] };

            if (nm && nm.ok) {
              const d = nm.data;
              statement = statementLib.buildStandardStatement(d);
              const ns = (nm.samples || []).filter((s) => String(s.input || '').trim() !== '');
              if (ns.length) { samples = ns; conv.cfProblemSamples = ns; }
              else if (mech.length && !samples.length) { samples = mech; conv.cfProblemSamples = mech; }
              conv.statementNormalized = true;
              conv.problemMeta = Object.assign({}, conv.problemMeta || {}, {
                source: 'pasted', title: d.title || (conv.problemMeta && conv.problemMeta.title) || null
              });
              saveConv(conv);
              const asm = (d.assumptions || []).filter(Boolean);
              normalizeNote = '题面整理 Agent 已把粘贴内容整理成标准结构（样例 ' + samples.length + ' 组'
                + (asm.length ? '，推断假设 ' + asm.length + ' 条' : '') + '）';
              send('toolResult', { results: [{ id, name: 'harness_normalize', ok: true, summary: normalizeNote
                + (asm.length ? '：' + asm.slice(0, 3).join('；') : '') }] });
            } else {
              // 整理失败 → 机械兜底：用机械抽出的样例 + 原题面，并如实标注假设
              // （样例还是拿不到时也不放弃：流水线会派【手算锚点 Agent】造小样例并手算答案）
              if (mech.length && !samples.length) { samples = mech; conv.cfProblemSamples = mech; saveConv(conv); }
              normalizeNote = '题面整理失败（' + String((nm && nm.errors && nm.errors[0]) || '未知原因').slice(0, 80)
                + '）→ 已用机械解析兜底（样例 ' + samples.length + ' 组'
                + (samples.length ? '' : '；将由手算锚点 Agent 造极端小样例并手算答案') + '）';
              send('toolResult', { results: [{ id, name: 'harness_normalize', ok: false, summary: normalizeNote }] });
            }
          }
        }

        // 2) 同题缓存 + 追问智能路由（注意：工作区键必须用**取到题之后**的题号算，
        //    否则同一条会话的首条消息与后续消息会落到不同工作区，缓存与验证记录被割裂）
        const wsKey = workspace.keyFor({ id: conv.id, cfProblem: conv.cfProblem });
        const wsMeta = workspace.loadMeta(wsKey);
        const verified = !!(wsMeta && wsMeta.verification && wsMeta.verification.status === 'ok');
        const solName = workspace.solName(lang);
        const bruteName = workspace.bruteName(lang);
        let reuse = {};
        let skipChain = false;
        let explainStyle = '';
        let idea = null;
        let route = { mode: 'chain', reason: '' };
        const agentCall = async (opts) => {
          const tuned = resolveAgentTarget(cfg, provider, model, opts.role);
          const label = opts.label || opts.role;
          const isExplainer = opts.role === 'explainer';
          // 讲解 agent 的增量默认直接写进消息（学员要边写边看）；但**图文讲解**的正文是一份 HTML 文档，
          // 边写边塞进消息只会闪一堆裸标签 —— 这种就只喂工作台（同样实时可见，只是不进正文）。
          const toMessage = isExplainer && !!opts.stream && !opts.workbenchOnly;
          const t0 = Date.now();
          // 讲解**重跑**（结构校验后的定向修复）时要重置流式缓冲：
          // 否则学员会在生成过程中看到"草稿 + 修复版"两段拼接（定稿虽然是修复版，但过程中会闪错）
          const resetStream = toMessage;
          if (resetStream) { content = ''; reasoning = ''; }
          send('agentStart', { role: opts.role, label, reset: resetStream, model: (tuned.provider && tuned.provider.name ? tuned.provider.name + ' · ' : '') + tuned.model });
          try {
            const text = await callAgentLLM({
              provider: tuned.provider,
              model: tuned.model,
              system: opts.system,
              messages: [{ role: 'user', content: opts.user }],
              // 默认挂上本次生成的取消信号：路由/选题评估/手算锚点这些辅助调用也必须能被"停止"打断，
              // 否则点了停止还得等一次几分钟的模型调用返回，界面会一直挂着"正在生成中"
              signal: opts.signal || ctrl.signal,
              stream: !!opts.stream,
              // 单次输出上限：harness 可以在"上次被截断"的重试里显式要个更大的值
              // （服务商不接受会自动去掉该字段重试，见 callAgentLLM）
              maxTokens: (opts.maxTokens != null && opts.maxTokens > 0) ? opts.maxTokens : (cfg.maxOutputTokens || 0),
              // token 记账：上游给了 usage 就用真值（在 harness 侧汇总成"这题花了多少"）
              onUsage: (u) => { if (typeof opts.onUsage === 'function') opts.onUsage(u); },
              // 收尾原因（finish_reason=length 表示被长度上限截断）：harness 据此换"压缩输出"的重试话术
              onMeta: (m) => { if (typeof opts.onMeta === 'function') opts.onMeta(m); },
              // 讲解 agent 的输出就是最终回答 → 走 delta；其余 agent（含"只喂工作台"的图文文档）走 agentDelta
              onDelta: (t) => {
                if (toMessage) {
                  content += t;
                  if (assistantTarget) assistantTarget.content = content;
                  send('delta', { text: t });
                } else {
                  send('agentDelta', { role: opts.role, label, text: t });
                }
              },
              // 思考过程：讲解 Agent 的思考直接进消息（学员能实时看到"它在想什么"），
              // 其余 Agent 的思考进工作台；两条通道都要实时发，不能等跑完（实测反馈：全程黑屏）
              // 图文文档模式下**正文**不往消息里推（会闪裸 HTML），但**思考照推**：
              // 文档要写一两分钟，这段时间消息里的"思考过程"就是学员的进度条。
              onReasoning: (t) => {
                if (isExplainer) {
                  reasoning += t;
                  if (assistantTarget) assistantTarget.reasoning = reasoning;
                  send('reasoningDelta', { text: t });
                }
                send('agentReasoning', { role: opts.role, label, text: t });
              }
            });
            send('agentEnd', { role: opts.role, label, ok: true, ms: Date.now() - t0 });
            return text;
          } catch (e) {
            send('agentEnd', { role: opts.role, label, ok: false, ms: Date.now() - t0, error: friendlyError(e) });
            throw e;
          }
        };
        const agentModelLabel = (role) => {
          const tuned = resolveAgentTarget(cfg, provider, model, role);
          return (tuned.provider && tuned.provider.name ? tuned.provider.name + ' · ' : '') + tuned.model;
        };

        if (verified && !userCode) {
          // 同题缓存总是先加载：无论走哪条链路，都用已验证的暴力解/生成器当标尺（省最大一笔钱）
          reuse.brute = workspace.readCache(wsKey, bruteName) || workspace.readFile(wsKey, bruteName);
          reuse.gen = workspace.readCache(wsKey, 'gen.py') || workspace.readFile(wsKey, 'gen.py');

          // 智能路由只用于"完整讲解"这类自由追问：
          // hint / debug 是用户显式选择的模式，语义固定（hint 也必须跑全量验证），不交给路由判断。
          if (intent === 'full') {
            send('tool', { calls: [{ id: 'rt', name: 'harness_router', args: '{}' }] });
            route = await harness.routeFollowUp({
              callAgent: agentCall,
              hasVerified: true,
              question: userTextFull,
              problemTitle: conv.cfProblem ? (conv.cfProblem.contestId + conv.cfProblem.index + ' ' + (conv.cfProblem.title || '')) : conv.title
            });
            send('toolResult', { results: [{ id: 'rt', name: 'harness_router', ok: true,
              summary: '判断为「' + ({ explain: '解释型追问 → 不重跑链路', rethink: '没听懂 → 换一种讲法（手算演示）', debug: '针对具体代码/做法 → 走代码评估', chain: '需要重跑链路' }[route.mode] || route.mode)
                + '」' + (route.reason ? '：' + route.reason : '') + '（复用已验证产物与缓存标尺）' }] });

            if (route.mode === 'explain') {
              skipChain = true;
            } else if (route.mode === 'rethink') {
              // "没听懂" 不等于"再讲一遍"：换讲法（具体小数据一步步手算、先直觉后公式、少代码）
              skipChain = true;
              explainStyle = 'rethink';
            } else if (route.mode === 'debug') {
              // 统一走"代码评估"：贴了代码 → 三方对拍定位；只提了做法 → 先评估可行性再实测
              intent = 'debug';
              if (!userCode) {
                send('tool', { calls: [{ id: 'id', name: 'harness_idea', args: '{}' }] });
                idea = await harness.checkIdea({
                  callAgent: agentCall,
                  statement, question: userTextFull,
                  contract: harness.extractContract(statement),
                  solCode: workspace.readFile(wsKey, solName)
                });
                send('toolResult', { results: [{ id: 'id', name: 'harness_idea', ok: !!idea.viable,
                  summary: (idea.viable ? '该做法可行' : '该做法不可行') + (idea.reason ? '：' + idea.reason : '')
                    + (idea.complexity ? '（' + idea.complexity + '）' : '') }] });
                // 可行 → 按该做法重写题解并重跑对拍（复用缓存标尺）；不可行 → 只讲清楚为什么不行
                if (!idea.viable) skipChain = true;
                else if (reuse.brute && reuse.gen) {
                  send('toolResult', { results: [{ id: 'id2', name: 'harness_reuse', ok: true,
                    summary: '复用同题已验证的暴力解与生成器作标尺，只重新实现题解' }] });
                }
              }
            }
          } else if (intent === 'explain') {
            skipChain = true;
          }
          if (!skipChain && (reuse.brute || reuse.gen)) {
            send('toolResult', { results: [{ id: 'reuse', name: 'harness_reuse', ok: true,
              summary: '复用同题已验证的' + [reuse.brute ? '暴力解' : '', reuse.gen ? '生成器' : ''].filter(Boolean).join('与') + '作标尺' }] });
          }
        }

        // 3) 编排计划
        send('tool', { calls: [{ id: 'hd', name: 'harness_overview', args: JSON.stringify({
          label: INTENT_LABELS[intent] || intent
        }) }] });
        send('toolResult', { results: [{ id: 'hd', name: 'harness_overview', ok: true, summary: skipChain
          ? '本题已有验证通过的产物 → 直接重新讲解（不重复花 token）'
          : '将依次执行：抽取契约 → 代码体检 → 题解 / 暴力 / 生成器（隔离上下文）→ 官方样例校准 → 批量对拍 → 讲解'
            + (Object.keys(reuse).length ? '（复用同题缓存产物）' : '') }] });

        // 4) 跑编排器（顺便把每一步工具/阶段累积到消息上，历史里也能看到讲解经过了哪些步骤）
        const runTools = [];
        // 图文讲解（HTML 文档 + SVG 图解 + 交互演示）是**默认交付形式**，不再单开开关：
        //   · 完整讲解 / 代码评估 → 图文文档（这是产品的核心优势）
        //   · 思路提示 / 题干解读 → 仍是轻量 Markdown（这两类只给方向，文档范式要求的完整代码与推导用不上）
        // 成本实测（真实模型、一道 G 题整轮）：文档本身 ≈ 29K 输出 token，约占整轮 276K 的 10%，
        // 与"多写一份 Markdown 讲解"量级相当；而它换来的是可交互的图解。
        // 万一文档两次都过不了校验、且机械净化后确实没有图 → 自动回落 Markdown（不假装成功）。
        const useRich = (intent === 'full' || intent === 'debug');
        const result = await harness.runPipeline({
          conv, lang, intent, statement, samples, userCode, userText: userTextFull,
          profile, rich: useRich, userInfo, runtimes: rt,
          workspace, wsKey,
          rating: (conv.problemMeta && conv.problemMeta.rating) || null,
          signal: ctrl.signal,
          skipChain, reuse, idea,
          explainStyle,
          userQuestion: userTextFull,
          tiers: [8, 20, 50, 200],
          perTier: 50,
          maxStressMs: 180000,
          emit: (ev) => {
            if (!ev || !ev.type) return;
            if (ev.type === 'tool') {
              (ev.calls || []).forEach((c) => {
                let label = '';
                try { label = (JSON.parse(c.args || '{}').label) || ''; } catch (e) { /* ignore */ }
                runTools.push({ id: c.id, name: c.name, label, state: 'running' });
              });
            } else if (ev.type === 'toolResult') {
              (ev.results || []).forEach((r) => {
                const t = runTools.find((x) => x.id === r.id);
                if (t) { t.ok = r.ok; t.summary = r.summary; t.state = 'done'; }
                else runTools.push({ id: r.id, name: r.name, label: '', ok: r.ok, summary: r.summary, state: 'done' });
              });
            }
            // 步骤 chip 实时同步到消息上：即使这次生成被中途停止，
            // 收尾时也能把"还在转圈"的那几条标记成已中断并落盘（否则重载页面还在转）
            if (assistantTarget && runTools.length) assistantTarget.tools = runTools.slice(-40);
            send(ev.type, ev);
          },
          callAgent: agentCall,
          describeModel: agentModelLabel
        });
        if (assistantTarget && runTools.length) assistantTarget.tools = runTools.slice(-40);

        if (result && result.explainerText) content = result.explainerText;
        if (result && result.richDoc && assistantTarget) {
          assistantTarget.richDoc = result.richDoc;      // 图文讲解文档（前端用 sandbox iframe 渲染）
          send('richDoc', { messageId: assistantTarget.id, size: result.richDoc.length });
        }
        if (result && result.verification) {
          // 把验证状态挂到消息上，历史和界面都能看到"这题验证到什么程度"
          if (assistantTarget) assistantTarget.verification = {
            status: result.verification.status,
            reason: result.verification.reason || '',
            iterations: result.verification.iterations || 0,
            tiers: result.verification.tiers || [],
            bruteFrozen: !!result.verification.bruteFrozen,
            agentCalls: result.verification.agentCalls || 0
          };
          if (result.verification.status !== 'ok') {
            send('notice', { level: 'warn', message: '本轮验证未通过（' + result.verification.status + '）：讲解已按"诚实降级"输出，请注意代码未经验证。' });
          }
        }
        if (result && result.notes && result.notes.length) console.log('[harness] ' + result.notes.join('；'));
        // 本轮 token 消耗与估算费用（挂在消息上，UI 直接展示"讲这道题花了多少"）
        if (result && result.usage && result.usage.calls) {
          runUsage = Object.assign({}, result.usage, {
            cost: estimateCost(cfg, provider.id, model, result.usage)
          });
          console.log('[usage] 本轮 ' + runUsage.calls + ' 次调用 · 输入 ' + runUsage.promptTokens
            + ' / 输出 ' + runUsage.completionTokens + ' tokens'
            + (runUsage.estimated ? '（部分为估算）' : '')
            + (runUsage.cost ? ' · 约 ¥' + runUsage.cost.amount.toFixed(4) : ''));
        }
        // 富讲解回落也要让用户看见原因（不能只留在内部 notes 里，否则用户只看到"富讲解失败"）
        if (result && result.richFallback && result.richFallback.errors && result.richFallback.errors.length) {
          send('notice', {
            level: 'warn',
            message: '图文文档没通过校验，本次已用文字讲解代替。原因：'
              + result.richFallback.errors.slice(0, 2).join('；')
              + '（被拒的文档留在工作区 richdoc-attempt*.html）'
          });
        }
        postRun = {
          intent,
          userCode,
          userText: userTextFull,
          minimalCase: (result && result.minimalCase) || null,
          verification: (result && result.verification) || null
        };
        if (ctrl.signal.aborted) { finalizeAborted(); return; }
        // 保险丝：**任何情况下都不给学员一句空洞的"（本轮未生成文本内容）"**。
        // 走到这里说明链路没能产出正文，那就把已知的客观信息如实写出来（零 token，不额外调用模型）。
        if (!content) {
          const why = (result && result.error) || '链路没有产出讲解正文';
          content = '**这题我没能给出讲解正文。**\n\n'
            + '- **卡在哪**：' + why + '\n'
            + (result && result.verification ? '- **验证状态**：' + (result.verification.status || '未知')
              + (result.verification.reason ? '（' + String(result.verification.reason).slice(0, 120) + '）' : '') + '\n' : '')
            + '- **发生了什么**：右侧「决策轨迹」有每一步的真实记录（每个 Agent 调用了多久、返回了什么、失败在哪一步）。\n\n'
            + '**可以这样做**：① 再发一次（重试常常就过）；② 换一个输出上限更高、更擅长长推理的模型'
            + '（设置 → 模型服务，可给「题解」角色单独指定）；③ 先用「思路提示」拿方向；④ 粘贴题面走的是同一条链路。';
        }
      } else {
        // ===== 普通聊天模式 =====
        const upstream = buildUpstream(provider, model, context, system, p);
        let upstreamRes;
        try {
          upstreamRes = await fetch(upstream.url, {
            method: 'POST',
            headers: upstream.headers,
            body: JSON.stringify(upstream.body),
            signal: ctrl.signal
          });
        } catch (e) {
          if (ctrl.signal.aborted) { finalizeAborted(); return; }
          throw e;
        }
        await pumpUpstream(upstreamRes, onEvent);
      }
      if (ctrl.signal.aborted) { finalizeAborted(); return; }
      const t = conv.messages.find((m) => m.id === assistantMsgId);
      if (t) {
        t.content = content;
        t.reasoning = reasoning;
        t.status = 'done';
        t.model = model;
        // 教练模式：用 harness 汇总的**整轮**用量（十几个子 Agent 调用之和）；普通聊天：用本次流式 usage
        t.usage = runUsage
          ? Object.assign({}, runUsage, { note: '整轮多 Agent 汇总' })
          : (usage ? {
            promptTokens: usage.promptTokens != null ? usage.promptTokens : promptEst,
            completionTokens: usage.completionTokens != null ? usage.completionTokens : estTokens(content),
            cacheHitTokens: usage.cacheHitTokens != null ? usage.cacheHitTokens : null,
            estimated: usage.promptTokens == null || usage.completionTokens == null,
            cost: estimateCost(cfg, provider.id, model, {
              promptTokens: usage.promptTokens != null ? usage.promptTokens : promptEst,
              completionTokens: usage.completionTokens != null ? usage.completionTokens : estTokens(content),
              cacheHitTokens: usage.cacheHitTokens,
              cacheMissTokens: usage.cacheMissTokens,
              estimated: usage.promptTokens == null || usage.completionTokens == null
            })
          } : {
            promptTokens: promptEst,
            completionTokens: estTokens(content),
            estimated: true,
            cost: estimateCost(cfg, provider.id, model, { promptTokens: promptEst, completionTokens: estTokens(content), estimated: true })
          });
        if (content === '' && reasoning === '') t.status = 'error';
      }
      conv.updatedAt = Date.now();
      saveConv(conv);
      const finalMsg = (conv.messages.find((m) => m.id === assistantMsgId)) || null;
      send('done', { message: finalMsg });
      // 对话结束后异步更新学员信息卡（不阻塞响应；失败静默）
      // 只传"学员侧证据"（他的代码 / 他的提问 / 难度偏离）——绝不把助手讲解当证据
      if (conv.mode !== 'chat' && t && t.status === 'done' && postRun) {
        updateProfileCard(conv, cfg, postRun).catch((e) => console.log('[profile] 更新异常: ' + ((e && e.message) || e)));
        classifyProblem(conv, cfg, content).catch((e) => console.log('[classify] 分类异常: ' + ((e && e.message) || e)));
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        finalizeAborted();
        return;
      }
      // 异常也要走统一收尾：否则消息停不下来（界面转圈）或留着"正在运行"的步骤
      finalizeStopped('error', friendlyError(e));
      send('error', { message: friendlyError(e), content, reasoning });
    }
  }, (e) => {
    send('error', { message: friendlyError(e) });
  });
  locks.set(convId, run.then(() => undefined, () => undefined));
  run.then(
    () => console.log('[chat] 本次生成结束（正常返回）'),
    (e) => console.log('[chat] 本次生成结束（异常：' + ((e && e.message) || e) + '）')
  ).finally(finish);
}

async function fetchModels(provider) {
  const extra = provider.extraHeaders || {};
  const headers = provider.type === 'anthropic'
    ? { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01', ...extra }
    : { authorization: 'Bearer ' + (provider.apiKey || ''), ...extra };
  const url = provider.type === 'anthropic' ? joinUrl(provider.baseUrl, 'v1/models') : joinUrl(provider.baseUrl, 'models');
  const r = await fetch(url, { method: 'GET', headers });
  if (!r.ok) throw new Error(await upstreamErrorText(r));
  const j = await r.json();
  let models = [];
  if (Array.isArray(j.data)) models = j.data.map((m) => m.id).filter(Boolean);
  else if (Array.isArray(j.models)) models = j.models.map((m) => m.id || m.name).filter(Boolean);
  else if (Array.isArray(j)) models = j.map((m) => m.id || m.name || String(m)).filter(Boolean);
  models = [...new Set(models)].sort();
  return models;
}

/* ---------------- 导出 / 导入 ---------------- */

function convToMarkdown(c) {
  const lines = [];
  lines.push('# ' + c.title);
  lines.push('');
  const meta = [
    '> 创建于 ' + new Date(c.createdAt).toLocaleString('zh-CN'),
    c.model ? ('模型：' + c.model) : '',
    c.archived ? '（已归档）' : ''
  ].filter(Boolean).join(' · ');
  lines.push(meta);
  lines.push('');
  for (const m of c.messages) {
    if (m.role === 'user') {
      lines.push('## 🧑 用户');
      lines.push('');
      const txt = contentText(m.content);
      lines.push(txt || '[图片消息]');
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push('## 🤖 助手' + (m.model ? '（' + m.model + '）' : ''));
      lines.push('');
      if (m.reasoning) {
        lines.push('<details><summary>思考过程</summary>');
        lines.push('');
        lines.push(m.reasoning);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      lines.push(m.content || (m.status === 'error' ? ('_生成失败：' + (m.error || '未知错误') + '_') : ''));
      if (Array.isArray(m.alternates) && m.alternates.length) {
        m.alternates.forEach((alt, i) => {
          lines.push('');
          lines.push('---');
          lines.push('_另一版本 ' + (i + 1) + '（重新生成）_');
          lines.push('');
          lines.push(alt.content || '');
        });
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;
  try {
    /* ---- 系统信息 ---- */
    if (method === 'GET' && p === '/api/info') {
      const counts = {
        active: fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json') && !f.includes('.tmp-')).length,
        archive: fs.readdirSync(ARCH_DIR).filter((f) => f.endsWith('.json') && !f.includes('.tmp-')).length
      };
      sendJSON(res, 200, { version: APP_VERSION, dataDir: DATA_DIR, counts });
      return;
    }

    /* ---- 算法教练：Codeforces / 运行环境 ---- */
    if (method === 'GET' && p === '/api/cf/problem') {
      try {
        const q = url.searchParams;
        const problem = await cf.fetchProblem(q.get('contestId'), q.get('index'));
        sendJSON(res, 200, problem);
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
      return;
    }
    /** 仅取题目元数据（走官方 API，不受反爬影响）——题面抓取失败时的兜底 */
    if (method === 'GET' && p === '/api/cf/meta') {
      try {
        const q = url.searchParams;
        const contestId = q.get('contestId');
        const index = q.get('index');
        const meta = await cf.fetchProblemMeta(contestId, index);
        sendJSON(res, 200, {
          contestId: parseInt(contestId, 10) || contestId,
          index: String(index || '').toUpperCase(),
          title: meta && meta.name ? (String(index).toUpperCase() + '. ' + meta.name) : ('CF ' + contestId + String(index || '').toUpperCase()),
          rating: meta ? (meta.rating || null) : null,
          tags: meta ? (meta.tags || []) : [],
          statement: '',
          samples: [],
          metaOnly: true
        });
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
      return;
    }
    if (method === 'GET' && p === '/api/cf/user') {
      try {
        const user = await cf.fetchUser(url.searchParams.get('handle'));
        sendJSON(res, 200, user);
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
      return;
    }
    if (method === 'GET' && p === '/api/runtimes') {
      sendJSON(res, 200, await getRuntimes());
      return;
    }
    /* ---- 代码沙箱状态（设置页展示 + 风险说明） ---- */
    if (method === 'GET' && p === '/api/sandbox') {
      sendJSON(res, 200, runner.sandboxStatus());
      return;
    }
    /* ---- 每题工作区（对拍缓冲区）：按题号缓存，同题跨会话共享 ---- */
    if (method === 'GET' && p === '/api/workspace') {
      const convId = url.searchParams.get('convId') || '';
      if (!convId) throw new HttpError(400, '缺少 convId');
      const key = wsKeyOf(convId);
      const sum = workspace.summary(key);
      sendJSON(res, 200, {
        key,
        files: sum.files,
        cache: workspace.listCache(key),
        meta: sum.meta,
        verification: sum.verification,
        trajectory: (sum.meta && sum.meta.trajectory) || [],
        trace: (sum.meta && sum.meta.trace) || [],
        minimalCase: (sum.meta && sum.meta.minimalCase) || null,
        hasSol: sum.hasSol, hasBrute: sum.hasBrute, hasGen: sum.hasGen,
        dir: workspace.convDir(key),
        failCase: workspace.readFile(key, 'fail.txt') ? truncStr(workspace.readFile(key, 'fail.txt'), 4000) : null
      });
      return;
    }
    /* ---- 读取工作区某个文件（界面查看代码；cache/ 前缀读同题缓存） ---- */
    if (method === 'GET' && p === '/api/workspace/file') {
      const convId = url.searchParams.get('convId') || '';
      let name = url.searchParams.get('name') || '';
      if (!convId || !name) throw new HttpError(400, '缺少 convId 或 name');
      const key = wsKeyOf(convId);
      let text;
      if (name.indexOf('cache/') === 0) text = workspace.readCache(key, name.slice(6)) || null;
      else text = workspace.readFile(key, name);
      if (text == null) throw new HttpError(404, '文件不存在：' + name);
      sendJSON(res, 200, { name, content: truncStr(text, 200000), lang: workspace.langOf(name) });
      return;
    }
    /* ---- 清空工作区（用户手动重置本题缓冲区；同题缓存默认一起清） ---- */
    if (method === 'POST' && p === '/api/workspace/clear') {
      const body = await readBody(req, 1024 * 1024);
      const convId = String(body.convId || '');
      if (!convId) throw new HttpError(400, '缺少 convId');
      const key = wsKeyOf(convId);
      if (body.keepAll) {
        // 连验证记录与同题缓存一起清掉（用户明确要"从头再来"）
        const dir = workspace.convDir(key);
        try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        sendJSON(res, 200, { ok: true, removed: ['（全部）'], files: [] });
        return;
      }
      const r = workspace.clearScratch(key, ['sol', 'meta.json']);
      sendJSON(res, 200, { ok: true, removed: r.removed, files: workspace.listFiles(key) });
      return;
    }
    /* ---- 学员信息卡 ---- */
    if (method === 'GET' && p === '/api/profile') {
      const cfg = loadConfig();
      const card = loadProfile();
      const handle = (cfg.cfHandle || '').trim();
      // 秒开：这里只读本地文件 + 内存缓存，绝不发起网络请求（CF 直连失败时页面不能卡住）
      let user = cf.peekUser(handle) || null;
      let stats = cf.peekSolved(handle) || null;
      const ratingHistory = cf.peekRating(handle) || null;
      const cardIsSameHandle = !!(card && card.cfHandle && card.cfHandle.toLowerCase() === handle.toLowerCase());
      if (!user && cardIsSameHandle && card.rating) {
        user = {
          handle: card.cfHandle, rating: card.rating, rank: card.rank || '',
          maxRating: card.maxRating || card.rating, maxRank: card.maxRank || '', fromCard: true
        };
      }
      if (!stats && cardIsSameHandle && card.solvedCount) {
        stats = {
          handle: card.cfHandle, solvedCount: card.solvedCount, avgSolvedRating: card.avgSolvedRating || 0,
          topTags: card.topTags || [], fromCard: true
        };
      }
      sendJSON(res, 200, {
        card, user, stats, ratingHistory,
        handle,
        pending: !!(handle && (!user || !stats || !ratingHistory))
      });
      return;
    }
    if (method === 'POST' && p === '/api/profile') {
      const body = await readBody(req, 1024 * 1024);
      const current = loadProfile() || {};
      const patch = {
        profileText: typeof body.profileText === 'string' ? body.profileText : (current.profileText || ''),
        strengths: Array.isArray(body.strengths) ? body.strengths.map((x) => String(x).trim()).filter(Boolean) : (current.strengths || []),
        weaknesses: Array.isArray(body.weaknesses) ? body.weaknesses.map((x) => String(x).trim()).filter(Boolean) : (current.weaknesses || []),
        focus: Array.isArray(body.focus) ? body.focus.map((x) => String(x).trim()).filter(Boolean) : (current.focus || [])
      };
      const card = Object.assign({}, current, patch, { version: 1, updatedAt: Date.now() });
      saveProfile(card);
      sendJSON(res, 200, { ok: true, card });
      return;
    }
    if (method === 'POST' && p === '/api/profile/refresh') {
      const cfg = loadConfig();
      const handle = (cfg.cfHandle || '').trim();
      if (!handle) throw new HttpError(400, '请先在设置中填写 Codeforces 用户名');
      // 取最近一个教练会话作为分析素材
      const list = listConversations('').filter((c) => !c.archived);
      let conv = null;
      for (const item of list) {
        const c = loadConv(item.id);
        if (c && c.messages.length) { conv = c; break; }
      }
      const provider = cfg.providers.find((p) => p.id === (conv ? conv.providerId : cfg.defaultProviderId))
        || cfg.providers.find((p) => p.id === cfg.defaultProviderId)
        || cfg.providers[0];
      if (!provider) throw new HttpError(400, '尚未配置模型服务');
      const model = (conv && conv.model) || cfg.defaultModel || (provider.models && provider.models[0]) || '';
      if (!model) throw new HttpError(400, '未选择模型');
      const [userInfo, stats] = await Promise.all([cf.fetchUser(handle), cf.fetchSolvedStats(handle)]);
      const current = loadProfile() || {};
      // 手动刷新也走同一套"证据纪律"：**只把学员侧的内容当证据**，绝不把教练的讲解喂给分析师
      const evidence = { evidence: [], kinds: ['manual'] };
      if (conv) {
        const userMsgs = (conv.messages || []).filter((m) => m.role === 'user').slice(-3);
        userMsgs.forEach((m) => {
          const txt = contentText(m.content).replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
          if (txt) evidence.evidence.push('学员的提问：「' + txt.slice(0, 200) + '」');
          const code = harness.extractUserCode(contentText(m.content));
          if (code && code.length > 40) {
            evidence.kinds.push('user-code');
            evidence.evidence.push('学员贴过自己的代码（' + code.split('\n').length + ' 行）');
          }
        });
      }
      if (!evidence.evidence.length) evidence.evidence.push('（本轮没有学员侧文本证据，请只依据 CF 硬数据更新画像）');
      const parsed = await analyzeProfileWithLLM(cfg, provider, model, userInfo, stats, current, evidence);
      const card = Object.assign({}, current, {
        version: 1,
        updatedAt: Date.now(),
        cfHandle: handle,
        rating: userInfo.rating,
        rank: userInfo.rank,
        maxRating: userInfo.maxRating,
        solvedCount: stats.solvedCount,
        avgSolvedRating: stats.avgSolvedRating,
        byRating: stats.byRating,
        topTags: stats.topTags,
        recentSolved: stats.recentSolved,
        profileText: (parsed && parsed.profileText) || current.profileText || '',
        strengths: (parsed && Array.isArray(parsed.strengths) && parsed.strengths.length) ? parsed.strengths : (current.strengths || []),
        weaknesses: (parsed && Array.isArray(parsed.weaknesses) && parsed.weaknesses.length) ? parsed.weaknesses : (current.weaknesses || []),
        focus: (parsed && Array.isArray(parsed.focus) && parsed.focus.length) ? parsed.focus : (current.focus || [])
      });
      saveProfile(card);
      sendJSON(res, 200, { ok: true, card });
      return;
    }
    if (method === 'GET' && p === '/api/cf/stats') {
      try {
        const stats = await cf.fetchSolvedStats(url.searchParams.get('handle'));
        sendJSON(res, 200, stats);
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
      return;
    }
    if (method === 'GET' && p === '/api/cf/rating') {
      try {
        const history = await cf.fetchRatingHistory(url.searchParams.get('handle'));
        sendJSON(res, 200, { history });
      } catch (e) {
        sendJSON(res, 400, { error: e.message, history: [] });
      }
      return;
    }

    /* ---- 配置 ---- */
    if (method === 'GET' && p === '/api/config') {
      sendJSON(res, 200, loadConfig());
      return;
    }
    if (method === 'POST' && p === '/api/config') {
      const body = await readBody(req, 20 * 1024 * 1024);   // 允许自定义背景图（dataURL）
      if (!body || typeof body !== 'object') throw new HttpError(400, '无效配置');
      config = Object.assign({}, DEFAULT_CONFIG, body);
      config.defaultParams = Object.assign({}, DEFAULT_CONFIG.defaultParams, body.defaultParams || {});
      if (!Array.isArray(config.providers)) config.providers = [];
      saveConfig();
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* ---- 模型列表 / 测试连接 ---- */
    if (method === 'POST' && p === '/api/providers/test') {
      const body = await readBody(req);
      const provider = body.provider;
      if (!provider || !provider.baseUrl) throw new HttpError(400, '缺少服务信息');
      try {
        const models = await fetchModels(provider);
        sendJSON(res, 200, { ok: true, modelCount: models.length, sample: models.slice(0, 5), models });
      } catch (e) {
        sendJSON(res, 200, { ok: false, error: friendlyError(e) });
      }
      return;
    }
    {
      const m = p.match(/^\/api\/providers\/([a-zA-Z0-9_\-]+)\/models$/);
      if (method === 'GET' && m) {
        const cfg = loadConfig();
        const provider = cfg.providers.find((x) => x.id === m[1]);
        if (!provider) throw new HttpError(404, '服务不存在');
        const models = await fetchModels(provider);
        sendJSON(res, 200, { models });
        return;
      }
    }

    /* ---- 会话列表 / 新建 / 清空 ---- */
    if (method === 'GET' && p === '/api/conversations') {
      const archived = url.searchParams.get('archived');
      const list = listConversations(url.searchParams.get('q') || '');
      const filtered = archived !== null ? list.filter((c) => c.archived === (archived === '1')) : list;
      // 标记正在生成中的会话（前端可以显示转圈、也可以后台并发跑）
      const active = [...activeGenerations];
      filtered.forEach((c) => { c.active = activeGenerations.has(c.id); });
      sendJSON(res, 200, { conversations: filtered, active });
      return;
    }
    /* ---- 正在生成的会话清单（并发/后台运行状态） ---- */
    if (method === 'POST' && p === '/api/chat/stop') {
      // 显式停止：不依赖"客户端断开"的信号（浏览器 abort fetch 时服务端不一定收到 close），
      // 直接把这次生成取消掉，让服务端走到统一的收尾逻辑（落盘 stopped + 释放活跃登记）
      const body = await readBody(req);
      const convId = String(body.conversationId || '');
      if (!convId) throw new HttpError(400, '缺少 conversationId');
      const stop = runStops.get(convId);
      if (stop) {
        stop();
        sendJSON(res, 200, { ok: true, stopped: true });
      } else {
        sendJSON(res, 200, { ok: true, stopped: false, note: '该会话当前没有正在进行的生成' });
      }
      return;
    }
    if (method === 'GET' && p === '/api/generations') {
      sendJSON(res, 200, { active: [...activeGenerations] });
      return;
    }
    if (method === 'POST' && p === '/api/conversations') {
      const body = await readBody(req);
      const extra = {};
      if (body && typeof body.providerId === 'string' && body.providerId) extra.providerId = body.providerId;
      if (body && typeof body.model === 'string' && body.model) extra.model = body.model;
      const conv = newConversation(extra);
      if (body && typeof body.title === 'string' && body.title.trim()) conv.title = body.title.trim();
      saveConv(conv);
      sendJSON(res, 200, conv);
      return;
    }
    if (method === 'DELETE' && p === '/api/conversations') {
      if (url.searchParams.get('confirm') !== '1') throw new HttpError(400, '需要 confirm=1');
      let n = 0;
      for (const dir of [CONV_DIR, ARCH_DIR]) {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.json') && !f.includes('.tmp-')) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch {} }
        }
      }
      sendJSON(res, 200, { ok: true, deleted: n });
      return;
    }

    /* ---- 单个会话 ---- */
    {
      const m = p.match(/^\/api\/conversations\/([a-zA-Z0-9_\-]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'GET') {
          const conv = loadConv(id);
          if (!conv) throw new HttpError(404, '会话不存在');
          // 自愈：上次异常退出/中断遗留的 streaming 状态在这里统一清理（正在生成的不动）
          if (repairStaleStreaming(conv)) saveConv(conv);
          conv.active = activeGenerations.has(id);   // 是否正在后台生成（前端据此轮询/显示"生成中"）
          sendJSON(res, 200, conv);
          return;
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const conv = loadConv(id);
          if (!conv) throw new HttpError(404, '会话不存在');
          const allowed = ['title', 'pinned', 'archived', 'providerId', 'model', 'systemPrompt', 'params', 'mode', 'cfProblem', 'lang', 'intent', 'problemMeta', 'rich'];
          for (const k of allowed) {
            if (k in body) conv[k] = body[k];
          }
          conv.intent = normalizeIntent(conv.intent);   // 已下线的意图（如 proof）统一回落，避免存进非法值
          if (body.params) conv.params = Object.assign({ temperature: null, topP: null, maxTokens: null }, body.params);
          if (typeof conv.title === 'string') conv.title = conv.title.trim() || '新对话';
          conv.updatedAt = Date.now();
          saveConv(conv);
          sendJSON(res, 200, conv);
          return;
        }
        if (method === 'DELETE') {
          deleteConvFile(id);
          sendJSON(res, 200, { ok: true });
          return;
        }
      }
      const m2 = p.match(/^\/api\/conversations\/([a-zA-Z0-9_\-]+)\/(messages|clear)$/);
      if (m2 && method === 'POST') {
        const conv = loadConv(m2[1]);
        if (!conv) throw new HttpError(404, '会话不存在');
        if (m2[2] === 'clear') {
          conv.messages = [];
          conv.updatedAt = Date.now();
          saveConv(conv);
          sendJSON(res, 200, conv);
          return;
        }
        // 全量替换消息（删除单条 / 回滚）
        const body = await readBody(req);
        if (!Array.isArray(body.messages)) throw new HttpError(400, 'messages 必须为数组');
        conv.messages = body.messages;
        conv.updatedAt = Date.now();
        saveConv(conv);
        sendJSON(res, 200, conv);
        return;
      }
      const m3 = p.match(/^\/api\/conversations\/([a-zA-Z0-9_\-]+)\/classify$/);
      if (m3 && method === 'POST') {
        const conv = loadConv(m3[1]);
        if (!conv) throw new HttpError(404, '会话不存在');
        const cfg = loadConfig();
        const lastAssistant = (conv.messages || []).slice().reverse().find((m) => m.role === 'assistant');
        await classifyProblem(conv, cfg, lastAssistant ? lastAssistant.content : '');
        sendJSON(res, 200, { ok: true, problemMeta: conv.problemMeta });
        return;
      }
    }

    /* ---- 聊天（SSE） ---- */
    if (method === 'POST' && p === '/api/chat') {
      await handleChat(req, res);
      return;
    }

    /* ---- 导出 / 导入 ---- */
    if (method === 'GET' && p === '/api/export/all.json') {
      const all = [];
      for (const dir of [CONV_DIR, ARCH_DIR]) {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
          const c = readJSON(path.join(dir, f), null);
          if (c && c.id) all.push(c);
        }
      }
      const payload = { app: 'cf-coach', version: 1, exportedAt: new Date().toISOString(), conversations: all };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="chatbox-export-' + new Date().toISOString().slice(0, 10) + '.json"'
      });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }
    {
      const m = p.match(/^\/api\/export\/([a-zA-Z0-9_\-]+)\.md$/);
      if (method === 'GET' && m) {
        const conv = loadConv(m[1]);
        if (!conv) throw new HttpError(404, '会话不存在');
        const md = convToMarkdown(conv);
        const fname = encodeURIComponent(conv.title.replace(/[\\/:*?"<>|]/g, '_')) + '.md';
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + fname
        });
        res.end(md);
        return;
      }
    }
    if (method === 'POST' && p === '/api/import') {
      const body = await readBody(req);
      const items = Array.isArray(body.conversations) ? body.conversations : (body && body.id ? [body] : []);
      if (!items.length) throw new HttpError(400, '文件中没有找到会话数据');
      const existing = new Set();
      for (const dir of [CONV_DIR, ARCH_DIR]) {
        for (const f of fs.readdirSync(dir)) existing.add(f.replace(/\.json$/, ''));
      }
      let imported = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object' || !Array.isArray(item.messages)) continue;
        let id = String(item.id || '');
        while (!id || existing.has(id)) id = uid('c_');
        existing.add(id);
        const conv = {
          id,
          title: String(item.title || '导入的对话'),
          providerId: String(item.providerId || ''),
          model: String(item.model || ''),
          systemPrompt: String(item.systemPrompt || ''),
          params: Object.assign({ temperature: null, topP: null, maxTokens: null }, item.params || {}),
          createdAt: Number(item.createdAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
          archived: !!item.archived,
          pinned: !!item.pinned,
          messages: item.messages.filter((mm) => mm && (mm.role === 'user' || mm.role === 'assistant' || mm.role === 'system'))
            .map((mm) => Object.assign({}, mm, { id: uid('m_') }))
        };
        saveConv(conv);
        imported++;
      }
      sendJSON(res, 200, { ok: true, imported });
      return;
    }

    /* ---- 静态文件 ---- */
    if (method === 'GET' || method === 'HEAD') {
      serveStatic(req, res);
      return;
    }
    throw new HttpError(404, 'Not Found');
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (e instanceof HttpError) sendJSON(res, e.status, { error: e.message });
    else sendJSON(res, 500, { error: friendlyError(e) });
  }
});

/* ---------------- 启动 ---------------- */

function startServer(port, host, onReady) {
  server.listen(port, host, () => {
    const addr = server.address();
    console.log('======================================================');
    console.log('  LLM ChatBox 已启动');
    console.log('  地址:     http://' + addr.address + ':' + addr.port);
    console.log('  数据目录: ' + DATA_DIR + '  （所有对话均为本地文件，不上传）');
    console.log('  仅监听本机回环地址，局域网不可访问');
    console.log('======================================================');
    if (onReady) onReady(addr);
    // 后台预热题目总表（首启约 2MB，之后 24h 内直接读磁盘缓存）；失败静默
    setTimeout(() => { try { cf.warmup(); } catch (e) { /* ignore */ } }, 800);
  });
  return server;
}

if (require.main === module) {
  startServer(PORT, HOST);
}

module.exports = { startServer, DATA_DIR };
