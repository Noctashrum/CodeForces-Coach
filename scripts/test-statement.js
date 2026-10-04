'use strict';
/**
 * 题面整理 + 信息卡纪律 的单测。
 *
 * 两个都来自真实事故：
 *  ① 粘贴题面（非标准格式）→ 契约只抽出 13 字、样例 0 组 → "没标尺不开测" → 整条链路塌掉（agentCalls=3）；
 *  ② 信息卡把"教练给出的题解"算成学员的成果、把单轮实现细节写进 strengths（"本次…写成了前缀条件"）。
 */
const assert = require('assert');
const st = require('../lib/statement');
const pf = require('../lib/profile');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

/* 事故现场：用户粘贴的 2174A（`**输入**` 写在句子结尾、样例夹在正文里） */
const PASTED = [
  '给你一个数组 $$$a$$$ ，它由数字 $$$1$$$ ， $$$2$$$ 和 $$$3$$$ 组成。检查是否可以将它分成三个**连续的非空**部分。',
  '例如，数组 $$$[2, 1, 1, 3, 3, 1, 2, 3]$$$ 可以分成三部分。**输入**',
  '',
  '每个测试包含多个测试用例。第一行包含测试用例的数量 $$$t$$$ 。',
  '每个测试用例的第一行都包含一个整数 $$$n$$$ 。**输出**',
  '',
  '对于每个测试用例，如果存在按要求分割数组的方法，则打印 "是"，否则打印 "否"。',
  '',
  '样例输入',
  '2',
  '4',
  '1 3 3 2',
  '3',
  '1 3 1',
  '',
  '样例输出',
  'NO',
  'YES'
].join('\n');

console.log('statement: 格式判断（决定要不要派整理 Agent）');

ok('CF 取题那种标准题面 → 判为标准，不派整理 Agent', () => {
  const s = '背景故事。\n\n输入格式\n第一行一个整数 n。\n\n输出格式\n输出一个整数。\n\n样例输入\n3\n1 2 3\n\n样例输出\n6';
  const r = st.looksStandard(s, [{ input: '3\n1 2 3', output: '6' }]);
  assert.strictEqual(r.standard, true, JSON.stringify(r));
});

ok('粘贴的自由文本（缺输出格式段）→ 判为非标准', () => {
  // 直接删掉带「输出」标记的那一行，构造真正的"缺输出格式段"
  const noOutput = PASTED.split('\n').filter((l) => l.indexOf('**输出**') < 0).join('\n');
  const r = st.looksStandard(noOutput, []);
  assert.strictEqual(r.standard, false, JSON.stringify(r));
  assert.ok(r.reasons.some((x) => /输出格式/.test(x)), r.reasons);
});

ok('有输入/输出段但没有可解析的样例 → 仍判非标准（流水线要有样例才能校准）', () => {
  const s = '背景。\n\n输入格式\n第一行一个整数 n。\n\n输出格式\n输出一个整数。';
  const r = st.looksStandard(s, []);
  assert.strictEqual(r.hasInput, true);
  assert.strictEqual(r.hasOutput, true);
  assert.strictEqual(r.standard, false);
  assert.ok(r.reasons.some((x) => /样例/.test(x)), r.reasons);
});

ok('文本里的样例能被机械抽出来时 → 视为有样例（不用为此跑整理 Agent）', () => {
  const r = st.looksStandard(PASTED, []);
  assert.strictEqual(r.hasSamples, true, JSON.stringify(r));
  assert.ok(r.mechanicalSamples.length >= 1, JSON.stringify(r.mechanicalSamples));
});

ok('有样例数组但题面缺段落标记 → 仍然非标准（还要整理）', () => {
  const r = st.looksStandard('随便一段话，没有分段。', [{ input: '1', output: '1' }]);
  assert.strictEqual(r.hasSamples, true);
  assert.strictEqual(r.standard, false);
});

console.log('statement: 机械样例抽取（整理 Agent 失败时的兜底）');

ok('能从粘贴文本里抽出「样例输入/样例输出」对', () => {
  const s = st.extractSamples(PASTED);
  assert.ok(s.length >= 1, JSON.stringify(s));
  assert.ok(s[0].input.indexOf('1 3 3 2') >= 0, s[0].input);
  assert.ok(/NO/.test(s[0].output), s[0].output);
});

ok('多组样例各归各（不把后一组吞进前一组）', () => {
  const s = st.extractSamples('样例输入\n1\n1\n样例输出\n1\n样例输入\n2\n2 2\n样例输出\n2 2');
  assert.strictEqual(s.length, 2, JSON.stringify(s));
  assert.strictEqual(s[1].input.trim(), '2\n2 2');
});

ok('带编号的多组样例 + 结尾「说明」段：第 1 组输出不许吞掉后面几组', () => {
  const s = st.extractSamples([
    '输入格式', '一行两个整数 a 和 b。', '输出格式', '输出 a+b。',
    '样例输入 1', '1 2', '', '样例输出 1', '3', '',
    '样例输入 2', '7 5', '', '样例输出 2', '12', '',
    '说明', '本题样例由自己编的，请勿当成 CF 原题。'
  ].join('\n'));
  assert.strictEqual(s.length, 2, JSON.stringify(s));
  assert.strictEqual(s[0].output.trim(), '3', JSON.stringify(s[0]));
  assert.strictEqual(s[1].input.trim(), '7 5');
  assert.strictEqual(s[1].output.trim(), '12');
});

console.log('statement: 整理结果校验（宁可失败走兜底，也不喂编造的样例）');

const GOOD_NORM = {
  title: 'T', body: '给定一个长度为 n 的数组 a，你要判断它是否能被分成三个连续的非空部分，并且每一部分都满足题目给出的那个条件；注意元素个数与元素取值范围都以题面为准，不要额外补条件。',
  inputFormat: '第一行 t。', outputFormat: '每行 YES/NO。',
  samples: [{ input: '1\n3\n1 2 3', output: 'YES' }], guarantees: ['n ≤ 2·10^5']
};

ok('合格整理结果通过', () => {
  const v = st.validateNormalized(GOOD_NORM);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  assert.strictEqual(v.samples.length, 1);
});

ok('正文过短 / 缺格式段 → 判失败（不拿半道题硬跑）', () => {
  assert.strictEqual(st.validateNormalized({ body: '太短', inputFormat: 'x', outputFormat: 'y' }).ok, false);
  assert.strictEqual(st.validateNormalized(Object.assign({}, GOOD_NORM, { inputFormat: '' })).ok, false);
  assert.strictEqual(st.validateNormalized(Object.assign({}, GOOD_NORM, { outputFormat: '' })).ok, false);
});

ok('整理结果渲染成标准形状（下游切片才能机械解析）', () => {
  const text = st.buildStandardStatement(GOOD_NORM);
  assert.ok(/输入格式\n/.test(text) && /输出格式\n/.test(text), text);
  assert.ok(/数据范围与保证/.test(text));
  // 关键：渲染后必须能被契约抽取认出（否则下游还是塌）
  const harness = require('../lib/harness');
  const c = harness.extractContract(text);
  assert.ok(c.inputSpec.indexOf('第一行 t') >= 0, c.inputSpec);
  assert.ok(c.outputSpec.indexOf('YES/NO') >= 0, c.outputSpec);
  const ws = harness.statementWithoutSamples(text);
  assert.strictEqual(ws.stripped, false);   // 标准形状里没有样例段
});

ok('行内加粗的段落标记（**输入** 写在句子结尾）也能被契约抽取认出来', () => {
  const harness = require('../lib/harness');
  const c = harness.extractContract(PASTED);
  assert.ok(c.inputSpec.indexOf('每个测试包含多个测试用例') >= 0, JSON.stringify(c.inputSpec));
  assert.ok(c.outputSpec.indexOf('打印 "是"') >= 0, JSON.stringify(c.outputSpec));
  assert.ok(c.inputSpec.indexOf('样例输入') < 0, '输入段不该吞掉样例段');
});

console.log('profile: 证据闸门（没有学员侧证据就不更新）');

ok('只贴了个题号：没有学员侧证据 → 直接跳过', () => {
  const ev = pf.collectEvidence({ intent: 'full', userText: 'CF 1800C 讲解一下', userCode: '' });
  assert.strictEqual(ev.ok, false, JSON.stringify(ev));
});

ok('问教练自己代码的细节（"第 12 行为什么这么写"）→ 不算证据（否则就是"屁大点事都记"）', () => {
  const ev = pf.collectEvidence({ intent: 'full', userText: '第 12 行为什么这么写？', userCode: '' });
  assert.strictEqual(ev.ok, false, JSON.stringify(ev));
});

ok('"给我点思路"这类请求 → 不算证据', () => {
  const ev = pf.collectEvidence({ intent: 'hint', userText: 'CF 1800C 给我点思路', userCode: '' });
  assert.strictEqual(ev.ok, false, JSON.stringify(ev));
});

ok('聊到自己的困难/提的做法 → 算证据', () => {
  const a = pf.collectEvidence({ intent: 'debug', userText: '这题用 Floyd 能写吗', userCode: '' });
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  const b = pf.collectEvidence({ intent: 'debug', userText: '我一直搞不懂状态定义', userCode: '' });
  assert.strictEqual(b.ok, true, JSON.stringify(b));
});

ok('学员贴了自己的代码 → 算证据（并带上对拍结论）', () => {
  const ev = pf.collectEvidence({
    intent: 'debug', userText: '我的代码为什么 WA？', userCode: 'x'.repeat(80),
    minimalCase: { input: '1\n3\n1 2 3', from: 'user-vs-brute' }, lang: 'cpp'
  });
  assert.strictEqual(ev.ok, true);
  assert.ok(ev.kinds.indexOf('user-code') >= 0);
  assert.ok(/存在反例/.test(ev.evidence.join('')), ev.evidence.join(''));
});

ok('题目难度明显偏离他的水平 → 算证据', () => {
  const ev = pf.collectEvidence({ intent: 'full', userText: '讲讲', problemMeta: { rating: 1900 }, cfAvgSolvedRating: 950 });
  assert.ok(ev.kinds.indexOf('difficulty-gap') >= 0, JSON.stringify(ev));
});

console.log('profile: 幻觉守卫（单轮事件 / 教练产出不许进卡）');

ok('把教练的题解算成学员成果 → 拒收', () => {
  const r = pf.validateCardUpdate({
    profileText: '学员整体不错。',
    strengths: ['题解写得很好'], weaknesses: [], focus: []
  }, {});
  assert.ok(r.rejected.some((x) => /教练的产出/.test(x.why)), JSON.stringify(r.rejected));
});

ok('单轮事件（"本次/这一轮"）→ 拒收', () => {
  const r = pf.validateCardUpdate({ strengths: ['本次分割思路清晰'], weaknesses: ['这一轮边界没处理'], focus: [] }, {});
  assert.strictEqual(r.ok, false, JSON.stringify(r));   // 全被拒 → 整次更新作废
});

ok('单轮实现细节（"把 X 写成了 Y"）→ 拒收', () => {
  const r = pf.validateCardUpdate({ weaknesses: ['把前缀写成区间'], strengths: [], focus: [] }, {});
  assert.ok(r.rejected.some((x) => /实现细节/.test(x.why)), JSON.stringify(r.rejected));
});

ok('过长的句子（在讲一件事而不是一个特征）→ 拒收', () => {
  const r = pf.validateCardUpdate({ strengths: ['他能很快地把题目里的条件转化成可执行的判定逻辑'], weaknesses: [], focus: [] }, { cur: 1 });
  assert.ok(r.rejected.some((x) => /过长/.test(x.why)), JSON.stringify(r.rejected));
});

ok('宏观特征 → 收下，并且保持旧卡（合并而非堆叠）', () => {
  const cur = { profileText: '旧画像', strengths: ['贪心实现稳'], weaknesses: ['状态定义偏弱'], focus: ['多讲转移'] };
  const r = pf.validateCardUpdate({
    profileText: '当前 1200 分，贪心与构造扎实，DP 状态定义仍需打磨。',
    strengths: ['贪心实现稳', '构造直觉好'], weaknesses: ['状态定义偏弱'], focus: ['多讲转移', '补 DP 例题']
  }, cur);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.card.strengths, ['贪心实现稳', '构造直觉好']);
  assert.strictEqual(r.card.focus.length, 2);
  assert.ok(/DP 状态定义/.test(r.card.profileText));
});

ok('画像正文里混入单轮细节 → 退回旧画像正文', () => {
  const r = pf.validateCardUpdate({
    profileText: '学员本次把前缀条件写错了。',
    strengths: ['贪心实现稳'], weaknesses: [], focus: []
  }, { profileText: '旧画像' });
  assert.strictEqual(r.card.profileText, '旧画像', r.card.profileText);
  assert.ok(r.rejected.some((x) => x.kind === 'profileText'), JSON.stringify(r.rejected));
});

console.log('profile: 分析师提示词纪律');

ok('系统提示词明确禁止把教练产出当学员能力、禁止单轮事件', () => {
  assert.ok(/绝不.*把教练给出的题解/.test(pf.ANALYST_SYSTEM), pf.ANALYST_SYSTEM.slice(0, 120));
  assert.ok(/不写单轮事件/.test(pf.ANALYST_SYSTEM));
  assert.ok(/≤4 条/.test(pf.ANALYST_SYSTEM));
});

ok('条目上限受控（优势 ≤4 / 短板 ≤4 / 重点 ≤3）', () => {
  const many = (n, base) => Array.from({ length: n }, (_, i) => base + (i + 1));
  const r = pf.validateCardUpdate({
    strengths: many(9, '优势'), weaknesses: many(9, '短板'), focus: many(9, '重点')
  }, {});
  assert.ok(r.card.strengths.length <= 4 && r.card.weaknesses.length <= 4 && r.card.focus.length <= 3, JSON.stringify(r.card));
});

console.log('\nstatement+profile: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
