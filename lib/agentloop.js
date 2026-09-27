/**
 * agentloop.js — cf-coach 的**工具循环**（真·多轮 agent，而不是固定流水线）。
 *
 * 这是本次改造的核心：以前每一次用户发言都被塞进一条写死的链路
 * （抽契约 → 三个 agent 并行 → 样例校准 → 对拍 → 生成固定结构的讲解文档），
 * 于是追问必须重跑整条链、题面在载荷里只剩几十个字符、上一轮的回答根本不在上下文里。
 *
 * 现在：
 *   - **真实对话历史**全程参与（追问就是普通对话，模型能引用自己上一轮说的话）；
 *   - 模型**自己决定**要不要调工具（cf_verify / cf_fetch / cf_run …），而不是每轮都跑全套；
 *   - 技能（skills/*.md）在需要时注入，提供"这类事该怎么做"的方法论；
 *   - 工具的成败如实回灌，让模型能自我修正。
 *
 * 兼容性：上游支持 function calling 时走原生工具协议；不支持时自动回落到
 * **JSON 工具协议**（提示词里给工具清单，模型输出 {"tool":…,"args":…}），
 * 保证在任何 OpenAI 兼容端点上都能用。
 */

'use strict';

const llm = require('./llm');

const DEFAULT_MAX_STEPS = 12;

/* ---------------- JSON 工具协议（没有 function calling 时的回退） ---------------- */

const JSON_PROTOCOL_HEAD = [
  '',
  '【工具调用协议（本端不支持原生 function calling，请用 JSON 调用工具）】',
  '需要调用工具时，**只输出一个 JSON 代码块**，形如：',
  '```json',
  '{"tool": "cf_fetch", "args": {"contestId": 1800, "index": "C"}}',
  '```',
  '收到工具结果后继续；不需要工具时正常用中文回答（不要输出 JSON）。',
  '可用工具：'
].join('\n');

function jsonProtocolCatalog(tools) {
  return tools.map((t) => '- `' + t.name + '`：' + t.description
    + ' 参数：' + JSON.stringify(schemaToHint(t.parameters))).join('\n');
}

/** 把参数 DSL 压成 `{name: "string(必填)"}` 这样的提示 */
function schemaToHint(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    out[k] = String(v.type || 'string') + (v.required ? '(必填)' : '');
  }
  return out;
}

/** 从模型输出里抠出工具调用（容忍代码块包裹、前后有解释文字、以及多个调用） */
function parseJsonToolCalls(text) {
  const s = String(text || '');
  const calls = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  const candidates = [];
  while ((m = re.exec(s)) !== null) candidates.push(m[1]);
  if (!candidates.length && /"tool"\s*:/.test(s)) candidates.push(s);
  for (const c of candidates) {
    // 一个块里可能是数组，也可能是单个对象
    const arr = [];
    const t = c.trim();
    if (t.startsWith('[')) {
      try { const j = JSON.parse(t); if (Array.isArray(j)) arr.push(...j); } catch { /* ignore */ }
    } else {
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { arr.push(JSON.parse(t.slice(start, end + 1))); } catch { /* ignore */ }
      }
    }
    for (const item of arr) {
      if (item && typeof item.tool === 'string') calls.push({ id: 'call_' + calls.length, name: item.tool, args: JSON.stringify(item.args || {}) });
      else if (item && typeof item.name === 'string' && item.args) calls.push({ id: 'call_' + calls.length, name: item.name, args: JSON.stringify(item.args) });
    }
    if (calls.length) break;
  }
  return calls;
}

/**
 * 把 JSON 协议下的工具调用从可见正文里剔掉（否则用户会看到一坨 JSON）。
 *
 * ⚠️ 这里必须**非贪婪**（`[\s\S]*?\}\s*```），并且要求匹配到 JSON 的收尾 `}`。
 * 踩过的坑：写成 `[\s\S]*?```` 会从工具 JSON 的 ```json 一直吃到**后面正文的** ```，
 * 于是"工具调用 + 紧随其后的正文"被整段删掉——正文直接变空（测试抓到的真实缺陷）。
 */
function stripJsonToolBlocks(text) {
  return String(text || '')
    .replace(/```(?:json)?\s*\{\s*"tool"[\s\S]*?\}\s*```/gi, '')
    .replace(/^\s*\{\s*"tool"\s*:[\s\S]*$/, '')
    .trim();
}

/* ---------------- 主循环 ---------------- */

/**
 * 跑一次 agent 回合。
 *
 * @param {object} o
 * @param {object}   o.provider        模型服务
 * @param {string}   o.model           模型名
 * @param {string}   o.system          系统提示词（人格 + 技能目录 + 状态）
 * @param {Array}    o.history         **真实对话历史**：[{role:'user'|'assistant', content}]（不含本轮）
 * @param {string}   o.userText        本轮用户输入
 * @param {Array}    o.tools           工具定义（tools.js 产出的）
 * @param {AbortSignal} o.signal
 * @param {number}   o.maxSteps        工具循环上限（防止打转）
 * @param {number}   o.maxTokens
 * @param {function} o.onDelta         正文增量回调
 * @param {function} o.onReasoning     思考增量回调
 * @param {function} o.onToolStart     (call) => void   工具开始
 * @param {function} o.onToolEnd       (call, ok, summary) => void
 * @param {function} o.onUsage         (usage) => void
 * @returns {Promise<{text:string, steps:number, usage:object, toolsUsed:string[]}>}
 */
async function runTurn(o) {
  const tools = Array.isArray(o.tools) ? o.tools : [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const maxSteps = o.maxSteps || DEFAULT_MAX_STEPS;
  const onDelta = o.onDelta || (() => {});
  const onReasoning = o.onReasoning || (() => {});
  const onToolStart = o.onToolStart || (() => {});
  const onToolEnd = o.onToolEnd || (() => {});
  const onUsage = o.onUsage || (() => {});

  // 上游工具协议：先假定支持；一旦报"不认识 tools"就永久降级到 JSON 协议
  let nativeTools = o.nativeTools !== false;
  let jsonMode = !nativeTools;

  /** 对话消息（含历史）；JSON 协议下工具结果以 user 消息回灌 */
  const messages = [];
  for (const h of (o.history || [])) {
    if (!h || !h.content || !String(h.content).trim()) continue;
    if (h.role !== 'user' && h.role !== 'assistant') continue;
    messages.push({ role: h.role, content: String(h.content) });
  }
  messages.push({ role: 'user', content: String(o.userText || '') });

  const usage = { promptTokens: 0, completionTokens: 0, calls: 0, estimated: false };
  const toolsUsed = [];
  let text = '';
  let steps = 0;

  const systemFor = () => {
    if (!jsonMode) return o.system;
    return o.system + '\n' + JSON_PROTOCOL_HEAD + '\n' + jsonProtocolCatalog(tools);
  };

  for (let step = 0; step < maxSteps; step++) {
    if (o.signal && o.signal.aborted) throw new Error('已取消');
    steps++;
    const res = await llm.callModel({
      provider: o.provider,
      model: o.model,
      system: systemFor(),
      messages,
      tools: jsonMode ? [] : tools.map((t) => ({ name: t.name, description: t.description, parameters: jsonSchemaOf(t.parameters) })),
      maxTokens: o.maxTokens,
      stream: true,
      signal: o.signal,
      callTimeoutMs: o.callTimeoutMs,
      onDelta,
      onReasoning,
      onUsage: (u) => {
        if (u.promptTokens != null) usage.promptTokens += u.promptTokens;
        if (u.completionTokens != null) usage.completionTokens += u.completionTokens;
        onUsage(u);
      }
    }).catch((e) => {
      if (e && e.toolsUnsupported && !jsonMode) {
        jsonMode = true;
        return null;   // 重来一次，这次用 JSON 协议
      }
      throw e;
    });
    if (res === null) { step--; continue; }   // 协议降级的那一轮不计数
    usage.calls++;

    // 统一取出工具调用：原生 → res.toolCalls；JSON 协议 → 从正文里解析
    let calls = res.toolCalls || [];
    if (jsonMode) calls = parseJsonToolCalls(res.content);
    if (jsonMode && calls.length && !text) {
      // JSON 协议下第一轮如果只吐了 JSON，不要把 JSON 当正文显示给用户
      const cleaned = stripJsonToolBlocks(res.content);
      if (cleaned) text = cleaned;
    } else if (!jsonMode) {
      text = res.content;
    } else if (res.content && !calls.length) {
      text = res.content;
    }

    if (!calls.length) {
      // 没有工具调用 = 这一轮就是最终回答
      if (!String(text || '').trim() && res.reasoning) {
        // 极端情况：模型只输出了思考。如实说明，不要把空内容当成回答。
        text = '（这一轮模型只输出了思考过程，没有给出正文。可以让我重新回答一次。）';
      }
      return { text: String(text || ''), steps, usage, toolsUsed };
    }

    // 记下这一轮的助手消息（原生协议需要它来配对 tool_call_id）
    if (!jsonMode) {
      messages.push({ role: 'assistant', content: res.content || '', toolCalls: calls });
    } else {
      messages.push({ role: 'assistant', content: res.content || '' });
    }

    // 逐个执行工具（串行：它们大多依赖前一个的结果，并行只会让模型更糊涂）
    for (const call of calls) {
      if (o.signal && o.signal.aborted) throw new Error('已取消');
      const tool = byName.get(call.name);
      let out;
      let ok = true;
      const startedAt = Date.now();
      onToolStart(call);
      if (!tool) {
        ok = false;
        out = '错误：没有名为 "' + call.name + '" 的工具。可用工具：' + [...byName.keys()].join(' / ');
      } else {
        let args = {};
        try { args = JSON.parse(call.args || '{}'); } catch (e) { args = {}; }
        try {
          out = await tool.execute(args, { signal: o.signal });
        } catch (e) {
          ok = false;
          out = '工具执行失败：' + ((e && e.message) || String(e));
        }
      }
      const ms = Date.now() - startedAt;
      if (toolsUsed.indexOf(call.name) < 0) toolsUsed.push(call.name);
      onToolEnd(call, ok, out, ms);

      if (!jsonMode) {
        messages.push({ role: 'tool', toolCallId: call.id, content: String(out == null ? '' : out) });
      } else {
        messages.push({ role: 'user', content: '【工具 ' + call.name + ' 的结果】\n' + String(out == null ? '' : out) });
      }
    }

    if (step === maxSteps - 1) {
      // 步数用完：再给模型一次"只回答、不许调工具"的机会，避免把中间过程当答案交给用户
      const finalRes = await llm.callModel({
        provider: o.provider, model: o.model, system: o.system, messages,
        tools: [], maxTokens: o.maxTokens, stream: true, signal: o.signal,
        callTimeoutMs: o.callTimeoutMs, onDelta, onReasoning,
        onUsage: (u) => {
          if (u.promptTokens != null) usage.promptTokens += u.promptTokens;
          if (u.completionTokens != null) usage.completionTokens += u.completionTokens;
          onUsage(u);
        }
      });
      usage.calls++;
      return { text: String(finalRes.content || ''), steps, usage: Object.assign(usage, { truncatedSteps: true }), toolsUsed };
    }
  }

  return { text, steps, usage, toolsUsed };
}

/** 把参数 DSL 转成标准 JSON Schema（原生 function calling 用） */
function jsonSchemaOf(params) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params || {})) {
    const node = { type: v.type || 'string' };
    if (v.description) node.description = v.description;
    if (v.enum) node.enum = v.enum;
    if (v.type === 'array') node.items = v.items ? jsonSchemaOf(v.items.properties ? v.items.properties : {}) : { type: 'string' };
    if (v.type === 'object' && v.properties) { node.properties = jsonSchemaOf(v.properties).properties; }
    properties[k] = node;
    if (v.required) required.push(k);
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

module.exports = { runTurn, parseJsonToolCalls, stripJsonToolBlocks, jsonSchemaOf, DEFAULT_MAX_STEPS };
