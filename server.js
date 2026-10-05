/**
 * CF Coach — 本地优先的 Codeforces 算法教练：先验证，再讲解（服务端）
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
const skillsLib = require('./lib/skills');
const toolsLib = require('./lib/tools');
const agentloop = require('./lib/agentloop');
const cfreview = require('./lib/cfreview');
const diagbundle = require('./lib/diagbundle');

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
cfreview.setCacheDir(DATA_DIR); // 题解缓存（data/cache/editorials/<题号>.json）：同一道题只抓一次

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

/** 读出全部会话（含归档）。给"批量操作 / 文件夹重排"这类需要遍历全部会话的地方用 */
function eachConversation() {
  const out = [];
  for (const dir of [CONV_DIR, ARCH_DIR]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { /* 目录不存在就跳过 */ }
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
      const c = readJSON(path.join(dir, f), null);
      if (c && c.id) out.push(c);
    }
  }
  return out;
}

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

/* ---------------- 对话文件夹 ----------------
 * 为什么单独一个文件：文件夹是"整理用语料"，跟会话内容无关，也不需要跟着会话搬家
 * （归档/恢复会移动会话文件，文件夹清单不该跟着抖）。一个 JSON 数组，坏了也只丢分类，不丢对话。
 */
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');

function loadFolders() {
  const j = readJSON(FOLDERS_FILE, null);
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.folders) ? j.folders : []);
  return list.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
    .map((f) => ({ id: f.id, name: String(f.name).slice(0, 40), at: f.at || Date.now() }));
}
function saveFolders(list) {
  writeFileAtomic(FOLDERS_FILE, JSON.stringify(list, null, 2));
}
function newFolder(name) {
  return { id: uid('f_'), name: String(name || '新文件夹').trim().slice(0, 40) || '新文件夹', at: Date.now() };
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
    intent: 'auto',        // 提问意图：auto（默认，由模型判断）| full | hint | explain | debug
    rich: false,           // 富讲解模式：允许输出可视化 HTML 组件（更耗 token）
    cfProblem: null,       // { contestId, index, title }
    // 题面的**持久化存放处**：CF 抓到的、用户粘贴后被整理成标准结构的，都写在这里。
    // 为什么必须落盘：追问时流水线/工具循环都要重新拿到题面，而旧版只存在局部变量里，
    // 第二轮起题面就退化成"用户这一句提问"（实测事故的根因）。
    statementText: '',
    problemMeta: null,     // 题目分类：{ rating, knowledge[], summary, tags[], contest, source }
    createdAt: now,
    updatedAt: now,
    archived: false,
    pinned: false,
    folder: '',            // 所属文件夹 id（'' = 未分类）；文件夹清单在 data/folders.json
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

/**
 * 清理历史消息里被写进去的**上游工具调用标记**（线上事故：模型把内部 DSML 标记当正文吐出来，
 * 应用又当成"讲解"存了下来）。服务端已经不会再产出这种正文（见 lib/agentloop.js 的泄漏处理），
 * 但用户文件里可能已经存着被污染的那一条：打开会话时顺手修掉，返回改动条数。
 *
 * ⚠️ 只动 content（正文），不碰 richDoc / 工具链 / reasoning。
 */
function repairLeakedMarkup(conv) {
  if (!conv || !Array.isArray(conv.messages)) return 0;
  let n = 0;
  for (const m of conv.messages) {
    if (!m || typeof m.content !== 'string' || !agentloop.hasLeakMarkup(m.content)) continue;
    const cleaned = agentloop.stripLeakMarkup(m.content).trim();
    m.content = cleaned || '（这条消息的正文全是模型内部工具标记，已清理：它没有真正回答你的问题，可以点"重新生成"。）';
    if (!m.leakRepaired) m.leakRepaired = true;
    n++;
  }
  if (n) conv.leakRepairedCount = (conv.leakRepairedCount || 0) + n;
  return n;
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

/**
 * 浏览器抓取通道（源码 / 提交页）：由 Electron 主进程注入。
 * 为什么需要它：Codeforces 的**网页**全在 Cloudflare 后面（实测普通 HTTP 一律 403 + cf-mitigated: challenge，
 * 无头浏览器也会被识破），只有真实非无头 Chromium 能过——那是桌面版才有的能力。
 * Web 模式（node server.js）下它是 null，工具会如实告诉用户"请把代码粘过来"。
 */
let submissionBrowserFetch = null;
function setSubmissionBrowserFetch(fn) {
  submissionBrowserFetch = typeof fn === 'function' ? fn : null;
  console.log('[cf] 提交源码浏览器通道: ' + (submissionBrowserFetch ? '已启用' : '未启用'));
}

/** 官方题解的浏览器抓取通道（同样由桌面版注入；不是每道题都有题解） */
let editorialBrowserFetch = null;
function setEditorialBrowserFetch(fn) {
  editorialBrowserFetch = typeof fn === 'function' ? fn : null;
  console.log('[cf] 题解浏览器通道: ' + (editorialBrowserFetch ? '已启用' : '未启用'));
}

/**
 * CF 会话预热通道（桌面版注入）。
 *
 * 为什么要提前预热：新进程里**第一个** CF 网页请求容易被 CF 拒（302 回首页），
 * 之后才正常——实测第一条提交要 6~12 秒才抓到（含一次失败重试），后面的只要 1.5~2.5 秒。
 * 复盘页一打开就预热，等于把这笔"冷启动开销"花在用户挑题的时候，而不是让他盯着进度条等。
 * 是幂等的：一个进程只真正做一次（见 electron/main.js 的 warmCfSession）。
 */
let cfWarmOpener = null;
function setCfWarmOpener(fn) {
  cfWarmOpener = typeof fn === 'function' ? fn : null;
  console.log('[cf] 会话预热通道: ' + (cfWarmOpener ? '已启用' : '未启用'));
}

/** 反爬挑战的人工兜底通道（打开可见窗口让挑战跑完）；同样只在桌面版可用 */
let challengeWindowOpener = null;
function setChallengeWindowOpener(fn) {
  challengeWindowOpener = typeof fn === 'function' ? fn : null;
}

/** Codeforces 登录通道（应用内浏览器登录一次；抓提交源码必需） */
let cfLoginOpener = null;
function setCfLoginOpener(fn) {
  cfLoginOpener = typeof fn === 'function' ? fn : null;
}

/**
 * agent 调用桥：`agentCall` / `agentModelLabel` 需要读写 handleChat 里的流式缓冲，
 * 所以把那个缓冲对象传进来（读写它的字段），而不要把它们定义在 handleChat 内部——
 * 工具循环（live 分支）与验证链（runVerify）都要用它们，必须是模块级可见的。
 *
 * @param {object} deps cfg / provider / model / send / signal / stream
 *   `stream` 是 handleChat 里的流式缓冲对象 { content, reasoning, target }（就地读写）
 */
function makeAgentCall(deps) {
  const { cfg, provider, model, send, stream } = deps;
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
    if (toMessage) { stream.content = ''; stream.reasoning = ''; }
    send('agentStart', { role: opts.role, label, reset: toMessage, model: (tuned.provider && tuned.provider.name ? tuned.provider.name + ' · ' : '') + tuned.model });
    try {
      const text = await callAgentLLM({
        provider: tuned.provider,
        model: tuned.model,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        // 默认挂上本次生成的取消信号：路由/选题评估/手算锚点这些辅助调用也必须能被"停止"打断，
        // 否则点了停止还得等一次几分钟的模型调用返回，界面会一直挂着"正在生成中"
        signal: opts.signal || deps.signal(),
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
            stream.content += t;
            streamMsg('content');
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
            stream.reasoning += t;
            streamMsg('reasoning');
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
  function streamMsg(which) {
    const t = stream.target;
    if (!t) return;
    if (which === 'content') t.content = stream.content;
    else t.reasoning = stream.reasoning;
  }
  return { agentCall, agentModelLabel };
}

/**
 * 教练的系统提示词：人格（skills/_coach.md）+ 技能目录 + 当前状态。
 * **技能目录是常驻的**（只有名字与一句话描述），技能正文按需注入（模型自己调 skill 工具读），
 * 这样加技能不会让每轮 prefill 线性膨胀。
 */
/**
 * 意图的"该怎么做"交代（给教练看，不是给用户看）。
 *
 * auto 是默认值：交给模型按用户原话判断。它的判断结果会作为**本轮实际意图**记下来
 * （见 handleChat 里按模型加载的技能回填 intent），所以画像证据、题目分类这些下游
 * 拿到的是"它真的做了什么"，而不是用户菜单里那个可能并不合适的选项。
 */
function intentBrief(intent) {
  const v = normalizeIntent(intent);
  return COACH_INTENTS[v] ? (v + '｜' + COACH_INTENTS[v]).replace(/^auto\|/, '自动（由你判断）｜') : COACH_INTENTS.full;
}

/** 把意图值换成一句人话（日志/证据用） */
function intentLabel(intent) {
  const v = normalizeIntent(intent);
  return ({ auto: '自动', full: '完整讲解', hint: '思路提示', explain: '题干解读', debug: '代码评估' })[v] || '完整讲解';
}

/** 模型读了哪个技能 ≈ 它给自己定的意图（auto 模式下用来回填本轮意图） */
const SKILL_TO_INTENT = {
  'cf-explain': 'full',
  'cf-debug': 'debug',
  'cf-hint': 'hint',
  'cf-verify': 'full',
  'cf-review': 'full',
  'cf-doc': 'full'
};

function buildCoachSystem(o) {
  const conv = o.conv || {};
  const parts = [];
  const persona = skillsLib.loadInternal('_coach');
  if (persona) parts.push(persona);
  const catalog = skillsLib.catalog();
  if (catalog) parts.push(catalog);

  const wsKey = workspace.keyFor({ id: conv.id, cfProblem: conv.cfProblem });
  const sum = workspace.summary(wsKey);
  const v = (sum.meta && sum.meta.verification) || null;
  const state = ['<current_state>'];
  if (conv.cfProblem) {
    state.push('当前题目：Codeforces ' + conv.cfProblem.contestId + conv.cfProblem.index
      + (conv.cfProblem.title ? '「' + conv.cfProblem.title + '」' : '')
      + (conv.problemMeta && conv.problemMeta.rating ? '（' + conv.problemMeta.rating + ' 分）' : ''));
  } else if (conv.statementText) {
    state.push('当前题目：用户粘贴的题面（' + conv.statementText.length + ' 字符，已完整保存在会话里，后续轮次直接引用，**不需要重新索要**）');
  } else {
    state.push('当前题目：尚未确定');
  }
  state.push('题面是否已在会话中：' + ((conv.statementText || '').trim() ? '是' : '否'));
  /**
   * 题面正文必须**真的进 prompt**，不能只声明"它在会话里"。
   *
   * 为什么（2026-10 事故）：题面只存在会话对象 `conv.statementText` 里，正文从不进上下文；
   * 而"最后一步/泄漏重试"那条窄上下文路径只带最近几条 user/assistant 消息 → 模型真的看不到题面，
   * 于是它说"题面正文和我刚才那几轮工具跑出来的结果，都没有进到我写这轮回答的上下文里——我现在手里其实是空的"
   * （2260G）。只声明"已完整保存在会话里、不需要重新索要"是**它看不见的承诺**，等于误导。
   */
  const stmtBody = String(conv.statementText || '').trim();
  if (stmtBody) {
    const stmtCap = 4000;
    state.push('题面正文（' + (stmtBody.length > stmtCap ? '已截断到前 ' + stmtCap + ' 字符' : '全文') + '）：\n'
      + stmtBody.slice(0, stmtCap));
  }
  /**
   * 题面已在会话里 → **明令禁止**再去联网取。
   *
   * 为什么写成祈使句：只说"是否已在会话中：是"是陈述句，模型照样会`cf_fetch`一次
   * （真实事故：用户把题面粘进对话框，教练还是去 CF 取了一遍，白等一轮往返，
   * 而且那次`cf_fetch`把样例覆盖成了官方 1 组，反而更差）。
   */
  if ((conv.statementText || '').trim()) {
    state.push('⛔ 题面正文已经在会话里了（就是上面那份）：**不要再调 cf_fetch 联网取题**。'
      + 'cf_verify / cf_contract / cf_doc 都会自己读会话里的题面，直接用即可；'
      + '只有会话里确实没有题面时才取。'
      + '唯一例外：如果官方样例是 0 组（粘贴的题面机械解析不出样例），可以取一次题把**结构化样例**拿回来，比机械解析可靠。');
  } else if (conv.cfProblem) {
    state.push('题面还没取：需要题面时用 cf_fetch 取一次（一次就够）。');
  }
  state.push('官方样例：' + ((conv.cfProblemSamples || []).length) + ' 组');
  if (v) {
    state.push('本题工作区验证记录：status=' + v.status + (v.reason ? '（' + v.reason + '）' : '')
      + '｜对拍 ' + (v.iterations || 0) + ' 组｜' + (v.at ? new Date(v.at).toLocaleString() : ''));
  } else {
    state.push('本题工作区：尚无验证记录');
  }
  if (o.userInfo) state.push('学员：' + o.userInfo.handle + '，rating ' + o.userInfo.rating + '（' + o.userInfo.rank + '，最高 ' + o.userInfo.maxRating + '）');
  if (o.lang) state.push('默认语言：' + (o.lang === 'python' ? 'Python' : 'C++'));
  /**
   * 本次意图：界面上那个「完整讲解 / 思路提示 / 题干解读 / 代码评估」选择器必须让模型看见。
   *
   * 为什么专门写一句：意图以前是流水线的一个入参（它据此决定讲解等级），改成工具循环之后
   * 没有任何地方把它传进来 —— 选择器就变成了摆设（用户改了没反应，属于静默失效）。
   * 这里连同"这个意图下该做什么"一起交代清楚，模型才知道该给方向还是给完整推导。
   */
  if (o.intent) state.push('本次意图：' + intentBrief(o.intent));
  if (o.runtimes) state.push('本机运行时：' + o.runtimes);
  if (o.profile && (o.profile.profileText || (o.profile.strengths || []).length)) {
    state.push('学员信息卡：' + [
      (o.profile.strengths || []).length ? '优势 ' + o.profile.strengths.join('、') : '',
      (o.profile.weaknesses || []).length ? '薄弱 ' + o.profile.weaknesses.join('、') : '',
      o.profile.profileText || ''
    ].filter(Boolean).join('；'));
  }
  state.push('</current_state>');
  parts.push(state.join('\n'));
  return parts.join('\n\n');
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
        folder: c.folder || '',
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
  /**
   * auto：**默认**。由模型自己判断这次要哪一种（技能也由它自己选，两者是一回事）。
   * 为什么要它：意图本质上是"用户这句话在要什么"，模型看得到原话、上下文、学员画像，
   * 比用户先在菜单里选一次更准（用户还得先想清楚"我这算讲解还是评估"）。
   * 判断口径写在 _coach.md 与各技能里；用户想要确定的行为时仍然可以手动指定。
   */
  auto: '自动判断：由你（模型）看用户这句话在要什么，从下面的四种里选一种并按对应技能执行——'
    + '① 完整讲解（要"讲透/怎么做"）② 思路提示（卡住了，只要方向）③ 题干解读（没看懂题）'
    + '④ 代码评估（贴了代码问为什么错 / 提了个做法问行不行）。'
    + '【默认档】只贴题面、或只给题号+一句"讲一下"，一律按**完整讲解**做；'
    + '不要为了确认意图反问用户（"你是想要思路还是完整讲解？"）——那只是把选择权又推回给他。'
    + '只有用户明确说"先别给答案/只要思路"时才降到思路提示。',
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

/**
 * 本机运行环境（带短 TTL 的缓存）。
 *
 * 为什么要 TTL：原来缓存一次就永远不再探测 —— 用户按提示装好 Python/g++ 之后，
 * 应用仍按"不可用"走（工具描述、验证链语言选择都按旧结果），体验上是"装了也没用"。
 * 30 秒足够挡住高频调用，又能在用户装完运行时后很快自愈。
 */
const RUNTIMES_TTL_MS = 30 * 1000;
let runtimesCache = null;
let runtimesAt = 0;
async function getRuntimes() {
  if (!runtimesCache || Date.now() - runtimesAt > RUNTIMES_TTL_MS) {
    runtimesCache = await runner.availableRuntimes();
    runtimesAt = Date.now();
  }
  return runtimesCache;
}
function runtimesText(r) {
  const text = ['C++ (g++17)', 'Python 3', 'Node.js'].map((label, i) => {
    const ok = i === 0 ? r.cpp : (i === 1 ? r.python : r.js);
    return label + (ok ? '可用' : '不可用');
  }).join('；');
  return text + runtimesAdvice(r);
}
/**
 * 运行环境给出的**行动建议**（写进系统提示词）。
 * 真实事故：朋友的电脑没有 g++ —— 模型照样按 C++ 交代码，验证链按 cpp 编译失败 → NO-BRULER，
 * 又反复重跑，最后连讲解都没交付。这里把"本机事实 → 该怎么做"直接写清楚。
 */
function runtimesAdvice(r) {
  if (!r || (!r.cpp && !r.python && !r.js)) {
    return '。⚠ 本机没有任何可用运行时：验证链跑不了（不要反复重试 cf_verify），'
      + '请直接按"纯推理 + 如实说明未验证"交付讲解（首句说明未在本机验证、用手算小样例与静态推理讲清楚、'
      + '并告诉用户装 Python 3 或 g++ 后可以自动跑对拍）。';
  }
  if (!r.cpp) {
    return '。⚠ 本机没有 g++：写代码一律用 Python（cf_verify/cf_run 的语言请传 python），'
      + '不要交 C++ 代码，也不要因为 C++ 跑不了就反复重试验证。';
  }
  return '。';
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
  /**
   * mode:
   *   send       用户发了一条新消息（默认）
   *   edit       编辑某条历史消息后重发
   *   regenerate 重答最后一条
   *   continue   **不加新消息**，直接以现有对话历史起一轮 —— 给"材料已经装好、
   *              让教练主动开讲"的场景用（复盘界面就是：材料装进会话后自动开讲，
   *              不需要用户再打一句"开始吧"）
   */
  const mode = (body.mode === 'edit') ? 'edit'
    : (body.mode === 'regenerate') ? 'regenerate'
      : (body.mode === 'continue') ? 'continue' : 'send';
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
  if (mode !== 'regenerate' && mode !== 'continue' && !userText && !contentHasImage(userContent)) {
    throw new HttpError(400, '消息内容为空');
  }
  if (mode === 'continue' && !convPeek.messages.some((m) => m.role === 'user')) {
    throw new HttpError(400, '会话里还没有任何用户消息，无法继续');
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
      // mode='continue' **不追加用户消息**：直接以现有历史（含界面装好的复盘材料）起一轮，
      // 这样"材料装好 → 教练自动开讲"不需要用户再打一句"开始吧"。
      if (mode !== 'continue') {
        msgs.push({
          id: uid('m_'),
          role: 'user',
          content: userContent,
          createdAt: now
        });
      }
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
    /**
     * 本轮验证状态也要放在函数作用域：
     * 异常/中断收尾路径（finalizeStopped）以前**丢掉了它** → 用户看到的是模型的夸大散文，
     * 而工作区里明明是 `no-bruler`／对拍 0 组（2026-10 事故：正文写"官方样例 6/6 + 31150 组随机对拍零不一致"）。
     */
    let turnVerification = null;
    const finalizeStopped = (status, errMsg) => {
      const t = assistantTarget || conv.messages.find((m) => m.id === assistantMsgId);
      if (t) {
        t.content = content;
        t.reasoning = reasoning;
        t.status = status;
        t.error = errMsg || '';
        if (turnVerification && !t.verification) {
          t.verification = turnVerification;
          if (turnVerification.status && turnVerification.status !== 'ok') {
            send('notice', {
              level: 'warn',
              message: '本轮验证未通过（' + turnVerification.status + '）：上面这段回答里关于"已验证"的说法以工作区验证记录为准。'
            });
          }
        }
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

      /**
       * 流式缓冲的**单一真相**：content / reasoning 就是它，target 是这条助手消息。
       * 工具循环（agentloop）与验证链（cf_verify 的子 agent）都通过它读写，
       * 所以界面上的增量、消息上落盘的内容、以及最终回答永远是同一份数据。
       */
      const streamState = { content: '', reasoning: '', target: assistantTarget };

      // 收尾任务（信息卡 / 题目分类）需要的"学员侧证据"。
      // 必须声明在**教练分支之外**：intent / userCode / userTextFull 都是分支内的局部变量，
      // 分支外直接引用会 ReferenceError（曾被外层 catch 吞掉 → 信息卡与分类双双失效、消息状态被改成 error）
      let postRun = null;
      let runUsage = null;   // 本轮（教练模式）的 token 用量与估算费用
      if (conv.mode === 'coach') {
        // ===== 教练模式·工具循环 =====
        // 这里是本次改造的核心：不再把用户发言塞进写死的流水线，而是跑一个真正的 agent 回合——
        // 真实对话历史参与、模型自己决定调哪个工具（取题 / 对拍 / 运行 / 复盘）、技能按需注入。
        //
        // 老的多 Agent 流水线（harness.runPipeline）**完整保留**，现在作为 `cf_verify` 工具的实现：
        // 它对拍的诚实性保证（标尺隔离、只重写有罪方、反例不得来自失信标尺）一行都没动，
        // 只是不再无条件地在每一轮都跑一遍。
        const lang = conv.lang || cfg.defaultCoachLang || 'cpp';
        // mode='continue' 没有新的用户消息，给模型一句"接着上面的材料开始"的引导语。
        // 注意它只进 prompt，**不写进会话文件**（否则历史里会多出一条用户没打过的消息）。
        const userTextFull = (mode === 'continue' && !contentText(userContent).trim())
          ? '（材料就是上面那条消息，请直接按它的要求开始：先给全局分布，再逐题诊断，最后给下场比赛的行动项。）'
          : contentText(userContent);
        const profile = loadProfile();
        let userInfo = null;
        const cfHandle = (cfg.cfHandle || '').trim();
        if (cfHandle) {
          try { userInfo = await cf.fetchUser(cfHandle); } catch (e) { /* 查询失败不阻塞 */ }
        }
        const rtFlags = await getRuntimes();
        const rt = runtimesText(rtFlags);

        // 工具调用在界面上的"步骤 chip"（取题 / 对拍 / 复盘…每步都让学员看见）
        const runToolChips = [];
        /**
         * 本轮用量账本：工具循环自己的调用 + **工具内部的验证链**。
         *
         * 为什么必须合并：验证链（三个代码 Agent + 样例校准 + 批量对拍）是本轮最贵的一段，
         * 而它现在跑在 `cf_verify` 工具里。只统计工具循环那两次调用，"讲这道题花了多少"就是假的
         * （产品承诺是花费透明）。按角色分开记，界面才能继续按 Agent 拆分。
         */
        const usageBook = { calls: 0, promptTokens: 0, completionTokens: 0, byRole: {} };
        /**
         * 本轮的验证结论（由工具内部的验证链回填）。
         * 为什么要留这一份：验证状态必须挂到消息上（历史里能看到"这题验证到什么程度"），
         * 未通过时还要给用户一条**可见**提醒 —— 以前这两件事由流水线路径做，
         * 改成工具循环后它们一起消失了：学员看到一段讲得很自信的讲解，却不知道它没验证过。
         */
        turnVerification = null;   // 已在函数作用域声明（finalizeStopped 也要读它）
        const addUsage = (role, u) => {
          if (!u) return;
          const key = role || 'coach';
          const slot = usageBook.byRole[key] || (usageBook.byRole[key] = { calls: 0, promptTokens: 0, completionTokens: 0 });
          const calls = u.calls || 0;
          const pin = u.promptTokens || 0;
          const pout = u.completionTokens || 0;
          slot.calls += calls; slot.promptTokens += pin; slot.completionTokens += pout;
          usageBook.calls += calls; usageBook.promptTokens += pin; usageBook.completionTokens += pout;
        };
        /** 并入工具内部验证链的用量：它自己已经按角色分好，别再累加一次总数（会翻倍） */
        const addPipelineUsage = (u) => {
          if (!u) return;
          const by = (u.byRole && Object.keys(u.byRole).length) ? u.byRole : null;
          if (by) Object.keys(by).forEach((k) => addUsage(k, by[k]));
          else addUsage('verify', u);
        };
        // agent 调用桥（模块级工厂）：工具循环与 cf_verify 共用同一份实现
        const { agentCall, agentModelLabel } = makeAgentCall({
          cfg, provider, model, send, signal: () => ctrl.signal,
          stream: streamState
        });

        /**
         * auto 意图下，模型自己选了哪个技能 → 本轮"实际意图"。
         * 为什么要回填：画像证据、题目分类这些下游要的是"它真的做了什么"，
         * 而不是用户菜单里那个（auto 模式下）并不存在的选项。
         */
        let autoIntent = '';
        /** 本轮有没有试过产出文档（试过就不再催第二次） */
        let docTried = false;
        /** 是否已经补过"如实交付"那一轮（只补一次，避免死循环） */
        let honestTried = false;
        /** 本轮已经验证过的题目（同题不重复跑全链路）+ 那次的结果 */
        let turnVerifyKey = '';
        let turnVerifyResult = null;

        /**
         * 用户**直接把题面贴在输入框里**（最常见的用法）→ 先用机械工具登记，再进模型循环。
         *
         * 为什么必须在这里做：这道机械登记（`statement.looksStandard` 抽输入/输出格式段与样例）
         * 就是原来的"题面格式化工具"。改成工具循环之后，只有模型主动把 statement 传给 cf_fetch
         * 才会触发它 —— 而模型更常见的动作是自己去 `cf_fetch(contestId)` 联网取一遍
         * （真实事故：用户粘了题面，教练还去 CF 抓了一次；抓回来的样例反而更少）。
         * 贴在输入框里的题面本来就够标准，机械抽一遍即可，既省一次往返也让样例当场可用。
         */
        // 门槛只防"一句话里带了'输入格式'字样"的误判（真正的题面至少上百字）
        if (String(userTextFull || '').length > 120) {
          const det = statementLib.looksStandard(userTextFull, conv.cfProblemSamples || []);
          /**
           * 判据刻意放宽：只要有**输入/输出格式段**或**能机械抽出样例**任一项就登记。
           * 格式不标准的自由文本会由验证链里的【题面整理 Agent】接手整理
           * （runVerify 里那段 normalizeWithAgent）——那正是它存在的意义，
           * 不需要在这里就要求"标准"。
           */
          if (det.hasInput || det.hasOutput || (det.mechanicalSamples || []).length) {
            const prevLen = String(conv.statementText || '').length;
            if (String(userTextFull).length > prevLen) {
              conv.statementText = userTextFull;
              if ((det.mechanicalSamples || []).length && !(conv.cfProblemSamples || []).length) {
                conv.cfProblemSamples = det.mechanicalSamples;
              }
              if (typeof saveConv === 'function') saveConv(conv);
              console.log('[coach] 已机械登记用户粘贴的题面（' + conv.statementText.length + ' 字符，样例 '
                + ((conv.cfProblemSamples || []).length) + ' 组，格式'
                + (det.standard ? '标准' : '非标准：' + (det.reasons || []).join('；')) + '）');
            }
          }
        }

        // 历史：本轮助手占位消息之外的**全部**对话（这就是"追问不丢上下文"的关键，
        // 旧实现每次都只发一条 user 消息，模型连自己上一轮说过什么都不知道）
        /**
         * 历史 = 本轮助手占位消息之外的**全部**对话。
         *
         * ⚠️ 末尾那条"本轮用户消息"要去掉：`runTurn` 自己会把 userText 追加到消息列表末尾，
         * 这里再带上它，模型就会收到**两遍同样的用户发言**（实测 messages 形如
         * system,user,user,...）。多花的 token 是小事，把同一句话重复两遍更容易让模型
         * 以为是两次提问 —— 这是实打实的 prompt 缺陷。
         */
        const history = msgs
          .filter((m) => m.id !== assistantMsgId && (m.role === 'user' || m.role === 'assistant'))
          .filter((m) => m.status !== 'streaming')
          .map((m) => ({ role: m.role, content: contentText(m.content) }))
          // 历史里若残留上游工具标记（旧版本存下的污染消息），绝不原样回灌给模型：
          // 把工具调用标记当上下文回灌，正是上游再吐一次标记的诱因（见 lib/agentloop.js 泄漏说明）
          .map((m) => (agentloop.hasLeakMarkup(m.content) ? { role: m.role, content: agentloop.stripLeakMarkup(m.content) } : m))
          .filter((m) => String(m.content || '').trim())
          .filter((m, i, arr) => !(i === arr.length - 1 && m.role === 'user'
            && m.content.trim() === userTextFull.trim()));

        const tools = toolsLib.createTools({
          conv, cfg, lang, userInfo, profile, runtimes: rt,
          // 结构化运行时标志：工具描述与语言选择按本机事实走（没有 g++ 的机器不再交 C++）
          runtimeFlags: rtFlags,
          saveConv: () => saveConv(conv),
          signal: () => ctrl.signal,
          wsKey: () => workspace.keyFor({ id: conv.id, cfProblem: conv.cfProblem }),
          emit: (type, data) => send(type, data),
          browserFetch: submissionBrowserFetch,
          /**
           * 图文文档产出：挂到当前助手消息上 + 立刻推 richDoc 事件。
           *
           * 为什么必须有这一步：图文讲解是这个产品的核心交付形态。改成工具循环之后，
           * `cf_doc` 只把文件写进工作区、返回一个路径 —— 学员在对话里根本看不到那份文档，
           * 等于把最重要的东西从"交付"降级成"附件"。这里把文档挂回消息，前端照旧用
           * 沙箱 iframe 内联渲染，和流水线时代的行为一致。
           */
          onRichDoc: (a) => {
            if (assistantTarget) { assistantTarget.richDoc = a.html; assistantTarget.richDocPath = a.path; }
            send('richDoc', { messageId: assistantTarget ? assistantTarget.id : '', size: String(a.html || '').length });
          },
          /**
           * 文档被校验拒了：给用户一条**可见**提醒。
           * 学员看到的是"这次没有文档、只有文字"，必须知道为什么（否则就是静默降级）。
           */
          onRichDocRejected: (a) => {
            send('notice', { level: 'warn',
              message: '图文文档没通过校验，本次已用文字讲解代替。原因：'
                + ((a.errors || []).slice(0, 2).join('；') || '未知')
                + (a.path ? '（被拒的原文留在工作区 ' + String(a.path).split(/[\\/]/).pop() + '）' : '') });
          },
          // 验证链：复用编排器，但只跑到"验证结论"为止（verifyOnly），讲解交给教练自己说
          runVerify: async (vo) => {
            const key = workspace.keyFor({ id: conv.id, cfProblem: conv.cfProblem });
            const meta0 = workspace.loadMeta(key) || {};
            /**
             * **同一轮里**已经验证过、且这次没有新东西（没贴学员代码、没提新做法）→ 复用，不重跑。
             *
             * 为什么要这道闸：模型看到"验证"就想再跑一遍。真实事故里它在一轮对话内连跑两次全链路
             * （139 秒的 NO-BRULER + 199 秒的 OK），用户等了近 6 分钟，第二次什么新信息都没有。
             * 范围刻意限定在**本轮**：跨会话/跨轮次的复跑是合理需求（换一道题、换一次问法），
             * 而且流水线自己会复用已缓存的暴力解与生成器，成本本来就降下来了。
             */
            if (turnVerifyKey === key && turnVerifyResult && !vo.userCode && !vo.idea) {
              send('tool', { calls: [{ id: 'reuse1', name: 'harness_reuse', args: JSON.stringify({ label: '复用本轮已验证结论' }) }] });
              send('toolResult', { results: [{ id: 'reuse1', name: 'harness_reuse', ok: true,
                summary: '本轮已经验证过这道题（没有新代码/新做法），直接复用结论，不重跑对拍' }] });
              turnVerification = turnVerifyResult.verification;
              return turnVerifyResult;
            }
            const reuse = {};
            if (meta0.verification && meta0.verification.status === 'ok') {
              reuse.brute = workspace.readCache(key, workspace.bruteName(vo.lang)) || workspace.readFile(key, workspace.bruteName(vo.lang));
              reuse.gen = workspace.readCache(key, 'gen.py');
            }
            const runTools2 = [];
            /**
             * 粘贴题面：先机械判格式，不标准就派【题面整理 Agent】整理成标准结构（含结构化样例）。
             *
             * 为什么补在这里：这条逻辑以前在流水线入口，改成工具循环后没人接手 ——
             * 粘贴的自由文本会直接进对拍，抽不出样例就只能"无标尺"，验证质量明显下降。
             */
            let stmt = vo.statement;
            let samples = vo.samples;
            try {
              const std = statementLib.looksStandard(stmt, samples);
              if (!std.standard) {
                send('tool', { calls: [{ id: 'norm1', name: 'harness_normalize', args: JSON.stringify({ label: '题面格式体检' }) }] });
                const n = await statementLib.normalizeWithAgent({
                  callAgent: agentCall,
                  text: stmt,
                  mechanicalSamples: std.mechanicalSamples || [],
                  parseJson: (s) => { try { return JSON.parse(String(s || '').replace(/^```[a-z]*\n?|```$/g, '').trim()); } catch (e) { return null; } }
                });
                if (n && n.ok && n.data) {
                  stmt = statementLib.buildStandardStatement(n.data);
                  if (n.samples && n.samples.length) samples = n.samples;
                  send('toolResult', { results: [{ id: 'norm1', name: 'harness_normalize', ok: true,
                    summary: '题面整理 Agent 已把粘贴内容整理成标准结构（样例 ' + ((n.samples || []).length) + ' 组）' }] });
                } else {
                  send('toolResult', { results: [{ id: 'norm1', name: 'harness_normalize', ok: false,
                    summary: '题面不是标准格式，且整理失败（' + ((n && n.errors && n.errors[0]) || '未知原因') + '）→ 按原文继续，样例可能拿不到' }] });
                }
              }
            } catch (e) { console.log('[coach] 题面整理失败: ' + ((e && e.message) || e)); }
            /**
             * 学员提议的做法（"用 Floyd 能不能写"）：先机械评估可行性，再按它实现并对拍。
             *
             * 为什么放在验证链里：这一步以前由路由 + harness_idea 承担，改成工具循环后没人接手，
             * 教练就只能凭感觉说"应该可以"。评估结论随验证结论一起回到上下文，讲解才有依据。
             */
            let idea = null;
            if (vo.idea) {
              send('tool', { calls: [{ id: 'idea1', name: 'harness_idea', args: JSON.stringify({ label: '做法可行性评估' }) }] });
              idea = await harness.checkIdea({
                callAgent: agentCall,
                statement: stmt,
                question: vo.idea,
                contract: harness.extractContract(stmt),
                solCode: workspace.readFile(key, workspace.solName(vo.lang))
              });
              send('toolResult', { results: [{ id: 'idea1', name: 'harness_idea', ok: !!idea.viable,
                summary: (idea.viable ? '该做法可行' : '该做法不可行') + (idea.reason ? '：' + idea.reason : '')
                  + (idea.complexity ? '（' + idea.complexity + '）' : '') }] });
            }
            const res = await harness.runPipeline({
              conv, lang: vo.lang, intent: vo.intent || 'full',
              statement: stmt, samples, userCode: vo.userCode || '',
              userText: userTextFull, profile, rich: false, userInfo, runtimes: rt,
              workspace, wsKey: key,
              rating: (conv.problemMeta && conv.problemMeta.rating) || null,
              signal: ctrl.signal,
              verifyOnly: true,          // ← 只验证、不生成讲解文档
              // 做法可行 → 按学员的做法重写题解；不可行 → 不必再跑链路（讲解重点变成"为什么不行"）
              idea: (idea && idea.viable && vo.idea) ? { approach: vo.idea, complexity: idea.complexity || '' } : null,
              skipChain: !!(idea && !idea.viable),
              reuse,
              tiers: [8, 20, 50, 200],
              perTier: 50,
              maxStressMs: 180000,
              emit: (ev) => {
                if (!ev || !ev.type) return;
                if (ev.type === 'tool') {
                  (ev.calls || []).forEach((c) => {
                    let label = '';
                    try { label = (JSON.parse(c.args || '{}').label) || ''; } catch (e) { /* ignore */ }
                    runTools2.push({ id: c.id, name: c.name, label, state: 'running' });
                  });
                } else if (ev.type === 'toolResult') {
                  (ev.results || []).forEach((r) => {
                    const t = runTools2.find((x) => x.id === r.id);
                    if (t) { t.ok = r.ok; t.summary = r.summary; t.state = 'done'; }
                  });
                }
                if (assistantTarget && runTools2.length) assistantTarget.tools = runTools2.slice(-40);
                send(ev.type, ev);
              },
              callAgent: agentCall,
              describeModel: agentModelLabel
            });
            addPipelineUsage(res && res.usage);
            if (res && res.verification) turnVerification = res.verification;
            turnVerifyKey = key;
            turnVerifyResult = Object.assign({}, res, {
              verification: Object.assign({}, res.verification || {}, { reused: false })
            });
            if (idea) res.idea = idea;      // 评估结论交给教练（工具输出里会写成一段可读结论）
            return res;
          }
        });

        const runTurnHooks = {
          onDelta: (t) => {
            streamState.content += t;
            if (assistantTarget) assistantTarget.content = streamState.content;
            send('delta', { text: t });
          },
          onReasoning: (t) => {
            streamState.reasoning += t;
            if (assistantTarget) assistantTarget.reasoning = streamState.reasoning;
            send('reasoningDelta', { text: t });
          },
          onToolStart: (call) => {
            const id = call.id || ('c' + Math.random().toString(36).slice(2, 8));
            runToolChips.push({ id, name: call.name, label: '', state: 'running' });
            if (assistantTarget) assistantTarget.tools = runToolChips.slice(-40);
            // auto 意图：模型**实际读了哪个技能**就是它给自己定的意图，记下来当本轮真实意图
            if (call.name === 'skill') {
              try {
                const a = JSON.parse(call.args || '{}');
                const n = String(a.name || '').trim();
                if (SKILL_TO_INTENT[n]) autoIntent = SKILL_TO_INTENT[n];
              } catch (e) { /* 参数解析失败不影响主流程 */ }
            }
            if (call.name === 'cf_doc') docTried = true;
            send('tool', { calls: [{ id, name: call.name, args: call.args || '{}' }] });
          },
          onToolEnd: (call, ok, out, ms) => {
            const chip = runToolChips.slice().reverse().find((c) => c.name === call.name && c.state === 'running');
            const summary = String(out == null ? '' : out).replace(/\s+/g, ' ').slice(0, 200);
            if (chip) { chip.state = 'done'; chip.ok = ok; chip.summary = summary; chip.ms = ms; }
            if (assistantTarget) assistantTarget.tools = runToolChips.slice(-40);
            send('toolResult', { results: [{ id: chip ? chip.id : call.id, name: call.name, ok, summary }] });
          },
          onUsage: (u) => {
            if (!usage) usage = { promptTokens: 0, completionTokens: 0 };
            if (u.promptTokens != null) usage.promptTokens += u.promptTokens;
            if (u.completionTokens != null) usage.completionTokens += u.completionTokens;
            // 工具循环自己的调用按角色 'coach' 记账（与工具内部的子 Agent 区分开）
            addUsage('coach', { calls: 1, promptTokens: u.promptTokens || 0, completionTokens: u.completionTokens || 0 });
          }
        };
        let result = await agentloop.runTurn({
          provider, model,
          system: buildCoachSystem({ conv, profile, userInfo, runtimes: rt, lang, intent: conv.intent }),
          history,
          userText: userTextFull,
          tools,
          signal: ctrl.signal,
          maxTokens: (cfg.maxOutputTokens > 0) ? cfg.maxOutputTokens : 0,
          maxSteps: 12,
          ...runTurnHooks
        });

        /**
         * **图文文档是硬交付**：完整讲解跑完验证却只给了一堆文字（一张图都没有）→ 补一轮硬提醒。
         *
         * 为什么要在服务端兜这一下：文档完全靠模型自觉调用 cf_doc，而它常常讲完就收工
         * （真实事故：用户拿到的是一段纯文字 + 一张 markdown 表格，零 SVG，产品最核心的
         * "图文讲解"退化成了聊天）。提醒只补一次，避免死循环；已经试过 cf_doc 的不再催。
         */
        const convIntentNow = normalizeIntent(conv.intent);
        const wantDoc = convIntentNow === 'full' || (convIntentNow === 'auto' && (!autoIntent || autoIntent === 'full'));
        const verifiedThisTurn = runToolChips.some((c) => c.name === 'cf_verify' && c.ok !== false);
        /**
         * 这题**在本题工作区里已经验证通过**也算数。
         *
         * 真实事故（用户第二次反馈"依旧没有图"）：上一轮已经把这道题验证过（status=ok，对拍 200 组），
         * 这一轮教练按 cf-explain §0 的口径**正确地跳过了重复对拍**——于是"本轮跑过验证"这个前提不成立，
         * 文档提醒也没触发，结果又只给了一段纯文字。跳过验证是对的，跳过文档是错的：
         * 交付物该由"这题的结论可信吗"决定，而不是由"这一轮有没有重新跑一遍"决定。
         */
        const wsMetaNow = workspace.loadMeta(workspace.keyFor({ id: conv.id, cfProblem: conv.cfProblem })) || {};
        const wsVerified = !!(wsMetaNow.verification && wsMetaNow.verification.status === 'ok');
        const substantive = String(streamState.content || '').length > 700;
        /**
         * 用户明确只要方向时**不要**催文档。
         *
         * 为什么要单独判一次：auto 模式下我没法从技能名可靠地区分"它这次是讲解还是提示"
         * （两种都会读 cf-explain，提示的口径就写在那份技能里）。但用户自己的话是可靠信号——
         * "给点思路 / 先别给答案 / 不要代码"这类说法一出现，就必须按提示交付，别硬塞图文文档。
         */
        const askedForHint = /(给|要|想|求).{0,3}(点|个)?思路|只.{0,2}(要|给).{0,2}思路|别给答案|先别给|不要代码|不要给代码|提示一下|怎么想|没思路|卡住/.test(userTextFull || '');
        if (wantDoc && !docTried && !askedForHint && substantive && !(assistantTarget && assistantTarget.richDoc)
            && !ctrl.signal.aborted && (verifiedThisTurn || wsVerified)) {
          console.log('[coach] 完整讲解但没有图文文档 → 补一轮提醒');
          const before = streamState.content;
          result = await agentloop.runTurn({
            provider, model,
            system: buildCoachSystem({ conv, profile, userInfo, runtimes: rt, lang, intent: conv.intent }),
            history: history.concat([{ role: 'assistant', content: before }]),
            userText: '【系统提醒·与你上一段回答连续】你刚才只输出了文字，但本次是**完整讲解**，'
              + '交付物必须是图文文档：现在就调用 cf_doc 生成（≥2 张真图解；**表格不算图**），'
              + '正文只保留 1–2 句引子（不要把文档内容再复述一遍）。',
            tools,
            signal: ctrl.signal,
            maxTokens: (cfg.maxOutputTokens > 0) ? cfg.maxOutputTokens : 0,
            maxSteps: 6,
            ...runTurnHooks
          });
        }

        /**
         * **验证不可用 / 正文太薄时的交付兜底**（无运行时机器上的真实事故）。
         *
         * 场景：朋友的电脑没有 g++ —— 验证链按 cpp 编译失败 → NO-BRULER，模型反复重跑，
         * 步数用尽时只吐了一坨上游标记（见 lib/agentloop.js 的泄漏说明），最后**什么都没交付**：
         * 用户看到的是"没报告"。这里补一轮"必须给出正文"的提醒：
         * 有验证结论就把结论讲清楚，没有就按诚实降级交付（首句说明未验证）——
         * 但**绝不能什么都不说**。只补一次（honestTried），避免死循环。
         */
        const verifyBad = !!(turnVerification && turnVerification.status && turnVerification.status !== 'ok');
        // 正文太薄的判据刻意保守：只有在"这一轮真的调过工具"时才补（避免"谢谢"这类短消息被多花一轮钱）
        const thinBody = String(streamState.content || '').trim().length < 80 && runToolChips.length > 0;
        const truncated = !!(result && result.truncatedSteps);
        if (!honestTried && !ctrl.signal.aborted && !askedForHint
            && !(assistantTarget && assistantTarget.richDoc)
            && (verifyBad || truncated || thinBody)) {
          honestTried = true;
          console.log('[coach] 验证不可用或正文太薄 → 补一轮"如实交付"提醒'
            + '（verify=' + (turnVerification && turnVerification.status) + ' truncated=' + truncated + ' thin=' + thinBody + '）');
          const before = streamState.content;
          result = await agentloop.runTurn({
            provider, model,
            system: buildCoachSystem({ conv, profile, userInfo, runtimes: rt, lang, intent: conv.intent }),
            history: history.concat(before ? [{ role: 'assistant', content: before }] : []),
            userText: '【系统提醒·接着上一段继续】这一轮你必须给出**给用户的正文**，不允许只调工具或输出任何内部标记。'
              + (verifyBad ? '本机验证没能通过（' + turnVerification.status + '）或不可用：请在开头用一句如实说明'
                + '（例如"本机没有 g++，这道题没能用程序验证"），然后仍然把思路、正确性论证与复杂度讲清楚，'
                + '该出的图解/文档照常出。' : '把已经拿到的结论讲清楚，别把中间过程堆给用户。'),
            tools,
            signal: ctrl.signal,
            maxTokens: (cfg.maxOutputTokens > 0) ? cfg.maxOutputTokens : 0,
            maxSteps: 6,
            ...runTurnHooks
          });
        }

        if (result && result.text) streamState.content = result.text;
        content = streamState.content;
        reasoning = streamState.reasoning;
        runUsage = Object.assign({}, usageBook, {
          steps: (result && result.steps) || 0,
          cost: estimateCost(cfg, provider.id, model, {
            promptTokens: usageBook.promptTokens, completionTokens: usageBook.completionTokens
          })
        });
        if (runUsage.calls) {
          console.log('[usage] 本轮 ' + runUsage.calls + ' 次调用（工具循环 + 验证链）· 输入 '
            + runUsage.promptTokens + ' / 输出 ' + runUsage.completionTokens + ' tokens'
            + '｜按角色：' + Object.keys(runUsage.byRole).join(',')
            + (runUsage.cost ? ' · 约 ¥' + runUsage.cost.amount.toFixed(4) : ''));
        }
        if (result && result.toolsUsed && result.toolsUsed.length) {
          console.log('[coach] 本轮工具：' + result.toolsUsed.join(' → '));
        }
        const convIntent = normalizeIntent(conv.intent);
        // auto：模型没读技能（纯追问）时按"完整讲解"记账，它确实是这个会话的主线任务
        const effectiveIntent = convIntent === 'auto' ? (autoIntent || 'full') : convIntent;
        if (convIntent === 'auto') console.log('[coach] 意图自动判定 → ' + intentLabel(effectiveIntent));
        postRun = {
          intent: effectiveIntent,
          userCode: '',
          userText: userTextFull,
          minimalCase: null,
          verification: turnVerification
        };
        // 验证状态挂到消息上 + 未通过时发一条**用户可见**的提醒（诚实降级必须看得见）
        if (turnVerification) {
          if (assistantTarget) assistantTarget.verification = turnVerification;
          if (turnVerification.status && turnVerification.status !== 'ok') {
            send('notice', { level: 'warn',
              message: '本轮验证未通过（' + turnVerification.status + '）：讲解已按"诚实降级"输出，请注意代码未经验证。' });
          }
        }
        if (ctrl.signal.aborted) { finalizeAborted(); return; }
        if (!String(content || '').trim()) {
          content = '**这一轮没有产出正文。**\n\n'
            + '- 本轮工具调用：' + ((result && result.toolsUsed && result.toolsUsed.join(' → ')) || '（无）') + '\n'
            + '- 右侧「决策轨迹」有每一步的真实记录。可以再发一次，或把问题问得更具体一点。';
        }
      } else if (false) {
        // ===== 旧的多 Agent 流水线（保留在文件里以便对照与回滚；已由上面的工具循环取代）=====
        // 说明：这段代码永远不会执行（`else if (false)`），保留原因是它对拍的诚实性保证
        // （标尺隔离 / 只重写有罪的一方 / 反例不得来自失信标尺）是 `verifyOnly` 路径的直接来源，
        // 想对照旧行为时可以直接读它。
        const rtFlags = await getRuntimes();
        const rt = runtimesText(rtFlags);
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
        // 题面**多级回退**（顺序不能换）：
        //   ① 本轮取到的（CF 抓取 / 网络缓存）
        //   ② 会话里**持久化**过的题面（上一轮取到或整理好的）—— 这是"追问不丢题面"的关键
        //   ③ 才轮到把当前这条用户消息当题面（最后的兜底）
        // 旧版缺了第 ② 步，于是粘贴题在第二轮开始就把用户提问当题面用了。
        if (!statement && (conv.statementText || '').trim()) statement = conv.statementText;
        if (!statement) statement = harness.cleanUserStatement(userTextFull);
        if (statement) conv.statementText = statement;

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
              // **整理结果必须落盘**：旧版只存了 statementNormalized 这个标志位，
              // 整理出来的标准题面留在局部变量里，下一轮追问就再也拿不回来 → 模型只能看见用户那句提问
              // （实测事故：第二轮"题面"= 用户提问 30 字，契约抽出"输入 30 字 / 输出 0 字"）。
              conv.statementText = statement;
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
        // 旧的固定流水线分支（`else if (false)`）里不再定义 agentCall ——
        // 调用桥已提升到模块级的 makeAgentCall，供工具循环与 cf_verify 共用。

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

/* ---------------- 诊断包 ---------------- */

/**
 * 诊断包的采集参数：所有目录/版本号都取自服务进程自己知道的事实，
 * 不额外问主进程要东西（这样 server.js 在纯 node 下也能跑这条路由）。
 */
function diagStateText() {
  const counts = {};
  try { counts.conversations = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json')).length; } catch { /* ignore */ }
  try { counts.archive = fs.readdirSync(ARCH_DIR).filter((f) => f.endsWith('.json')).length; } catch { /* ignore */ }
  try { counts.workspace = fs.readdirSync(path.join(DATA_DIR, 'workspace')).length; } catch { /* ignore */ }
  try { counts.cachedProblems = fs.readdirSync(path.join(DATA_DIR, 'cf-problems')).filter((f) => f.endsWith('.json')).length; } catch { /* ignore */ }
  try { counts.editorials = fs.readdirSync(path.join(DATA_DIR, 'cache', 'editorials')).length; } catch { /* ignore */ }
  try { counts.skills = fs.readdirSync(path.join(ROOT, 'skills')).length; } catch { /* ignore */ }
  const cfg = readJSON(CONFIG_FILE, null) || {};
  const providers = (cfg.providers || []).map((pv) => ({
    id: pv.id, name: pv.name, kind: pv.kind, baseUrl: pv.baseUrl,
    models: (pv.models || []).map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name))))
  }));
  return JSON.stringify({
    appVersion: APP_VERSION, dataDir: DATA_DIR, counts,
    defaults: cfg.defaults || cfg.default || null,
    providers
  }, null, 2);
}

function diagOpts() {
  let locale = '—';
  let timeZone = '—';
  try {
    const r = Intl.DateTimeFormat().resolvedOptions();
    locale = r.locale || '—'; timeZone = r.timeZone || '—';
  } catch { /* ignore */ }
  return {
    dataDir: DATA_DIR,
    rootDir: ROOT,
    appVersion: APP_VERSION,
    electronVersion: process.versions.electron || null,
    chromeVersion: process.versions.chrome || null,
    locale, timeZone,
    packed: /app\.asar/.test(String(process.resourcesPath || '')),
    extra: [{ name: '应用状态（会话数 / 缓存台账 / 服务商）', text: diagStateText() }]
  };
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

    /**
     * 清掉某道题（某会话所属工作区）的缓存与验证记录 → 下次问这题会**从零重新对拍**。
     *
     * 为什么单独开这个口子：想测"完整验证链"不该靠"把对话删掉"这种副作用
     * （用户的原话："我删除对话就是为了测试对拍嘛"）。这个按钮的语义一目了然，
     * 也不会顺手把对话记录一起清掉。
     */
    if (method === 'POST' && p === '/api/workspace/purge') {
      const body = await readBody(req);
      const conv = loadConv(body.convId);
      if (!conv) throw new HttpError(404, '会话不存在');
      const key = workspace.keyFor(conv);
      const removed = workspace.removeWorkspace(key);
      sendJSON(res, 200, { ok: true, key, removed });
      return;
    }

    /* ---- 算法教练：Codeforces / 运行环境 ---- */
    if (method === 'GET' && p === '/api/cf/problem') {      try {
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
        // 总表里查不到这道题 → 如实说 notFound，不要回一个"看起来像题目"的占位标题
        // （真实事故：界面把占位标题当成"题目已登记"，用户以为题抓到了、其实是空的）
        sendJSON(res, 200, {
          contestId: parseInt(contestId, 10) || contestId,
          index: String(index || '').toUpperCase(),
          title: meta && meta.name ? (String(index).toUpperCase() + '. ' + meta.name) : ('CF ' + contestId + String(index || '').toUpperCase()),
          rating: meta ? (meta.rating || null) : null,
          tags: meta ? (meta.tags || []) : [],
          statement: '',
          samples: [],
          metaOnly: true,
          notFound: !meta
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

    /* ---- 赛后复盘：提交记录（官方 API，不受反爬影响） ---- */
    if (method === 'GET' && p === '/api/review') {
      try {
        const cfg0 = loadConfig();
        const handle = String(url.searchParams.get('handle') || cfg0.cfHandle || '').trim();
        if (!handle) throw new Error('请先在设置里填写 Codeforces 用户名，或在请求里带上 handle');
        const contestId = url.searchParams.get('contestId') || '';
        const { list } = await cfreview.fetchSubmissions({ handle, contestId: contestId || undefined });
        const contests = cfreview.groupByContest(list);
        let info = null;
        if (contestId) { try { info = await cfreview.contestInfo(contestId); } catch (e) { /* 名称取不到不影响 */ } }
        // 默认把最近一场"有提交的比赛"作为复盘对象（数据里 list 是新→旧，聚合后按结束时间排序）
        const target = contests[0] || null;
        sendJSON(res, 200, {
          handle,
          totalSubmissions: list.length,
          contests: contests.slice(0, 12).map((c) => ({
            contestId: c.contestId, submissions: c.submissions, problems: c.problems, solved: c.solved,
            startAt: c.startAt, endAt: c.endAt, spanMs: c.spanMs,
            penaltyApprox: c.penaltyApprox, failedSubmissions: c.failedSubmissions,
            failed: c.failed
          })),
          current: target,
          contestInfo: info
        });
      } catch (e) {
        sendJSON(res, 400, { error: friendlyError(e) });
      }
      return;
    }

    /* ---- 赛后复盘：开一个"已装好复盘材料"的教练会话（SSE 流式报进度） ----
     *
     * 为什么改成 SSE：装材料要逐题抓题解 + 源码，每项都可能要过一次 Cloudflare 挑战，
     * 11 道题串行就是好几分钟。早先做成一次性 POST，界面只有一行"正在装材料"，
     * 用户实测**等了十分钟不知道卡在哪**（真实反馈）。
     * 现在每完成一题就推一条进度，并且带**总预算**（默认 200 秒）——
     * 超时不再是"静默卡死"，而是明确告诉你"X 题装好了、Y 题因为超时没装到"。
     */
    if (method === 'POST' && p === '/api/review/session') {
      const body = await readBody(req, 2 * 1024 * 1024);
      const cfg0 = loadConfig();
      const handle = String(body.handle || cfg0.cfHandle || '').trim();
      if (!handle) throw new HttpError(400, '缺少 handle');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const send = (type, data) => {
        try { res.write('data: ' + JSON.stringify(Object.assign({ type }, data || {})) + '\n\n'); } catch (e) { /* 客户端走了 */ }
      };
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 15000);
      const stopAll = new AbortController();
      req.on('close', () => { try { stopAll.abort(); } catch (e) { /* ignore */ } });
      const deadline = Date.now() + (Number(body.budgetMs) || 200000);

      try {
        const wantSet = Array.isArray(body.problems) && body.problems.length
          ? new Set(body.problems.map((x) => String(x).toUpperCase()))
          : null;   // null = 全量

        send('stage', { step: 'records', message: '正在拉取提交记录（官方 API）…' });
        const { list } = await cfreview.fetchSubmissions({ handle, contestId: body.contestId });
        const contests = cfreview.groupByContest(list);
        if (!contests.length) { send('error', { message: '这场比赛没有提交记录' }); clearInterval(hb); res.end(); return; }
        const c = contests[0];
        let info = null;
        try { info = await cfreview.contestInfo(c.contestId); } catch (e) { /* 名称取不到不影响 */ }

        const picked = wantSet ? c.problemList.filter((x) => wantSet.has(x.index)) : c.problemList;
        if (!picked.length) { send('error', { message: '选中的题目在这场里没有提交记录' }); clearInterval(hb); res.end(); return; }

        send('start', {
          contestId: c.contestId, contestName: info ? info.name : null,
          total: picked.length, problems: picked.map((x) => x.index),
          stats: {
            submissions: c.submissions, problems: c.problems, solved: c.solved,
            spanMs: c.spanMs, penaltyApprox: c.penaltyApprox, failedSubmissions: c.failedSubmissions
          }
        });

        const probLines = [];
        const fetchSrc = body.includeSource !== false;
        const entryIdInput = String(body.entryId || '').trim();
        let oks = 0; let fails = 0;
        // 源码装载总计（给界面显示"材料里有多少份真实代码"）
        let srcGotAll = 0; let srcWantAll = 0;
        for (let i = 0; i < picked.length; i++) {
          const x = picked[i];
          const overBudget = Date.now() > deadline || stopAll.signal.aborted;
          send('item', { index: x.index, i: i + 1, total: picked.length, state: 'working', message: '抓题解与源码…' });

          const seq = x.verdicts.slice().reverse().map((v) => cfreview.verdictCn(v)).join(' → ');
          probLines.push('### ' + x.index + '（' + (x.rating || '未定级') + (x.problemName ? '，' + x.problemName : '') + '）');
          probLines.push('- 结果：' + (x.solved ? 'AC' : cfreview.verdictCn(x.lastVerdict))
            + '｜提交 ' + x.attempts + ' 次｜判定序列 ' + seq
            + '｜最后一发用时 ' + (x.lastTimeMs != null ? x.lastTimeMs + 'ms' : '—')
            + '｜提交 id ' + x.lastSubmissionId);
          if (x.tags && x.tags.length) probLines.push('- 标签：' + x.tags.join('、'));

          let ed = null;
          let edNote = '';
          if (overBudget) {
            edNote = '超时未抓';
            ed = { ok: false, hint: '装材料总预算已用完（' + Math.round((Number(body.budgetMs) || 200000) / 1000) + ' 秒），本题没来得及抓题解。' };
          } else {
            try {
              ed = await cfreview.fetchEditorial({
                contestId: c.contestId, index: x.index,
                // 用户给了题解链接就直接用它（能省掉"翻题目页找 Tutorial"那一步，
                // 而这一步要过一次反爬挑战，是整条链里最慢也最容易失败的一环）
                entryId: entryIdInput || undefined,
                budgetMs: 35000,
                browserFetch: editorialBrowserFetch
              });
            } catch (e) { ed = { ok: false, hint: (e && e.message) || '抓取失败' }; }
          }
          if (ed && ed.ok && ed.content) {
            oks++;
            probLines.push('- 官方题解（来自 CF ' + (ed.entryId ? 'blog/entry/' + ed.entryId : '题解页')
              + (ed.sliced ? '' : '，⚠ 未精确切出本题，以下是整篇') + '）——**已经在这里了，不用再去取**：');
            probLines.push('```');
            probLines.push(ed.content.slice(0, 6000));
            probLines.push('```');
          } else {
            fails++;
            probLines.push('- 官方题解：**没有找到**（' + ((ed && ed.hint) || 'CF 上这道题没有公开题解') + '）');
            // 只有**确实没抓到题解**时才要求教练自己解题 + 对拍验证（验证需要官方样例，所以先取题面）。
            // 反之绝不能加这句 —— 材料里已经有题解却还叫它去 cf_fetch/cf_verify，
            // 就是用户吐槽的"我把信息都给它了，它还要自己去取一遍"。
            probLines.push('- **本题要你自己的解法**（这条只对本题有效，因为题解没抓到）：先 `cf_fetch` 取题面与官方样例（CF ' + c.contestId + x.index
              + '），再用 `cf_verify` 跑验证，最后才讲。不要凭选手源码猜正解。');
          }
          // 本题源码装载计数（给界面的进度事件用）
          let srcGot = 0;
          let srcWant = 0;
          if (fetchSrc && x.lastSubmissionId && !overBudget) {
            /**
             * 逐条装源码：**不只最后一发**。
             * 一题往往交错着 WA/TLE/AC，只看最后一发就看不到"错在哪 → 怎么改对的"这个过程，
             * 而那正是复盘最值钱的地方（用户明确提过这一点）。
             * 每题最多装 3 份（首次提交 / 最后一次未通过 / 首次通过），按 sourcePicks 的顺序取。
             */
            const picks = (Array.isArray(x.sourcePicks) && x.sourcePicks.length)
              ? x.sourcePicks.slice(0, 3)
              : [{ id: x.lastSubmissionId, role: '最后一发', verdict: x.lastVerdict, lang: '', timeMs: x.lastTimeMs }];
            const got = [];
            const missed = [];
            srcWant = picks.length;
            for (const pk of picks) {
              if (Date.now() > deadline) { missed.push(pk.role + '（超时未抓）'); continue; }
              try {
                const s = await cfreview.fetchSource({
                  contestId: c.contestId, submissionId: pk.id, browserFetch: submissionBrowserFetch
                });
                if (s && s.ok) got.push({ pick: pk, src: s });
                else missed.push(pk.role + '（' + ((s && (s.hint || s.reason)) || '未知原因') + '）');
              } catch (e) {
                missed.push(pk.role + '（' + ((e && e.message) || '抓取失败') + '）');
              }
            }
            if (got.length) {
              srcGot = got.length;
              srcGotAll += got.length; srcWantAll += srcWant;
              for (const g of got) {
                probLines.push('- 选手源码 · **' + g.pick.role + '**（提交 ' + g.pick.id + '，'
                  + cfreview.verdictCn(g.pick.verdict) + '，' + (g.src.lang || g.pick.lang || '') + '）'
                  + '——**已经在这里了，不用再去 cf_source**：');
                probLines.push('```' + (g.src.lang || ''));
                probLines.push(String(g.src.code).slice(0, 6000));
                probLines.push('```');
              }
              if (missed.length) probLines.push('- （另外没取到：' + missed.join('；') + '）');
            } else {
              srcGotAll += 0; srcWantAll += srcWant;
              const first = missed[0] || '未知原因';
              probLines.push('- 选手源码：**没取到**（' + first + '）');
              if (/not-found|重定向|未登录/.test(first)) {
                probLines.push('  - 原因通常是**应用内浏览器没有登录 Codeforces**（源码页要求登录），'
                  + '或该提交对当前账号不可见。让用户点复盘页的「🔑 登录 Codeforces」登一次；'
                  + '也可以直接把代码粘给你（粘贴永远可行）。**不要反复重试 cf_source**。');
              }
              probLines.push('  ——**不要猜实现细节**');
            }
          } else if (fetchSrc && overBudget) {
            probLines.push('- 选手源码：超时未抓');
          }
          probLines.push('');
          // 每完成一题就推一条进度：界面上能看到"第 i/N 题装好了"，而不是干等
          // 注意区分"这道题真没有题解"与"抓取超时"——前者重试也没用，后者值得再试一次
          const edFailReason = (ed && ed.reason) || '';
          send('item', {
            index: x.index, i: i + 1, total: picked.length, state: 'done',
            editorial: (ed && ed.ok) ? 'ok' : (edFailReason || 'none'),
            source: (fetchSrc && x.lastSubmissionId && !overBudget) ? 'tried' : (overBudget ? 'skipped' : 'off'),
            // 源码装了几发 / 一共想装几发：界面要能直接看到"材料里到底有没有代码"，
            // 否则用户只能凭"没取到"四个字猜（真实反馈：材料里只有题解，看不到源码）。
            srcGot: srcGot, srcWant: srcWant,
            message: (ed && ed.ok) ? ('题解已装好' + (srcWant ? '｜源码 ' + srcGot + '/' + srcWant + ' 发' : ''))
              : (edFailReason === 'no-tutorial-link'
                ? 'CF 上没有这道题的题解（不是每场都有）→ 让 AI 自己解并验证'
                : (edFailReason === 'timeout'
                  ? '题解抓取超时（反爬挑战没过）→ 这次当"没有题解"处理，之后可以单独重试'
                  : '没拿到题解 → 让 AI 自己解并验证'))
          });
        }
        if (stopAll.signal.aborted) { console.log('[review] 客户端中断了装材料'); clearInterval(hb); try { res.end(); } catch (e) { /* ignore */ } return; }

      const statementText = [
        '【赛后复盘材料】由 CF Coach 自动装好，请按 cf-review 技能处理。',
        '',
        '**材料已经装在下面了（逐题统计 / 官方题解 / 选手源码），不要再去取一遍。**',
        '只有材料里明确写着"没有找到 / 没取到"的东西才需要你处理；用户明确要求时才可以动工具。',
        '',
        '- 选手：' + handle,
        '- 比赛：' + c.contestId + (info && info.name ? '「' + info.name + '」' : '')
          + (info ? '（' + (info.finished ? '已结束' : '**进行中**，源码在比赛中是隐藏的') + '）' : ''),
        '- 统计：提交 ' + c.submissions + ' 条｜涉及 ' + c.problems + ' 题｜AC ' + c.solved + ' 题'
          + '｜本场跨度 ' + Math.round((c.spanMs || 0) / 60000) + ' 分钟'
          + '｜罚时（只计 AC 题的失败提交×50）' + c.penaltyApprox
          + '｜未 AC 白交 ' + c.failedSubmissions + ' 发',
        '- 本次复盘范围：' + (wantSet ? '仅 ' + picked.map((x) => x.index).join('、') : '全部有提交的题目'),
        '',
        ...probLines
      ].join('\n');

      const conv = newConversation({
        title: '复盘 ' + c.contestId + (info && info.name ? ' ' + info.name : ''),
        cfProblem: null,
        statementText,
        problemMeta: {
          source: 'review', contest: String(c.contestId),
          title: 'CF ' + c.contestId + ' 赛后复盘', rating: null, tags: [], knowledge: []
        }
      });
      conv.messages.push({
        id: uid('m_'),
        role: 'user',
        content: '复盘 ' + c.contestId + '：' + (wantSet ? '只看 ' + picked.map((x) => x.index).join('、') : '全部题目')
          + '。先给全局分布，再逐题诊断，最后给下场比赛的行动项。',
        createdAt: Date.now()
      });
      saveConv(conv);
      send('done', {
        ok: true, conversationId: conv.id, title: conv.title,
        problems: picked.map((x) => x.index),
        editorialOk: oks, editorialNone: fails,
        sourceGot: srcGotAll, sourceWant: srcWantAll,
        degraded: fails > 0 ? '有 ' + fails + ' 题没抓到官方题解，教练会对这些题自己解题并跑验证（会慢一些）' : ''
      });
      clearInterval(hb);
      try { res.end(); } catch (e) { /* ignore */ }
      return;
    } catch (e) {
      console.error('[review] 装材料失败: ' + ((e && e.message) || e));
      send('error', { message: friendlyError(e) });
      clearInterval(hb);
      try { res.end(); } catch (e2) { /* ignore */ }
      return;
    }
  }

    /* ---- 赛后复盘：登录 Codeforces（抓提交源码必需） ---- */
    if (method === 'POST' && p === '/api/review/login') {
      const body = await readBody(req, 16 * 1024);
      if (!cfLoginOpener) {
        sendJSON(res, 200, { ok: false, error: '登录窗口只在桌面版可用（Web 模式下没有内嵌浏览器）。' });
        return;
      }
      try {
        const r = await cfLoginOpener({ waitMs: Number(body.waitMs) || 180000 });
        sendJSON(res, 200, r);
      } catch (e) {
        sendJSON(res, 200, { ok: false, error: friendlyError(e) });
      }
      return;
    }

    /* ---- 赛后复盘：反爬挑战的人工兜底（打开可见窗口过一次挑战） ---- */
    if (method === 'POST' && p === '/api/review/challenge') {
      const body = await readBody(req, 64 * 1024);
      const contestId = String(body.contestId || '').trim();
      const index = String(body.index || '').trim().toUpperCase();
      const entryId = String(body.entryId || '').trim();
      let target = String(body.url || '').trim();
      if (!target) {
        if (entryId) target = 'https://codeforces.com/blog/entry/' + entryId;
        else if (/^\d+$/.test(contestId) && /^[A-Z]\d?$/.test(index)) target = 'https://codeforces.com/contest/' + contestId + '/problem/' + index;
      }
      if (!challengeWindowOpener) {
        sendJSON(res, 200, { ok: false, error: '人工兜底只在桌面版可用（Web 模式下没有内嵌浏览器）。' });
        return;
      }
      try {
        const r = await challengeWindowOpener({ url: target, waitMs: Number(body.waitMs) || 45000 });
        sendJSON(res, 200, r);
      } catch (e) {
        sendJSON(res, 200, { ok: false, error: friendlyError(e) });
      }
      return;
    }

    /* ---- 赛后复盘：会话预热（复盘页一打开就调用，把"冷启动第一枪"提前花掉） ---- */
    if (method === 'POST' && p === '/api/review/warm') {
      if (!cfWarmOpener) { sendJSON(res, 200, { ok: false, reason: '只在桌面版可用' }); return; }
      try {
        const t0 = Date.now();
        const r = await cfWarmOpener();
        sendJSON(res, 200, { ok: true, ms: Date.now() - t0, loggedIn: !!(r && r.loggedIn) });
      } catch (e) {
        sendJSON(res, 200, { ok: false, reason: friendlyError(e) });
      }
      return;
    }

    /* ---- 赛后复盘：官方题解（尽力而为，不是每道题都有） ---- */
    if (method === 'GET' && p === '/api/review/editorial') {
      const contestId = url.searchParams.get('contestId') || '';
      const index = url.searchParams.get('index') || '';
      const entryId = url.searchParams.get('entryId') || '';
      try {
        const r = await cfreview.fetchEditorial({
          contestId, index, entryId,
          force: url.searchParams.get('force') === '1',
          browserFetch: editorialBrowserFetch
        });
        sendJSON(res, 200, r);
      } catch (e) {
        sendJSON(res, 200, { ok: false, reason: 'error', hint: friendlyError(e) });
      }
      return;
    }

    /* ---- 赛后复盘：单条提交源码（走内嵌浏览器通道） ---- */
    if (method === 'GET' && p === '/api/review/source') {
      const contestId = url.searchParams.get('contestId') || '';
      const submissionId = url.searchParams.get('submissionId') || '';
      try {
        const r = await cfreview.fetchSource({ contestId, submissionId, browserFetch: submissionBrowserFetch });
        sendJSON(res, 200, r);
      } catch (e) {
        sendJSON(res, 200, { ok: false, reason: 'error', hint: friendlyError(e) });
      }
      return;
    }

    /* ---- 赛后复盘：诊断材料（打包给 AI 的那份） ---- */
    if (method === 'GET' && p === '/api/review/bundle') {
      try {
        const cfg0 = loadConfig();
        const handle = String(url.searchParams.get('handle') || cfg0.cfHandle || '').trim();
        const contestId = url.searchParams.get('contestId') || '';
        if (!handle) throw new Error('缺少 handle');
        const r = await cfreview.reviewBundle({
          handle, contestId: contestId || undefined,
          includeEditorial: url.searchParams.get('editorial') !== '0',
          editorialFetch: (q) => cfreview.fetchEditorial(Object.assign({ browserFetch: editorialBrowserFetch }, q)),
          // 源码也一起装（用户反馈：只装题解等于把最关键的证据漏掉了）
          includeSource: url.searchParams.get('source') !== '0',
          sourceFetch: submissionBrowserFetch
            ? (q) => cfreview.fetchSource(Object.assign({ browserFetch: submissionBrowserFetch }, q))
            : null,
          sourceBudgetMs: Number(url.searchParams.get('sourceBudgetMs')) || 100000
        });
        sendJSON(res, 200, r);
      } catch (e) {
        sendJSON(res, 400, { error: friendlyError(e) });
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
    /* ---- 对话文件夹（分类整理用；不影响会话内容） ---- */
    if (p === '/api/folders') {
      if (method === 'GET') { sendJSON(res, 200, { folders: loadFolders() }); return; }
      if (method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) throw new HttpError(400, '缺少 name');
        const list = loadFolders();
        if (list.some((f) => f.name === name)) throw new HttpError(400, '已经有同名文件夹了');
        const f = newFolder(name);
        list.push(f);
        saveFolders(list);
        sendJSON(res, 200, { ok: true, folder: f, folders: list });
        return;
      }
    }
    {
      const mf = p.match(/^\/api\/folders\/([a-zA-Z0-9_\-]+)$/);
      if (mf) {
        const id = mf[1];
        const list = loadFolders();
        const idx = list.findIndex((f) => f.id === id);
        if (idx < 0) throw new HttpError(404, '文件夹不存在');
        if (method === 'PATCH') {
          const body = await readBody(req);
          const name = String(body.name || '').trim();
          if (!name) throw new HttpError(400, '缺少 name');
          if (list.some((f, i) => i !== idx && f.name === name)) throw new HttpError(400, '已经有同名文件夹了');
          list[idx].name = name.slice(0, 40);
          saveFolders(list);
          sendJSON(res, 200, { ok: true, folder: list[idx], folders: list });
          return;
        }
        if (method === 'DELETE') {
          // 删文件夹**不删对话**：里面的对话回到"未分类"（用户删的是分类，不是内容）
          list.splice(idx, 1);
          saveFolders(list);
          let moved = 0;
          for (const c of eachConversation()) {
            if (c.folder === id) { c.folder = ''; saveConv(c); moved++; }
          }
          sendJSON(res, 200, { ok: true, moved, folders: list });
          return;
        }
      }
    }
    /* ---- 批量操作：多选对话后一次性归档 / 删除 / 移动 ---- */
    if (method === 'POST' && p === '/api/conversations/batch') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const action = String(body.action || '');
      if (!ids.length) throw new HttpError(400, '没有选中任何对话');
      const ok0 = ['archive', 'unarchive', 'delete', 'move', 'pin', 'unpin'];
      if (ok0.indexOf(action) < 0) throw new HttpError(400, '不支持的批量操作：' + action);
      const folder = String(body.folder || '');
      if (action === 'move' && folder && !loadFolders().some((f) => f.id === folder)) {
        throw new HttpError(400, '目标文件夹不存在');
      }
      const done = []; const failed = [];
      for (const id of ids) {
        try {
          const conv = loadConv(id);
          if (!conv) { failed.push({ id, reason: '会话不存在' }); continue; }
          if (action === 'delete') {
            // 正在生成的会话先停掉再删，否则那次生成会在收尾时把文件又写回来
            const stop = runStops.get(id);
            if (stop) { try { stop(); } catch (e) { /* ignore */ } }
            deleteConvFile(id);
          } else if (action === 'archive' || action === 'unarchive') {
            conv.archived = action === 'archive';
            conv.updatedAt = Date.now();
            saveConv(conv);
          } else if (action === 'pin' || action === 'unpin') {
            conv.pinned = action === 'pin';
            saveConv(conv);
          } else if (action === 'move') {
            conv.folder = folder;
            saveConv(conv);
          }
          done.push(id);
        } catch (e) { failed.push({ id, reason: friendlyError(e) }); }
      }
      sendJSON(res, 200, { ok: true, action, done: done.length, ids: done, failed });
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
          const fixedStream = repairStaleStreaming(conv);
          // 自愈：历史里被写进正文的上游工具调用标记也在这里清掉（只读打开一次就修好，落盘一次）
          const fixedLeak = repairLeakedMarkup(conv);
          if (fixedStream || fixedLeak) saveConv(conv);
          conv.active = activeGenerations.has(id);   // 是否正在后台生成（前端据此轮询/显示"生成中"）
          sendJSON(res, 200, conv);
          return;
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const conv = loadConv(id);
          if (!conv) throw new HttpError(404, '会话不存在');
          const allowed = ['title', 'pinned', 'archived', 'providerId', 'model', 'systemPrompt', 'params', 'mode', 'cfProblem', 'lang', 'intent', 'problemMeta', 'rich', 'folder'];
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
          /**
           * 删除会话：默认**同时删掉这道题的工作区缓存**（用户的原话："我删除肯定是全删啊"）。
           *
           * 但工作区是按**题号**共享的（cf-2269D），别的问过同一题的对话还在用它 ——
           * 所以先数一下还有几个会话指向同一个工作区：
           *   · 没有别的会话用 → 直接连缓存一起删（真正的"全删"）；
           *   · 还有别的会话用 → 默认**保留**缓存，并在响应里如实说明；要连缓存也删就带 forceWorkspace。
           * 前端据此在删除确认框里给出选择，不再让用户猜"删了没有"。
           */
          const conv = loadConv(id);
          const key = conv ? workspace.keyFor(conv) : '';
          const body = method === 'DELETE' ? await readBody(req).catch(() => ({})) : {};
          const forceWs = !!(body && body.forceWorkspace);
          let sharedWith = [];
          if (key) {
            sharedWith = eachConversation().filter((c) => c.id !== id && workspace.keyFor(c) === key).map((c) => c.id);
          }
          deleteConvFile(id);
          let workspaceCleared = false;
          let workspaceKept = '';
          if (key && (forceWs || !sharedWith.length)) {
            try {
              workspace.removeWorkspace(key);
              workspaceCleared = true;
            } catch (e) { console.log('[workspace] 删除失败: ' + ((e && e.message) || e)); }
          } else if (key) {
            workspaceKept = key;
          }
          sendJSON(res, 200, { ok: true, workspace: key, workspaceCleared, workspaceKept, sharedWith });
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

    /* ---- 诊断包（把"出问题那一刻"的证据打成一个纯文本文件） ---- */
    if (method === 'GET' && p === '/api/diag/export') {
      const b = diagbundle.collect(diagOpts());
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + diagbundle.defaultFileName() + '"'
      });
      res.end(b.text);
      return;
    }
    if (method === 'POST' && p === '/api/diag/save') {
      const r = diagbundle.write(diagOpts());
      sendJSON(res, 200, { ok: true, file: r.file, bytes: r.bytes, sections: r.sections.map((s) => s.name), warnings: r.warnings });
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
      const payload = { app: 'codeforces-coach', version: 1, exportedAt: new Date().toISOString(), conversations: all };
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

module.exports = { startServer, DATA_DIR, setSubmissionBrowserFetch, setEditorialBrowserFetch, setChallengeWindowOpener, setCfLoginOpener, setCfWarmOpener };
