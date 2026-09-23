'use strict';
/**
 * token 用量与费用估算测试（lib/pricing.js）。
 *
 * 用户诉求："每次跑完检测一下 token 消耗，让我知道讲这道题花了多少钱"。
 * 关键点：**不依赖模型**（token 来自服务商 usage），且费用规则要可解释、可覆盖、不编数字：
 *  ① 用户自定义单价优先；② 其次内置参考价；③ 都没有就返回 null（UI 显示"未配置单价"，而不是瞎算）。
 */
const assert = require('assert');
const p = require('../lib/pricing');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('pricing: 单价解析');

ok('内置参考价：deepseek-reasoner / gpt-4o / claude 都能命中', () => {
  assert.strictEqual(p.resolvePrice({}, 'x', 'deepseek-reasoner').source, 'builtin');
  assert.ok(p.resolvePrice({}, 'x', 'gpt-4o-mini').in > 0);
  assert.ok(p.resolvePrice({}, 'x', 'claude-3-5-sonnet').out > 0);
});

ok('更具体的模型名优先命中（gpt-4o-mini 不会被 gpt-4 抢走）', () => {
  const mini = p.resolvePrice({}, 'x', 'gpt-4o-mini');
  const full = p.resolvePrice({}, 'x', 'gpt-4o');
  assert.ok(mini.in < full.in, JSON.stringify({ mini, full }));
});

ok('用户自定义单价覆盖内置（providerId::model 与裸 model 都认）', () => {
  const cfg = { pricing: { 'prov::deepseek-chat': { in: 0.5, out: 1.5 } } };
  const r1 = p.resolvePrice(cfg, 'prov', 'deepseek-chat');
  assert.strictEqual(r1.source, 'user');
  assert.strictEqual(r1.in, 0.5);
  const r2 = p.resolvePrice({ pricing: { 'my-model': { in: 3, out: 9 } } }, 'any', 'my-model');
  assert.strictEqual(r2.out, 9);
});

ok('未知模型且没有自定义单价 → null（不编价格）', () => {
  assert.strictEqual(p.resolvePrice({}, 'x', 'totally-local-llm'), null);
});

console.log('pricing: 费用估算');

ok('费用 = 输入价×输入量 + 输出价×输出量（每百万 token）', () => {
  const c = p.estimateCost({}, 'x', 'deepseek-chat', { promptTokens: 1e6, completionTokens: 1e6 });
  assert.strictEqual(c.amount, 10);           // 2 + 8
  assert.strictEqual(c.currency, 'CNY');
});

ok('token 少的时候保留 4 位小数（不然全是 0.00）', () => {
  const c = p.estimateCost({}, 'x', 'deepseek-chat', { promptTokens: 5000, completionTokens: 1000 });
  assert.ok(c.amount > 0 && c.amount < 0.1, JSON.stringify(c));
  assert.strictEqual(String(c.amount).split('.')[1].length <= 4, true);
});

ok('估算是"标记"而不是"隐藏"：estimated 透传到费用结果', () => {
  const c = p.estimateCost({}, 'x', 'deepseek-chat', { promptTokens: 100, completionTokens: 100, estimated: true });
  assert.strictEqual(c.estimated, true);
});

ok('没有单价 → 返回 null（UI 显示"未配置单价"）', () => {
  assert.strictEqual(p.estimateCost({}, 'x', 'totally-local-llm', { promptTokens: 100, completionTokens: 100 }), null);
});

ok('没有用量 → 返回 null', () => {
  assert.strictEqual(p.estimateCost({}, 'x', 'deepseek-chat', null), null);
});

console.log('pricing: 逐调用汇总（这题花了多少）');

ok('按角色汇总调用次数与 token，并标出是否含估算', () => {
  const s = p.summarize([
    { role: 'solution', promptTokens: 1000, completionTokens: 500 },
    { role: 'brute', promptTokens: 800, completionTokens: 400 },
    { role: 'explainer', promptTokens: 2000, completionTokens: 3000, estimated: true }
  ]);
  assert.strictEqual(s.calls, 3);
  assert.strictEqual(s.promptTokens, 3800);
  assert.strictEqual(s.completionTokens, 3900);
  assert.strictEqual(s.estimated, true);
  assert.strictEqual(s.byRole.explainer.promptTokens, 2000);
});

ok('一句话文案包含调用数、token 与费用（或如实说未配置单价）', () => {
  const withPrice = p.describe({}, 'x', 'deepseek-chat', p.summarize([{ role: 'a', promptTokens: 1000, completionTokens: 1000 }]));
  assert.ok(/1 次调用/.test(withPrice) && /¥/.test(withPrice), withPrice);
  const noPrice = p.describe({}, 'x', 'totally-local-llm', p.summarize([{ role: 'a', promptTokens: 1, completionTokens: 1 }]));
  assert.ok(/未配置单价/.test(noPrice), noPrice);
});

ok('字符兜底估算：中文/代码混合按 2.5 字符≈1 token', () => {
  assert.strictEqual(p.estimateTokens('a'.repeat(250)), 100);
  assert.ok(p.estimateTokens('') >= 1);
});

console.log('pricing: 缓存命中（"官方账单比应用里显示的少"的根因）');

ok('服务商报了缓存命中 → 命中的输入按缓存价计（比全价便宜一个量级）', () => {
  const noCache = p.estimateCost({}, 'x', 'deepseek-chat', { promptTokens: 1000000, completionTokens: 0 });
  const withCache = p.estimateCost({}, 'x', 'deepseek-chat', {
    promptTokens: 1000000, completionTokens: 0, cacheHitTokens: 900000, cacheMissTokens: 100000
  });
  assert.ok(withCache.amount < noCache.amount, JSON.stringify({ noCache, withCache }));
  // 10% 全价 + 90% 缓存价
  const inP = noCache.pricePerMillion.in, cIn = noCache.pricePerMillion.cacheIn;
  assert.ok(Math.abs(withCache.amount - (0.1 * inP + 0.9 * cIn)) < 1e-6, JSON.stringify(withCache));
  assert.strictEqual(withCache.cacheUnknown, false);
  assert.ok(withCache.cacheTokens && withCache.cacheTokens.hit === 900000);
});

ok('没报缓存命中 → 按全价估，并明确标记 cacheUnknown（UI 会写"实际账单通常更低"）', () => {
  const c = p.estimateCost({}, 'x', 'deepseek-chat', { promptTokens: 1000, completionTokens: 10 });
  assert.strictEqual(c.cacheUnknown, true);
  assert.strictEqual(c.cacheTokens, null);
});

ok('自定义单价也能配缓存价（cacheIn），没配就按输入价的 1/10', () => {
  const cfg = { pricing: { m: { in: 10, out: 20, cacheIn: 1 } } };
  const c = p.estimateCost(cfg, 'p', 'm', { promptTokens: 1000000, completionTokens: 0, cacheHitTokens: 1000000 });
  assert.ok(Math.abs(c.amount - 1) < 1e-6, JSON.stringify(c));
  const cfg2 = { pricing: { m2: { in: 10, out: 20 } } };
  const c2 = p.estimateCost(cfg2, 'p', 'm2', { promptTokens: 1000000, completionTokens: 0, cacheHitTokens: 1000000 });
  assert.ok(Math.abs(c2.amount - 1) < 1e-6, JSON.stringify(c2));
});

ok('缓存命中数大于输入总量时不会算成负数（按输入量夹紧）', () => {
  const c = p.estimateCost({}, 'x', 'deepseek-chat', { promptTokens: 100, completionTokens: 0, cacheHitTokens: 999999 });
  assert.ok(c.amount >= 0, JSON.stringify(c));
});

console.log('\npricing: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
