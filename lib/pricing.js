'use strict';
/**
 * pricing.js — token 用量与费用估算（**不依赖模型**：token 直接来自服务商返回的 usage）。
 *
 * 为什么单独成模块：费用是"给用户看的钱数"，必须可测、可解释、可覆盖。
 * 三条原则：
 *  ① token 优先用服务商返回的真值；服务商不回 usage 时按字符估算，并标 `estimated: true`（UI 显示"约"）；
 *  ② 费用 = token × 单价；单价优先用用户自定义，其次内置参考价；**两者都没有就返回 null**（不编数字）；
 *  ③ 内置价格只是"心里有数"的参考（各家调价频繁），UI 里明确提示以账单为准。
 */

/** 参考价目表（人民币元 / 每 100 万 token；in=输入 out=输出，cacheIn=缓存命中的输入价）。
 *  模型名小写包含 key 即命中。**缓存价很关键**：连续多轮对话（本应用一轮就有十几次调用）
 *  的提示词大量重复，服务商按缓存命中价计费（DeepSeek 约 1/10），按"全价输入"估会明显偏高。 */
const PRICE_TABLE = [
  { key: 'deepseek-reasoner', in: 4, out: 16, cacheIn: 0.5 },
  { key: 'deepseek-chat', in: 2, out: 8, cacheIn: 0.2 },
  { key: 'deepseek', in: 2, out: 8, cacheIn: 0.2 },
  { key: 'kimi', in: 4, out: 16, cacheIn: 1 },
  { key: 'moonshot', in: 12, out: 12, cacheIn: 3 },
  { key: 'glm-4', in: 1, out: 1, cacheIn: 0.5 },
  { key: 'glm', in: 1, out: 1, cacheIn: 0.5 },
  { key: 'qwen-max', in: 20, out: 60, cacheIn: 8 },
  { key: 'qwen', in: 2, out: 6, cacheIn: 0.8 },
  { key: 'gpt-4o-mini', in: 1, out: 4, cacheIn: 0.5 },
  { key: 'gpt-4o', in: 18, out: 72, cacheIn: 9 },
  { key: 'gpt-4', in: 72, out: 216, cacheIn: 36 },
  { key: 'o1', in: 108, out: 432, cacheIn: 54 },
  { key: 'claude-3-5-sonnet', in: 22, out: 108, cacheIn: 2.2 },
  { key: 'claude-3-5-haiku', in: 6, out: 30, cacheIn: 0.6 },
  { key: 'claude', in: 22, out: 108, cacheIn: 2.2 }
];

/** 该模型的单价：用户覆盖（providerId::model 或 model）> 内置参考价 > null */
function resolvePrice(cfg, providerId, model) {
  const overrides = (cfg && cfg.pricing) || {};
  const direct = overrides[providerId + '::' + model] || overrides[model];
  if (direct && (direct.in != null || direct.out != null)) {
    const inP = Number(direct.in) || 0;
    return { in: inP, out: Number(direct.out) || 0,
      cacheIn: direct.cacheIn != null ? Number(direct.cacheIn) || 0 : inP / 10, source: 'user' };
  }
  const m = String(model || '').toLowerCase();
  const hit = PRICE_TABLE.find((p) => m && m.indexOf(p.key) >= 0);
  return hit ? { in: hit.in, out: hit.out, cacheIn: hit.cacheIn != null ? hit.cacheIn : hit.in / 10, source: 'builtin' } : null;
}

/**
 * 由 token 用量算钱（元）；没有单价返回 null（如实说"未知"，不编数字）。
 * 缓存命中的输入 token 按 cacheIn 计价（服务商返回 prompt_cache_hit_tokens 时才用得上）——
 * 这就是"应用里显示的比官方账单高"的主因：看不到缓存命中比例时，我们只能按全价估。
 */
function estimateCost(cfg, providerId, model, usage) {
  if (!usage) return null;
  const price = resolvePrice(cfg, providerId, model);
  if (!price) return null;
  const inTok = Number(usage.promptTokens) || 0;
  const outTok = Number(usage.completionTokens) || 0;
  const hit = Number(usage.cacheHitTokens) || 0;
  const miss = usage.cacheMissTokens != null ? Number(usage.cacheMissTokens) || 0 : Math.max(0, inTok - hit);
  const hitTok = Math.min(hit, inTok);
  const billableMiss = Math.max(0, Math.min(miss, inTok - hitTok));
  const amount = (hitTok / 1e6) * price.cacheIn + (billableMiss / 1e6) * price.in + (outTok / 1e6) * price.out;
  return {
    currency: 'CNY',
    amount: Math.round(amount * 10000) / 10000,
    pricePerMillion: { in: price.in, out: price.out, cacheIn: price.cacheIn },
    priceSource: price.source,
    cacheTokens: hitTok ? { hit: hitTok, miss: billableMiss } : null,
    // 服务商没报缓存命中 → 我们把全部输入按全价算，实际账单通常更低（UI 会写明）
    cacheUnknown: !hitTok,
    estimated: !!usage.estimated,
    model
  };
}

/** 没有 usage 时的兜底估算：中文/代码混合按 2.5 字符 ≈ 1 token（保守） */
function estimateTokens(text) {
  return Math.max(1, Math.round(String(text == null ? '' : text).length / 2.5));
}

/**
 * 把逐次调用汇总成"这题花了多少"。
 * @param {Array<{role,label,promptTokens,completionTokens,estimated}>} calls
 */
function summarize(calls) {
  const byRole = {};
  let prompt = 0;
  let completion = 0;
  let estimated = false;
  (calls || []).forEach((r) => {
    prompt += r.promptTokens || 0;
    completion += r.completionTokens || 0;
    if (r.estimated) estimated = true;
    const g = byRole[r.role] = byRole[r.role] || { calls: 0, promptTokens: 0, completionTokens: 0, estimated: false };
    g.calls++;
    g.promptTokens += r.promptTokens || 0;
    g.completionTokens += r.completionTokens || 0;
    if (r.estimated) g.estimated = true;
  });
  return { calls: (calls || []).length, promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, estimated, byRole };
}

/** 一句话文案（日志/工具提示共用） */
function describe(cfg, providerId, model, usage) {
  if (!usage) return '';
  const cost = estimateCost(cfg, providerId, model, usage);
  return usage.calls + ' 次调用 · 输入 ' + usage.promptTokens + ' / 输出 ' + usage.completionTokens + ' tokens'
    + (usage.estimated ? '（含估算）' : '')
    + (cost ? ' · 约 ¥' + cost.amount.toFixed(4) : ' · 未配置单价');
}

module.exports = { PRICE_TABLE, resolvePrice, estimateCost, estimateTokens, summarize, describe };
