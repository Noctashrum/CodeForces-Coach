'use strict';
/**
 * 讲解文档校验器测试（lib/explaindoc.js）。
 * 两条主线：
 *  ① **编码**：组件写坏/未闭合/白名单外，绝不能漏到界面上（裸标记会被当纯文本显示）；
 *  ② **逻辑**：推理链必须完整（关键观察/为什么/手算演示/算法/复杂度/代码/易错点），
 *     且必须有依据 —— 禁止"显然/易得"这类跳过推理的说法。
 */
const assert = require('assert');
const ed = require('../lib/explaindoc');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const CODE = ['int main() {', '  int n; cin >> n;', '  cout << n << "\\n";', '}'].join('\n');

const GOOD = [
  '## 题面拆解',
  '输入一行 n，输出 n。容易读错的是 n 可以为 0。',
  '## 关键观察',
  '答案就是 n 本身。',
  '## 为什么',
  '因为输出要求就是 n；反例：若输出 n+1，样例 1 就对不上。',
  '## 手算演示',
  '拿 n=2 走一遍：',
  '<viz-steps title="n=2"><viz-step title="第 1 步">读入 2</viz-step><viz-step title="第 2 步">输出 2</viz-step></viz-steps>',
  '## 算法',
  '读入后直接输出。',
  '## 复杂度分析',
  '时间 $O(1)$，空间 $O(1)$。',
  '<viz-formula title="复杂度" fx="$T(n)=O(1)$" legend="n=输入" why="只做一次输出"/>',
  '## 代码',
  '```cpp',
  CODE,
  '```',
  '## 讲解',
  '一句话即可。',
  '## 易错点',
  'n=0 时不要特判成无解。',
  '## 验证',
  '官方样例 2 组通过 · 随机对拍 100 组一致。'
].join('\n');

console.log('explaindoc: 编码规范（组件写坏不能漏到界面）');

ok('合格讲解通过', () => {
  const v = ed.validate(GOOD, { intent: 'full', level: 'L3', solCode: CODE, lang: 'cpp' });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

ok('未闭合组件被拦下（否则界面上会出现原始标记）', () => {
  const v = ed.validate(GOOD.replace('</viz-steps>', ''), { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /没闭合/.test(e)), JSON.stringify(v.errors));
});

ok('白名单外的标签被拦下', () => {
  const v = ed.validate(GOOD + '\n<viz-magic x="1"/>', { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /不存在的组件标签/.test(e)), JSON.stringify(v.errors));
});

ok('组件太少（没做到图文结合）被拦下', () => {
  const v = ed.validate(GOOD.replace(/<viz-[^>]*>/g, '').replace(/<\/viz-[a-z]+>/g, ''), { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /组件太少/.test(e)), JSON.stringify(v.errors));
});

ok('sanitizeMarkdown：全篇正常时原样不动', () => {
  const good = '<viz-steps title="x"><viz-step title="a">A</viz-step></viz-steps>';
  assert.strictEqual(ed.sanitizeMarkdown(good), good);
});

ok('sanitizeMarkdown：一旦有写坏的组件，整篇剥掉标签但保留文字（宁可退化成纯文字也不露角括号）', () => {
  const s = ed.sanitizeMarkdown('<viz-steps title="x"><viz-step title="a">A</viz-step></viz-steps>\n<viz-bogus q="1"/>\n还有内容');
  assert.strictEqual(/<viz-/.test(s), false, s);
  assert.ok(s.indexOf('还有内容') >= 0 && s.indexOf('A') >= 0, s);
});

console.log('explaindoc: 逻辑骨架（推理链不能跳步）');

ok('缺「为什么」章节被拦下', () => {
  const v = ed.validate(GOOD.replace('## 为什么', '## 补充'), { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /思路|关键观察|算法/.test(e) || /为什么/.test(e)), JSON.stringify(v.errors));
});

ok('缺复杂度记号只提醒不拦（但章节必须在）', () => {
  const v = ed.validate(GOOD.replace('时间 $O(1)$，空间 $O(1)$。', '很快。').replace(/<viz-formula[^>]*\/>/, ''),
    { intent: 'full', level: 'L3', solCode: CODE });
  assert.ok(v.warnings.some((w) => /O\(\.\.\.\)/.test(w)), JSON.stringify(v.warnings));
});

ok('缺手算演示被拦下（这是"讲得清楚"的核心）', () => {
  const noHand = GOOD.replace(/## 手算演示[\s\S]*?## 算法/, '## 算法');
  const v = ed.validate(noHand, { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /手算演示/.test(e)), JSON.stringify(v.errors));
});

ok('"显然/易得"这类跳过推理的说法会累积成错误', () => {
  const lazy = GOOD.replace('因为输出要求就是 n；', '显然答案就是 n；易得不需要证明；不难发现这是唯一的做法；');
  const v = ed.validate(lazy, { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /推理跳跃/.test(e)), JSON.stringify(v.errors));
});

console.log('explaindoc: 代码保真与诚实口径');

ok('讲解里的代码与已验证代码不一致 → 拦下', () => {
  const v = ed.validate(GOOD.replace('cout << n << "\\n";', 'cout << n + 1 << "\\n";'), { intent: 'full', level: 'L3', solCode: CODE });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /与\*\*已验证的代码\*\*不一致/.test(e)), JSON.stringify(v.errors));
});

ok('只贴核心片段（大部分行重合）视为一致', () => {
  const partial = GOOD.replace('```cpp\n' + CODE + '\n```', '```cpp\n  int n; cin >> n;\n  cout << n << "\\n";\n```');
  const v = ed.validate(partial, { intent: 'full', level: 'L3', solCode: CODE });
  assert.ok(!v.errors.some((e) => /不一致/.test(e)), JSON.stringify(v.errors));
});

ok('验证未通过却声称已验证 → 拦下（诚实降级是底线）', () => {
  const v = ed.validate(GOOD + '\n以上代码已验证通过。', {
    intent: 'full', level: 'L3', solCode: CODE, verification: { status: 'unverified', reason: '未收敛' }
  });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /声称"已验证"/.test(e)), JSON.stringify(v.errors));
});

ok('代码评估意图：必须有根因 + 复杂度 + 修正代码', () => {
  const dbg = [
    '## 根因', '你把取最大值写成了取最小值。',
    '## 为什么', '你的输出是 3，正确是 5，差在第 2 个 0：它应该拿 3。',
    '## 复杂度分析', '修正后 $O(n\\log n)$。',
    '<viz-compare a="修正前" b="修正后">$O(n)$ 但错 || $O(n\\log n)$ 且正确</viz-compare>',
    '## 修正代码', '```cpp', CODE, '```'
  ].join('\n');
  const v = ed.validate(dbg, { intent: 'debug', level: 'L3', solCode: CODE, hasCounterexample: true });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

ok('代码评估：手里有反例却没引用 → 提醒', () => {
  const dbg = ['## 根因', '写错了。', '## 复杂度分析', '$O(n)$。', '<viz-compare a="A" b="B">x || y</viz-compare>', '## 修正代码', '```cpp', CODE, '```'].join('\n');
  const v = ed.validate(dbg, { intent: 'debug', level: 'L3', solCode: CODE, hasCounterexample: true });
  assert.ok(v.warnings.some((w) => /最小反例/.test(w)), JSON.stringify(v.warnings));
});

ok('诚实否定不算"假声称"：还没能验证通过 → 不拦（旧规则会把这种句子判成假声称，白跑一次重写调用）', () => {
  const honest = GOOD + '\n\n<viz-callout type="warn" title="先说明白：这题我还没能验证通过">下面的代码只在小规模数据上对拍过。</viz-callout>';
  const v = ed.validate(honest, { intent: 'full', level: 'L3', solCode: CODE, verification: { status: 'unverified', reason: '未收敛' } });
  assert.ok(!v.errors.some((e) => /声称"已验证"/.test(e)), JSON.stringify(v.errors));
});

ok('部分验证（status=ok 但 claimVerified=false）也不许写"已验证" → 拦下', () => {
  const v = ed.validate(GOOD + '\n以上代码已验证通过，可以直接提交。', {
    intent: 'full', level: 'L3', solCode: CODE,
    verification: { status: 'ok', claimVerified: false, scopeComplete: false, scopeNote: '对拍没跑满' }
  });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /声称"已验证"/.test(e)), JSON.stringify(v.errors));
});

ok('部分验证时讲解必须写清验证边界（P2 徽章）→ 没写就拦下', () => {
  const v = ed.validate(GOOD, {
    intent: 'full', level: 'L3', solCode: CODE,
    verification: { status: 'ok', claimVerified: false, scopeComplete: false }
  });
  assert.ok(v.errors.some((e) => /验证口径/.test(e)), JSON.stringify(v.errors));
});

ok('部分验证 + 写清了边界与"不要把这份代码当作已验证" → 通过', () => {
  const doc = GOOD + '\n\n## 验证情况\n这题只做到**部分验证**：暴力解在规模档 50 撑不住，对拍没跑满；'
    + '请不要把这份代码当作"已验证正确"的解法。';
  const v = ed.validate(doc, {
    intent: 'full', level: 'L3', solCode: CODE,
    verification: { status: 'ok', claimVerified: false, scopeComplete: false }
  });
  assert.ok(!v.errors.some((e) => /声称|验证口径/.test(e)), JSON.stringify(v.errors));
});

ok('claimWordHits：否定语境算 hedge，孤立结论不算', () => {
  assert.ok(ed.claimWordHits('这题我还没能验证通过').every((h) => h.hedged));
  assert.ok(ed.claimWordHits('不能声称已对拍通过').every((h) => h.hedged));
  assert.ok(ed.claimWordHits('以上代码已验证通过。').every((h) => !h.hedged));
});

console.log('\nexplaindoc: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
