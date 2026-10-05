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

/* ---------------- 特殊标记泄漏（DeepSeek DSML 等） ---------------- */

/**
 * **真实事故**（用户朋友的机器，截图里那坨"乱码"）：助手消息正文原样显示
 * `<｜｜DSML｜｜invoke name="cf.run">` / `<｜｜DSML｜｜parameter …>` 这类**上游内部标记**。
 * 它不是编码乱码，而是上游把"工具调用"以内部标记的形态吐进了 `content`：
 * 触发条件与社区报告一致 —— **请求里省略了 tools 声明，而历史消息里还带着 tool_calls**。
 * 我们的循环恰好有这么一个请求：步数用尽时发的"最后一次、不许调工具"（tools: []）。
 * 三个修法（本段代码）：① 那个请求不再省略工具声明（改用 tool_choice: none + 明确提示）；
 * ② 一旦标记还是漏进正文，**从正文里回收成真的工具调用**（cf.run → cf_run）；
 * ③ 无论如何，回到界面/落盘的正文都要先剥掉这些标记 —— 绝不把标记当讲解。
 */
const PIPE = '[|\\uFF5C]';   // 半角竖线 | 与全角竖线 ｜（两种形态都见过）

/**
 * 形如 <｜｜DSML｜｜invoke name="x"> 的标记（开/闭、带/不带斜杠都算）。
 *
 * 空白必须容忍：真实模型吐出来的变体是 `<｜｜DSML｜｜ calls>`（DSML 与标签名之间多一个空格），
 * 老正则不允许那里有空白 → hasLeakMarkup 判 false → stripLeakMarkup 直接原样返回 →
 * 整坨内部标记被当成"回答"落盘（ablation/out/ui/answers/L1-2268A.md 就是这么来的）。
 */
function dsmlTagRe(flags) {
  return new RegExp('<\\/?' + PIPE + '{1,3}(?:DSML' + PIPE + '{0,3}\\s*)?\\s*([a-zA-Z_]+)'
    + '((?:\\s+[a-zA-Z_]+\\s*=\\s*"[^"]*")*)\\s*' + PIPE + '{0,3}>', flags || 'gi');
}

/** 其它形态的特殊标记（anthropic 风格 / 通用 tool_call 标签） */
const OTHER_TAG_RE = /<\/?(?:tool[_\s]?calls?|function[_\s]?calls?|antml:[a-z_]+)\b[^>]*>/gi;

/** 正文里有没有"工具调用标记"（用于决定是否要走回收/净化） */
function hasLeakMarkup(text) {
  const s = String(text || '');
  if (!s) return false;
  dsmlTagRe('gi').lastIndex = 0;
  if (dsmlTagRe('gi').test(s)) return true;
  OTHER_TAG_RE.lastIndex = 0;
  return OTHER_TAG_RE.test(s);
}

/**
 * 剥掉泄漏的标记，只留人类可读的正文。
 *
 * 两种情形要分开处理（这是"整段都是标记"必须被判成"没有正文"的关键）：
 *  - 正文里夹带一个调用结构 → **整块调用都要丢掉**（含 parameter 的取值），只留前后真正的人话；
 *  - 只有零散标记（没有完整的调用结构）→ 只删标记本身，不删被它包住的内容。
 */
function stripLeakMarkup(text) {
  const s = String(text || '');
  if (!hasLeakMarkup(s)) return s;
  const scanned = scanLeakMarkup(s);
  const base = scanned.calls.length
    ? scanned.residue
    : s.replace(dsmlTagRe('gi'), '');
  return base.replace(OTHER_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 扫描泄漏的标记：把 invoke/parameter 结构解析成工具调用，同时留下**结构之外**的人话。
 * @returns {{calls:{id:string,name:string,args:string}[], residue:string}}
 */
function scanLeakMarkup(raw) {
  const s = String(raw || '');
  const re = dsmlTagRe('gi');
  const calls = [];
  let residue = '';
  let depth = 0;
  let cur = null;
  let key = null;
  let isStr = false;
  let buf = '';
  let last = 0;
  const attrsOf = (str) => {
    const out = {};
    const ar = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = ar.exec(str || '')) !== null) out[m[1].toLowerCase()] = m[2];
    return out;
  };
  const endParam = () => {
    if (cur && key != null) {
      let v = buf;
      if (!isStr) {
        const t = v.trim();
        if (/^-?\d+(?:\.\d+)?$/.test(t)) v = Number(t);
        else { try { v = JSON.parse(t); } catch (e) { /* 当字符串 */ } }
      }
      cur.args[key] = v;
    }
    key = null; isStr = false; buf = '';
  };
  const endInvoke = () => {
    if (cur && cur.name) calls.push({ id: 'leak_' + calls.length, name: cur.name, args: JSON.stringify(cur.args || {}) });
    cur = null;
  };
  let m;
  while ((m = re.exec(s)) !== null) {
    const inner = s.slice(last, m.index);
    last = re.lastIndex;
    // 结构之外的文字 = 人话（要保留）；结构之内的文字 = 参数取值（由 marker 界定）
    if (depth === 0) residue += inner;
    else if (key != null) buf += inner;
    const tag = String(m[1] || '').toLowerCase();
    const attrs = attrsOf(m[2]);
    if (tag === 'invoke') {
      if (attrs.name) { endParam(); endInvoke(); cur = { name: attrs.name, args: {} }; depth++; }
      else { endParam(); endInvoke(); depth = Math.max(0, depth - 1); }
    } else if (tag === 'parameter') {
      endParam();
      if (attrs.name) { key = attrs.name; isStr = String(attrs.string || '').toLowerCase() === 'true'; buf = ''; }
    } else {
      // calls / tool_calls 之类的容器：同名标记开一次闭一次，用 depth 区分
      endParam();
      if (depth > 0) { endInvoke(); depth--; } else depth++;
    }
  }
  if (depth === 0 && last < s.length) residue += s.slice(last);
  endParam();
  endInvoke();
  return { calls, residue };
}

/** 把泄漏出来的 invoke/parameter 结构解析成真正的工具调用（名字做归一化，只留真实存在的工具） */
function recoverLeakedToolCalls(raw, byName) {
  const s = String(raw || '');
  const known = (byName && typeof byName.keys === 'function') ? byName : new Map();
  if (!hasLeakMarkup(s)) return [];
  const calls = scanLeakMarkup(s).calls;
  const norm = [];
  for (const c of calls) {
    const name = matchToolName(c.name, known);
    if (name) norm.push({ id: c.id, name, args: c.args });
  }
  return norm;
}

/** 把模型写歪的工具名对回已声明的工具（cf.run → cf_run 是最常见的一种） */
function matchToolName(name, byName) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (byName.has(raw)) return raw;
  const cands = [raw.replace(/[.\-\s]+/g, '_'), raw.split(/[.\/]/).pop(), raw.replace(/_/g, '.')];
  for (const c of cands) {
    if (!c) continue;
    if (byName.has(c)) return c;
    for (const k of byName.keys()) if (k.toLowerCase() === c.toLowerCase()) return k;
  }
  return null;
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
    /**
     * 上游把工具调用**泄漏成正文**时，把它回收成真正的调用（第二道修法）。
     *
     * 为什么值得回收而不是只净化：模型此刻想做的是"读工作区文件/跑一段代码"，
     * 一旦这次调用被丢掉，它就会在下一轮重试、把步数预算耗光（截图里 24 次调用就是这么来的），
     * 而且最后什么也没交付。回收后循环能继续往前走。
     */
    let leaked = [];
    if (!jsonMode && !calls.length && hasLeakMarkup(res.content)) {
      leaked = recoverLeakedToolCalls(res.content, byName);
      if (leaked.length) {
        console.log('[agentloop] 上游把工具调用泄漏成正文 → 已回收 ' + leaked.length + ' 个调用：'
          + leaked.map((c) => c.name).join(', '));
        calls = leaked;
      }
    }
    if (jsonMode && calls.length && !text) {
      // JSON 协议下第一轮如果只吐了 JSON，不要把 JSON 当正文显示给用户
      const cleaned = stripJsonToolBlocks(res.content);
      if (cleaned) text = cleaned;
    } else if (!jsonMode) {
      /**
       * 正文里的特殊标记**永不进正文**：无论回收成功与否都先净化，
       * 再按净化后的结果决定这段文字是不是"回答"（净化后为空 → 视为没有正文）。
       */
      text = hasLeakMarkup(res.content) ? stripLeakMarkup(res.content) : res.content;
    } else if (res.content && !calls.length) {
      text = res.content;
    }

    if (!calls.length) {
      // 没有工具调用 = 这一轮就是最终回答
      if (!String(text || '').trim() && (res.reasoning || hasLeakMarkup(res.content))) {
        /**
         * 极端情况：模型只输出了思考，或者**整段输出都是内部工具标记**（净化为空）。
         * 两种都要如实说明，绝不能把空内容或标记当回答交给用户。
         */
        text = hasLeakMarkup(res.content) && !String(res.reasoning || '').trim()
          ? '（这一轮模型的输出全是内部工具标记，我已把它们剥掉、不作为回答显示。可以再发一次，或把问题问得更具体一点。）'
          : '（这一轮模型只输出了思考过程，没有给出正文。可以让我重新回答一次。）';
      }
      return { text: String(text || ''), steps, usage, toolsUsed };
    }

    // 记下这一轮的助手消息（原生协议需要它来配对 tool_call_id）
    if (!jsonMode) {
      // 历史里的正文也要先净化：把标记原样回灌给上游，很可能再触发一次同样的泄漏
      messages.push({ role: 'assistant', content: stripLeakMarkup(res.content) || '', toolCalls: calls });
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
      /**
       * 步数用尽：再给模型一次"只回答、不许调工具"的机会，避免把中间过程当答案交给用户。
       *
       * ⚠️ **这里原来传 `tools: []`，是一个线上事故的根因**（用户朋友机器上的那坨"乱码"）：
       * 省略 tools 声明、而历史里还带着 assistant.tool_calls 时，上游（DeepSeek 系）
       * 会把内部工具标记（DSML）直接吐进 content，我们又把 content 当"最终回答"存下来显示。
       * 所以现在：**保留工具声明**（协议完整），用 `tool_choice: 'none'` + 一句明确指令来表达
       * "这一轮只写答案"；万一上游不认 tool_choice，llm 层会去掉该字段重试（见 lib/llm.js）。
       */
      const finalTools = jsonMode ? [] : tools.map((t) => ({ name: t.name, description: t.description, parameters: jsonSchemaOf(t.parameters) }));
      const finalMessages = messages.concat([{
        role: 'system',
        content: '【最后一步·系统指令】工具调用次数已用尽：这一轮**不要再调用任何工具**，'
          + '直接输出给用户的最终回答（把已经拿到的结论讲清楚）。'
      }]);
      const finalRes = await llm.callModel({
        provider: o.provider, model: o.model, system: o.system, messages: finalMessages,
        tools: finalTools, toolChoice: jsonMode ? undefined : 'none',
        maxTokens: o.maxTokens, stream: true, signal: o.signal,
        callTimeoutMs: o.callTimeoutMs, onDelta, onReasoning,
        onUsage: (u) => {
          if (u.promptTokens != null) usage.promptTokens += u.promptTokens;
          if (u.completionTokens != null) usage.completionTokens += u.completionTokens;
          onUsage(u);
        }
      });
      usage.calls++;
      let finalText = stripLeakMarkup(finalRes.content);
      /**
       * 最后这一步仍然只吐出标记（说明上游这一轮又在"调工具"而不是回答）→ 再给**唯一一次**
       * 干净的重试：不带任何历史工具痕迹、只带最后一段工具结果，明确要求写正文。
       * 两次都不行就如实说明，绝不把标记当讲解交付。
       */
      if (!finalText.trim()) {
        /**
         * ⚠️ 重试的目的不是"重放对话"，而是"把已经拿到的结论交出来"。旧版只带 user/assistant 消息，
         *    `role:'tool'` 一条都没带（注释说要带最后一段工具结果，代码没做）→ 一轮里工具调用 ≥3 次时，
         *    `slice(-6)` 里只剩一串"（上一步是工具调用，内容已省略）"，模型手里真的是空的
         *    （2026-10 事故：模型原话"题面正文和我刚才那几轮工具跑出来的结果，都没有进到我写这轮回答的上下文里"）。
         *    所以这里必须显式带上：最后一条 user 正文 + 最后一次工具结果（截断）。
         */
        const recent = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map((m) => ({ role: m.role, content: stripLeakMarkup(m.content) || '（上一步是工具调用，内容已省略）' }));
        const lastUser = [...messages].reverse().find((m) => m.role === 'user' && String(m.content || '').trim());
        if (lastUser && !recent.some((m) => m.role === 'user')) {
          recent.unshift({ role: 'user', content: stripLeakMarkup(lastUser.content) || String(lastUser.content || '') });
        }
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool' && String(m.content || '').trim());
        if (lastTool) {
          recent.push({
            role: 'user',
            content: '【最后一次工具结果（节选，写正文时以它为准）】\n' + String(lastTool.content).slice(0, 6000)
          });
        }
        const plain = recent
          .concat([{ role: 'user', content: '请用中文直接写出给用户的最终回答（正文）。不要再调用工具，也不要输出任何标记。' }]);
        const retry = await llm.callModel({
          provider: o.provider, model: o.model, system: o.system, messages: plain,
          tools: [], maxTokens: o.maxTokens, stream: true, signal: o.signal,
          callTimeoutMs: o.callTimeoutMs, onDelta, onReasoning,
          onUsage: (u) => {
            if (u.promptTokens != null) usage.promptTokens += u.promptTokens;
            if (u.completionTokens != null) usage.completionTokens += u.completionTokens;
            onUsage(u);
          }
        });
        usage.calls++;
        finalText = stripLeakMarkup(retry.content);
      }
      if (!finalText.trim()) {
        finalText = '（这一轮模型没能给出正文：它的输出全是内部工具标记，我已把它们剥掉了，'
          + '不会把标记当讲解显示给你。可以再发一次，或把问题问得更具体一点。）';
      }
      return { text: String(finalText), steps, usage: Object.assign(usage, { truncatedSteps: true }), toolsUsed };
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

module.exports = {
  runTurn, parseJsonToolCalls, stripJsonToolBlocks, jsonSchemaOf, DEFAULT_MAX_STEPS,
  // 特殊标记（上游 DSML 等泄漏）处理：导出给测试直接验证
  hasLeakMarkup, stripLeakMarkup, recoverLeakedToolCalls, matchToolName
};
