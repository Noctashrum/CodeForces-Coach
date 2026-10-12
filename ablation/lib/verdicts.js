'use strict';

/**
 * 判词词表：三段口径（★AC / 判错 / **判不了**）的唯一真源。
 *
 * 为什么要有这个文件：报告（`.probe/full73-report.js`）、稳定性翻转表（`.probe/stability-flips.js`）、
 * 配对文档和任何读判词的东西都必须用**同一套**分类，否则两个文件各写一份列表、迟早对不上。
 * 真实事故（2026-10-10）：L1 的 `oracle-error-at-max` 没在词表里，于是它既不算判错也不算判不了，
 * 只让报告里的"其它"悄悄从 0 变成 1 —— 一行代码就把三段账算错了。
 *
 * 词表来源 = `ablation/lib/ruler.js` 里全部可能的 verdict。`ablation/selftest.js` 的第 ⑫ 节
 * 会对着 ruler.js 源码把每个判词字面量核一遍 ⇒ **给尺子加新判词却忘了登记，自测会红**。
 */

// 候选侧确实错/慢/没交：算"判错"
const WRONG_VERDICTS = [
  'sample-WA', 'sample-RE', 'sample-TLE',   // 官方样例关没过
  'diff-WA', 'diff-run-error',              // 差分对拍抓到的错
  'no-code',                                // 这一档没交付代码
  'slow', 'TLE', 'RE', 'WA-at-max',         // 最大规模 + 真实时限那一关
  'sol-compile-error'                       // R5：模型自己写的 sol 编译不过（原来混在 arena-error 里）
];

// 尺子/工程一侧没给出结论：算"判不了"（既不证明对、也不证明错）
const UNKNOWN_VERDICTS = [
  'diff-gen-weak', 'gen-weak', 'gen-weak-at-max',      // 生成器太弱（长不大）
  'gen-error-at-max',                                   // 生成器在最大档给不出数据
  'arena-error',                                        // R5 之前的"对拍台起不来"（含编译失败）
  'brute-compile-error', 'gen-compile-error',           // R5：尺子自己的文件编译不过
  'no-bruler', 'no-gen', 'no-oracle',                   // 材料缺失
  'oracle-run-error', 'oracle-error-at-max', 'oracle-over-tl-at-max',
  'special-judge', 'multi-answer'                       // 答案不唯一且没有可信 checker
];

// 压根没跑（题库里没有这题 / 没记录）：不算任何一档
const NORUN_VERDICTS = ['no-problem', 'none'];

const AC_VERDICTS = ['AC'];

/**
 * **样例级**状态（`samples.results[].verdict`，由 `lib/runner.js` 的 `runSamples` 产出）。
 * 尺子不会把它们当成最终判词（最终判词一律是 `sample-WA` / `diff-WA` / `WA-at-max` 这种形态），
 * 但它们确实以 `verdict: '…'` 的字面量出现在 `ablation/lib/ruler.js` 里（例如 :744 的
 * `|| { verdict: 'WA' }`）。所以自测第 ⑫ 节的"源码判词字面量全在词表里"核对要把它们算作已登记，
 * 否则每次都会报假漏网 —— 而假告警会让人把这条检查关掉，那才是真的失去保护。
 * 只列**不与上面三张表重复**的那些（`AC` 在 `AC_VERDICTS`、`RE`/`TLE` 在 `WRONG_VERDICTS` 里已有，
 * 重复登记会让"词表内部没有重复项"那条断言误报）。
 */
const SAMPLE_VERDICTS = ['WA', 'PE', 'OK', 'MLE', 'OLE'];

/**
 * R5：编译失败按"**谁的文件**"落判词。
 * `sol`（模型自己在流水线里写的候选代码）编译不过 ⇒ 候选侧失败（判错）；
 * `brute`（外部 AC 提交）/ `gen`（数据生成器）编译不过 ⇒ 尺子自己的文件坏了（判不了）。
 * 三个字面量只在这里出现，`ablation/lib/ruler.js` 通过 `compileVerdict(who)` 取 ——
 * 自测第 ⑫ 节会把 ruler.js 里的判词字面量反过来核一遍，所以这里才是唯一真源。
 */
const COMPILE_VERDICTS = {
  sol: 'sol-compile-error',
  brute: 'brute-compile-error',
  gen: 'gen-compile-error'
};

/**
 * @param {string} who 'sol' | 'brute' | 'gen'
 * @returns {string} 对应判词；认不出的一律回落老的 `arena-error`（判不了）
 */
function compileVerdict(who) {
  return COMPILE_VERDICTS[who] || 'arena-error';
}

/**
 * 三段口径分桶。
 * @param {string} v 判词字符串（配对表单元格如 `★AC`，或 verdicts 文件里的 `verdict`）
 * @param {boolean} [cfac] verdicts 文件里的 `cfac`（官方样例 + 差分 + 最大档全过）
 * @returns {'ac'|'wrong'|'unknown'|'norun'|'other'}
 */
function bucketOf(v, cfac) {
  const s = String(v == null ? '' : v).trim();
  if (cfac === true) return 'ac';
  if (/★/.test(s)) return 'ac';
  if (AC_VERDICTS.indexOf(s) >= 0) return 'ac';
  if (WRONG_VERDICTS.indexOf(s) >= 0) return 'wrong';
  if (UNKNOWN_VERDICTS.indexOf(s) >= 0) return 'unknown';
  if (NORUN_VERDICTS.indexOf(s) >= 0) return 'norun';
  return 'other';
}

/**
 * `arena-error` / `*-compile-error` 到底是谁的错。
 * `detail` 形如 `"sol：编译失败（退出码 1）"` ⇒ 那是模型自己在流水线里写的文件编译不过（候选侧失败）；
 * `brute` / `gen` 编译不过 = 尺子自己的文件坏了（判不了）。
 * R5 之后尺子直接给 `sol-compile-error` / `brute-compile-error` / `gen-compile-error`；
 * 老 store 里仍是 `arena-error` + detail ⇒ 两条路都认，报告口径不随尺子版本变。
 * @param {Map<string,object>|Array<object>} verdicts
 */
function classifyArena(verdicts) {
  const out = { sol: [], brute: [], gen: [], other: [] };
  const list = verdicts instanceof Map
    ? Array.from(verdicts.entries())
    : verdicts.map((o) => [String(o.problem), o]);
  for (const [id, o] of list) {
    const v = String(o.verdict || '');
    const byName = v.match(/^(sol|brute|gen)-compile-error$/);
    if (byName) { out[byName[1]].push(String(id)); continue; }
    if (v !== 'arena-error') continue;
    const m = String(o.detail || '').match(/(sol|brute|gen)\s*[：:]\s*编译失败/);
    if (m) out[m[1]].push(String(id));
    else out.other.push(String(id));
  }
  return out;
}

module.exports = {
  WRONG_VERDICTS,
  UNKNOWN_VERDICTS,
  NORUN_VERDICTS,
  AC_VERDICTS,
  SAMPLE_VERDICTS,
  COMPILE_VERDICTS,
  compileVerdict,
  bucketOf,
  classifyArena
};
