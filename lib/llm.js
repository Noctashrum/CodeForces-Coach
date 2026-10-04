/**
 * llm.js — 上游模型调用的**传输层**（零依赖）。
 *
 * 为什么单独抽出来：教练现在有两种调用形态——
 *   ① 单发调用（`callAgentLLM`）：一次请求一次回答，用于辅助 agent（写暴力解 / 抽契约 / 路由判断）；
 *   ② 工具循环（`agentloop.js`）：多轮请求，模型可以在中间调工具。
 * 两者的 HTTP/SSE/错误重试逻辑是同一份，混在 server.js 里会让工具循环没法独立测试。
 *
 * 本模块只做"把请求发出去、把流解析成结构化结果"这一件事：
 *   - OpenAI 兼容（含 DeepSeek）与 Anthropic 两种协议；
 *   - 流式 SSE 与非流式 JSON 两种返回；
 *   - **工具调用（function calling）**：把增量分片的 tool_calls 累积成完整调用；
 *   - 上游不认识某个可选字段时的降级重试（max_tokens / stream_options / tools）。
 * 它不关心题面、不关心提示词、不关心会话——那些属于上层。
 */

'use strict';

/** 上游返回的助手消息（OpenAI 消息形状；Anthropic 响应会被归一化成这个形状） */
function emptyMessage() {
  return { role: 'assistant', content: '', reasoning: '', toolCalls: [], finishReason: '' };
}

/**
 * 把增量到达的 tool_calls 分片累积成完整调用。
 * 协议事实：首片带 `index` + `id` + `function.name`，后续片只带 `index` + `function.arguments` 的片段。
 * 也有服务商一次给全（非流式或不分片），所以两条路都要接。
 */
function accumulateToolCalls(acc, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const d of deltas) {
    if (!d) continue;
    const idx = Number.isInteger(d.index) ? d.index : acc.length;
    while (acc.length <= idx) acc.push({ id: '', name: '', args: '' });
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    const fn = d.function || d;
    if (fn && fn.name) slot.name = fn.name;
    if (fn && typeof fn.arguments === 'string') slot.args += fn.arguments;
    else if (fn && fn.arguments && typeof fn.arguments === 'object') slot.args += JSON.stringify(fn.arguments);
  }
}

/** 解析一份"完整助手消息"里的 tool_calls（非流式通道） */
function readToolCalls(message) {
  const out = [];
  const list = (message && message.tool_calls) || [];
  for (const tc of list) {
    if (!tc) continue;
    const fn = tc.function || {};
    out.push({
      id: String(tc.id || ''),
      name: String(fn.name || ''),
      args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
    });
  }
  return out;
}

/* ---------------- Anthropic ↔ OpenAI 消息归一化 ---------------- */

/**
 * 把内部（OpenAI 形状）的消息转成 Anthropic v1/messages 的 messages 数组。
 * 关键差异：Anthropic 的 tool_result 必须放在 **user** 消息的 content 块里，
 * 而且角色必须严格交替——所以连续的 user 消息要合并。
 */
function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId || '', content: String(m.content || '') }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (String(m.content || '').trim()) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of (m.toolCalls || [])) {
        let input = {};
        try { input = JSON.parse(tc.args || '{}'); } catch { input = { __raw: tc.args }; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      if (blocks.length) push('assistant', blocks);
      continue;
    }
    push('user', [{ type: 'text', text: String(m.content || '') }]);
  }
  return out;
}

/* ---------------- 请求构造 ---------------- */

function joinUrl(base, tail) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + '/' + String(tail || '').replace(/^\/+/, '');
}

/**
 * 构造上游请求。返回 { url, headers, body, anthropic }。
 * @param {object} o provider / model / messages / system / tools / maxTokens / stream
 */
function buildRequest(o) {
  const provider = o.provider || {};
  const extra = provider.extraHeaders || {};
  const stream = o.stream !== false && provider.stream !== false;
  const maxTokens = (o.maxTokens != null && o.maxTokens > 0) ? o.maxTokens : 0;

  if (provider.type === 'anthropic') {
    const body = {
      model: o.model,
      max_tokens: maxTokens > 0 ? maxTokens : 8192,
      stream,
      messages: toAnthropicMessages(o.messages || [])
    };
    if (o.system) body.system = o.system;
    if (o.tools && o.tools.length) body.tools = o.tools.map((t) => ({
      name: t.name, description: t.description, input_schema: t.parameters || { type: 'object', properties: {} }
    }));
    return {
      url: joinUrl(provider.baseUrl, 'v1/messages'),
      headers: Object.assign({
        'content-type': 'application/json',
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01'
      }, extra),
      body,
      anthropic: true
    };
  }

  const messages = [];
  if (o.system) messages.push({ role: 'system', content: o.system });
  for (const m of (o.messages || [])) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'assistant') {
      const mm = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls && m.toolCalls.length) {
        mm.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' }
        }));
        if (!mm.content) mm.content = null;
      }
      if (!String(mm.content || '').trim() && !mm.tool_calls) continue;
      messages.push(mm);
      continue;
    }
    if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId || '', content: String(m.content || '') });
      continue;
    }
    messages.push({ role: 'user', content: m.content });
  }
  const body = Object.assign({ model: o.model, stream, messages },
    maxTokens > 0 ? { max_tokens: maxTokens } : {});
  if (o.tools && o.tools.length) {
    body.tools = o.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } }
    }));
    body.tool_choice = o.toolChoice || 'auto';
  }
  return {
    url: joinUrl(provider.baseUrl, 'chat/completions'),
    headers: Object.assign({
      'content-type': 'application/json',
      authorization: 'Bearer ' + (provider.apiKey || '')
    }, extra),
    body,
    anthropic: false
  };
}

/* ---------------- SSE 解析 ---------------- */

/**
 * 解析上游响应（SSE 或非流式 JSON），回调事件：
 *   delta {text} · reasoningDelta {text} · usage {…} · finish {reason}
 * @param {Response} res fetch 响应
 * @param {(ev: object) => void} emit 事件回调
 */
async function pumpResponse(res, emit) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    if (!res.ok) throw new Error(await errorText(res));
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { throw new Error('上游返回了无法解析的内容'); }
    if (j && j.type === 'message') {                       // Anthropic 非流式
      for (const b of (j.content || [])) {
        if (b.type === 'text') emit({ type: 'delta', text: b.text });
        else if (b.type === 'thinking') emit({ type: 'reasoningDelta', text: b.thinking });
        else if (b.type === 'tool_use') emit({ type: 'toolCall', call: { id: b.id, name: b.name, args: JSON.stringify(b.input || {}) } });
      }
      if (j.usage) emit({ type: 'usage', promptTokens: j.usage.input_tokens, completionTokens: j.usage.output_tokens });
      emit({ type: 'finish', reason: j.stop_reason || '' });
      return;
    }
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (msg) {                                             // OpenAI 非流式
      if (msg.content) emit({ type: 'delta', text: msg.content });
      if (msg.reasoning_content) emit({ type: 'reasoningDelta', text: msg.reasoning_content });
      for (const tc of readToolCalls(msg)) emit({ type: 'toolCall', call: tc });
      if (j.usage) emit({ type: 'usage', promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens });
      emit({ type: 'finish', reason: (j.choices[0].finish_reason) || '' });
      return;
    }
    throw new Error('上游返回了无法识别的响应格式');
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pendingEvent = null;
  let finished = false;
  // Anthropic 的 content_block_start 会带完整 tool_use（input 是空对象），参数在后续 input_json_delta 里增量给
  const anthTool = new Map();

  const handleData = (data) => {
    // `[DONE]` 只是"流结束"的哨兵，**不能**用它把真正的 finish_reason 冲掉。
    // 真实事故（e2e 的"被截断且正文为空 → 去掉上限重试"用例抓到的）：OpenAI 兼容服务商
    // 先发 `finish_reason:"length"`，再发 `data: [DONE]`；旧写法在 [DONE] 时又 emit 了一次
    // reason='' 的 finish，于是 acc.finishReason 变成空字符串 → 截断重试的判定永远不成立，
    // 「预算被思考吃光」的场景再也救不回来（而且是静默失效）。
    if (data === '[DONE]') { if (!finished) emit({ type: 'finish', reason: '' }); finished = true; return; }
    let j = null;
    try { j = JSON.parse(data); } catch { return; }
    if (!j) return;

    // ---- Anthropic ----
    if (j.type === 'content_block_start' && j.content_block) {
      const cb = j.content_block;
      if (cb.type === 'tool_use') anthTool.set(j.index, { id: cb.id, name: cb.name, args: '' });
      return;
    }
    if (j.type === 'content_block_delta' && j.delta) {
      const d = j.delta;
      if (d.type === 'text_delta' && d.text) emit({ type: 'delta', text: d.text });
      else if (d.type === 'thinking_delta' && d.thinking) emit({ type: 'reasoningDelta', text: d.thinking });
      else if (d.type === 'input_json_delta') {
        const slot = anthTool.get(j.index);
        if (slot) slot.args += (d.partial_json || '');
      }
      return;
    }
    if (j.type === 'content_block_stop') {
      const slot = anthTool.get(j.index);
      if (slot) { emit({ type: 'toolCall', call: slot }); anthTool.delete(j.index); }
      return;
    }
    if (j.type === 'message_start' && j.message && j.message.usage) {
      emit({ type: 'usage', promptTokens: j.message.usage.input_tokens });
      return;
    }
    if (j.type === 'message_delta') {
      if (j.usage && j.usage.output_tokens != null) emit({ type: 'usage', completionTokens: j.usage.output_tokens });
      if (j.delta && j.delta.stop_reason) { emit({ type: 'finish', reason: j.delta.stop_reason }); finished = true; }
      return;
    }
    if (j.type === 'message_stop') { emit({ type: 'finish', reason: '' }); finished = true; return; }
    if (j.type === 'error') throw new Error((j.error && (j.error.message || j.error.type)) || '上游返回错误');

    // ---- OpenAI 兼容 ----
    if (j.choices && j.choices[0]) {
      const d = j.choices[0].delta || {};
      if (d.content) emit({ type: 'delta', text: d.content });
      if (d.reasoning_content) emit({ type: 'reasoningDelta', text: d.reasoning_content });
      if (d.tool_calls) {
        // 流式分片：累积后由上层合并；这里直接透传分片，上层用 accumulateToolCalls 累积
        emit({ type: 'toolCallDelta', deltas: d.tool_calls });
      }
      if (j.choices[0].finish_reason) { emit({ type: 'finish', reason: j.choices[0].finish_reason }); finished = true; }
    }
    if (j.usage) {
      emit({
        type: 'usage', promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens,
        cacheHitTokens: j.usage.prompt_cache_hit_tokens, cacheMissTokens: j.usage.prompt_cache_miss_tokens
      });
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
        let j = null; try { j = JSON.parse(data); } catch { /* ignore */ }
        throw new Error((j && j.error && (j.error.message || j.error.type)) || '上游返回错误');
      }
      pendingEvent = null;
      handleData(data);
    }
  };

  const readWithTimeout = (ms) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('__STALL__')), ms); });
    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
  };

  while (true) {
    let step;
    try {
      step = await readWithTimeout(finished ? 2500 : 600000);
    } catch (e) {
      if (e.message === '__STALL__') break;   // 上游挂起不关流 → 正常收尾
      throw e;
    }
    if (step.done) break;
    buf += dec.decode(step.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      processLine(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) processLine(buf.trim());
  try { await reader.cancel(); } catch { /* ignore */ }
}

/** 从错误响应里尽量提取可读信息（服务商的报错文本对用户有诊断价值） */
async function errorText(res) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      if (j && j.error) {
        if (typeof j.error === 'string') return j.error;
        if (j.error.message) return j.error.message;
        return JSON.stringify(j.error);
      }
      if (j && j.message) return j.message;
    } catch { /* 非 JSON */ }
    return text.slice(0, 400);
  } catch {
    return 'HTTP ' + res.status;
  }
}

/* ---------------- 主入口 ---------------- */

/**
 * 调用模型一次，返回归一化后的助手消息。
 *
 * 自愈能力（实测必需）：
 *  - 上游不认 `max_tokens` / `stream_options` / `tools` → 去掉该字段重试一次；
 *  - 正文为空且 finish_reason=length（推理模型把预算烧在思考上）→ 去掉 max_tokens 重发一次。
 *
 * @param {object} o - provider / model / messages / system / tools / maxTokens / stream / signal /
 *                     onDelta / onReasoning / onUsage / onToolCall / onMeta / callTimeoutMs / noToolRetry
 * @returns {Promise<{content:string, reasoning:string, toolCalls:{id,name,args}[], finishReason:string, usage:object|null, degraded:string[]}>}
 */
async function callModel(o) {
  const req = buildRequest(o);
  const body = req.body;
  const degraded = [];
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch { /* ignore */ } }, o.callTimeoutMs || 12 * 60 * 1000);
  const onOuterAbort = () => { try { ctrl.abort(); } catch { /* ignore */ } };
  if (o.signal) {
    if (o.signal.aborted) onOuterAbort();
    else o.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const doFetch = () => fetch(req.url, {
    method: 'POST', headers: req.headers, body: JSON.stringify(body), signal: ctrl.signal
  });

  let res;
  try {
    res = await doFetch();
  } catch (e) {
    clearTimeout(timer);
    if (o.signal && o.signal.aborted) throw new Error('已取消');
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new Error('单次模型调用超时（' + Math.round((o.callTimeoutMs || 12 * 60 * 1000) / 60000) + ' 分钟）');
    throw e;
  }

  // 可选字段降级：服务商报"不认识这个字段"就去掉它重试
  if (!res.ok) {
    const detail = await errorText(res).catch(() => '');
    let retry = false;
    if (body.stream_options && /stream_options|include_usage/i.test(detail)) { delete body.stream_options; retry = true; }
    // tool_choice 是容易不被认的字段（有的服务商只认 'auto'/'required'）：先单独去掉它重试，
    // 而不是把整个工具面丢掉 —— 丢掉工具声明正是"上游把工具调用泄漏成正文"的触发条件。
    else if (body.tool_choice && body.tool_choice !== 'auto' && /tool_choice|tool choice/i.test(detail)) {
      delete body.tool_choice; retry = true; degraded.push('tool_choice');
    }
    else if (body.max_tokens && /max_?tokens|max_completion_tokens|too large|exceed/i.test(detail)) { delete body.max_tokens; retry = true; degraded.push('max_tokens'); }
    else if (body.tools && /tool|function|unsupported|not supported|invalid.*param/i.test(detail)) {
      // 上游不支持工具：清空工具面，交给上层的 JSON 协议回退
      degraded.push('tools');
      const unsupported = new Error(detail || ('上游返回 HTTP ' + res.status));
      unsupported.toolsUnsupported = true;
      clearTimeout(timer);
      if (o.signal) { try { o.signal.removeEventListener('abort', onOuterAbort); } catch { /* ignore */ } }
      throw unsupported;
    }
    if (retry) {
      try {
        res = await doFetch();
      } catch (e) {
        clearTimeout(timer);
        if (o.signal && o.signal.aborted) throw new Error('已取消');
        throw e;
      }
    } else {
      clearTimeout(timer);
      if (o.signal) { try { o.signal.removeEventListener('abort', onOuterAbort); } catch { /* ignore */ } }
      const err = new Error(detail || ('上游返回 HTTP ' + res.status));
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
  }

  const acc = emptyMessage();
  let usage = null;
  let sawToolDelta = false;
  const readOnce = async () => {
    await pumpResponse(res, (ev) => {
      if (ev.type === 'delta') {
        acc.content += ev.text;
        if (o.onDelta) o.onDelta(ev.text);
      } else if (ev.type === 'reasoningDelta') {
        acc.reasoning += ev.text;
        if (o.onReasoning) o.onReasoning(ev.text);
      } else if (ev.type === 'usage') {
        usage = Object.assign(usage || {}, ev);
        if (o.onUsage) o.onUsage(ev);
      } else if (ev.type === 'toolCallDelta') {
        sawToolDelta = true;
        accumulateToolCalls(acc.toolCalls, ev.deltas);
      } else if (ev.type === 'toolCall') {
        acc.toolCalls.push({ id: ev.call.id, name: ev.call.name, args: ev.call.args || '{}' });
        if (o.onToolCall) o.onToolCall(ev.call);
      } else if (ev.type === 'finish') {
        // 只认**第一个**有内容的结束原因：有的服务商先给 finish_reason，末尾再来一个空 reason 的收尾事件
        if (ev.reason || !acc.finishReason) acc.finishReason = String(ev.reason || '');
      }
    });
  };

  try {
    await readOnce();
    // 正文为空且被长度上限截断 → 去掉 max_tokens 重发（把正文救回来）
    if (!String(acc.content || '').trim() && !acc.toolCalls.length && body.max_tokens && /length|max_tokens/i.test(acc.finishReason)) {
      degraded.push('cap-retry');
      const retryBody = Object.assign({}, body);
      delete retryBody.max_tokens;
      const retryRes = await fetch(req.url, {
        method: 'POST', headers: req.headers, body: JSON.stringify(retryBody), signal: ctrl.signal
      });
      if (retryRes.ok) {
        res = retryRes;
        acc.content = ''; acc.reasoning = ''; acc.toolCalls = []; acc.finishReason = '';
        await readOnce();
        if (o.onMeta) o.onMeta({ capRetry: true });
      }
    }
    if (o.onMeta) o.onMeta({ finishReason: acc.finishReason, usage, toolStream: sawToolDelta });
    return {
      content: acc.content,
      reasoning: acc.reasoning,
      toolCalls: acc.toolCalls.filter((t) => t.name),
      finishReason: acc.finishReason,
      usage,
      degraded
    };
  } finally {
    clearTimeout(timer);
    if (o.signal) { try { o.signal.removeEventListener('abort', onOuterAbort); } catch { /* ignore */ } }
  }
}

module.exports = {
  callModel,
  buildRequest,
  pumpResponse,
  errorText,
  toAnthropicMessages,
  accumulateToolCalls,
  readToolCalls,
  joinUrl
};
