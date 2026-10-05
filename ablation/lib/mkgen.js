#!/usr/bin/env node
/**
 * ablation/lib/mkgen.js — 「我只贴 oracle，生成器我自己写」的那一步。
 *
 * 背景（用户 m04297 的原话）：人工消融测试时，每道题还要手写暴力标尺和随机数据生成器太累了；
 * 他愿意贴的只有 oracle（自己的 AC 题解）。所以这里用**一次模型调用**写生成器，
 * 然后**机械体检**它 —— 生成器写坏了对拍结论就是垃圾，不能只靠"模型说它写好了"。
 *
 * 体检（零 token，全部真跑代码）：
 *   ① 生成器能跑、有输出；
 *   ② 把生成的数据喂给 oracle，不崩不超时（崩了说明数据违反格式/范围）；
 *   ③ 报一下数据里最大的数值（大数值会让对拍很慢，用户可以自己判断）；
 *   ④ 连出 3 组，若**完全相同** → 警告（覆盖不了什么，对拍形同虚设）；
 *   ⑤ oracle 在同一输入上跑两次，若输出不同 → 警告（oracle 有随机/时间相关，会误报 WA）。
 *
 * 注意：生成器必须**不依赖 argv**也能跑 —— 测试台/判分走的是 runner.stressTest，
 * 那里调用生成器时既不给参数也不给 stdin（见 lib/runner.js:408-458）。
 */
'use strict';

const llm = require('../../lib/llm');
const runner = require('../../lib/runner');
const record = require('./record');

const SYSTEM = [
  '【数据生成器 Agent】你是竞赛题的**随机数据生成器**作者。给你一道题的题面，以及一位选手写的标准解（oracle，仅供你理解输入格式）。',
  '你写一个生成器，要求：',
  '1) 单个文件，**不读 stdin、不读命令行参数**（没有任何 argv 也必须能跑），直接打印出**一组**合法测试数据；',
  '2) 格式严格符合题面输入格式（行数、每行几个数；若题面是多测（t 组），也要照做）；',
  '3) 数据范围严格落在题面约束内（n、值域、保证条件都不能越界）；',
  '4) **小数据优先**：默认取小的 n 和小的数值（除非题面规定 n 至少多少），让对拍能快速跑很多组；单个数值尽量不超过 10^6；',
  '5) 输出只允许数据本身，不许有任何解释、提示、多余空行；',
  '6) 只输出一个代码块（```python 或 ```cpp），块外不要写任何解释。'
].join('\n');

function userPrompt(problem, statement, oracle) {
  const s = String(statement || '').trim();
  return [
    '题面：',
    s || ('（题面缺失）题目：' + (problem && (problem.title || problem.id) || '')),
    '',
    '标准解（oracle，' + (oracle.lang === 'python' ? 'Python' : 'C++') + '，仅供理解输入格式与规模）：',
    '```' + (oracle.lang === 'python' ? 'python' : 'cpp'),
    String(oracle.code || '').trim(),
    '```',
    '',
    '请输出生成器代码（一个代码块）。'
  ].join('\n');
}

/** 生成器语言：跟 oracle 保持一致（用户只贴 oracle，不额外选语言） */
function genLangFor(oracleLang) {
  return oracleLang === 'cpp' ? 'cpp' : 'python';
}

/** 解释器/编译器报的"代码本身就有问题"（与数据无关）的一类错 */
const CODE_ERROR = /SyntaxError|IndentationError|TabError|NameError|ModuleNotFoundError|ImportError|\berror:\s|\berror C\d|undefined reference|ld returned|cannot find -l/i;
const HINT_CODE = '看起来是代码本身的问题：① 粘贴时是不是整块带上了 ``` 围栏（去掉）；② 语言选对了吗（C++ 的题解选了 python，第一行就 SyntaxError）。';
const HINT_RUN = 'oracle 在官方样例上就跑不过，通常意味着这份代码不是这道题的正解，或者它期待的输入格式和题面不一样。';

/**
 * 题面里的"答案不唯一"表述（CF 的标准说法）→ 样例输出**不能**用精确比对来判 oracle 对不对。
 * 例：2241B 的题面原句 "If there are multiple valid answers, output any one of them."
 */
const SPECIAL_JUDGE = /(output|print)\s+any\s+(one\s+)?(of\s+them|answer|valid|correct)|any\s+(valid|correct)\s+answer|multiple\s+(valid\s+)?answers|several\s+(valid\s+)?answers|if\s+there\s+are\s+(several|multiple)|any\s+of\s+the\s+(following|answers)|special\s+judge|checker/i;

/** 这题是不是"输出任意合法答案"的多解题（只能靠题面判断） */
function looksSpecialJudge(text) {
  return SPECIAL_JUDGE.test(String(text || ''));
}

/**
 * oracle 先验：拿**官方样例**跑一遍，**并且比对样例输出**。
 *
 * 为什么要比对输出：能跑 ≠ 是对的。用户 m08171 的 pilot 里 2268A 那把 oracle
 * 只打印 (1<<(n-k+1)) + 2*(k-1)、完全不读数组 —— 它跑得动、不崩，于是
 * "生成的数据跑不动 oracle"这一关全过，判分却拿它当尺子，把两侧（实测都正确）判成 WA。
 * 样例输出一比对就现原形：官方样例期望 9/3/1/19，它给 10/8/2/20。
 *
 * 没有样例就跳过（返回 null），后面按"跑生成数据的结果"分类。
 * @param {object} arena
 * @param {Array} samples 官方样例 [{input,output}]
 * @param {string[]} warnings
 * @param {{statement?:string, specialJudge?:boolean}} [opts]
 */
async function oraclePreflight(arena, samples, warnings, opts) {
  const o = opts || {};
  const first = (Array.isArray(samples) ? samples : []).filter((s) => s && String(s.input == null ? '' : s.input).trim())[0];
  if (!first) return null;
  const sample = String(first.input);
  const r = await arena.run('sol', sample);
  if (r.timedOut || !r.ok) {
    const err = String(r.err || '').slice(0, 300);
    return {
      ok: false, status: 'oracle-broken', warnings, sample, maxNumber: 0, diverse: false, oracleStable: true,
      detail: 'oracle 在**官方样例**上就失败了，所以问题不在生成的数据：' + (r.timedOut ? '（超时）' : '') + err
        + '。' + (CODE_ERROR.test(err) ? HINT_CODE : HINT_RUN)
    };
  }
  const want = first.output == null ? '' : String(first.output);
  if (want.trim()) {
    const cmp = runner.compareOutputs(r.output, want);
    if (!cmp.ok) {
      if (o.specialJudge || looksSpecialJudge(o.statement)) {
        warnings.push('oracle 的输出和官方样例对不上，但题面允许输出任意合法答案（多解题）：样例关不能用来判它的对错');
        return null;
      }
      return {
        ok: false, status: 'oracle-broken', warnings, sample, maxNumber: 0, diverse: false, oracleStable: true,
        detail: 'oracle 在**官方样例**上给的答案不对（样例期望「' + want.trim().slice(0, 120) + '」，它给「'
          + String(r.output == null ? '' : r.output).trim().slice(0, 120) + '」）→ 它多半不是这道题的正解。' + HINT_RUN
      };
    }
  }
  return null;
}

/**
 * @param {object} o
 * @param {object} o.problem    题目对象（题号/标题）
 * @param {string} o.statement  题面正文
 * @param {{lang:string, code:string}} o.oracle 标准解
 * @param {object} o.target     { provider, model }
 * @param {object} [o.params]   { maxTokens }
 * @returns {Promise<{ok:boolean, error?:string, lang?:string, code?:string, gate?:object, usage?:object, calls?:number, ms?:number}>}
 */
async function makeGen(o) {
  const t0 = Date.now();
  const oracle = { lang: genLangFor(o.oracle && o.oracle.lang), code: String((o.oracle && o.oracle.code) || '').trim() };
  if (!oracle.code) return { ok: false, error: '没有 oracle 代码：先贴你自己的 AC 题解', ms: 0 };
  if (!o.target || !o.target.model) return { ok: false, error: '没有可用的模型（--base-url 或 data/config.json 的 providers 都没配）', ms: 0 };

  const res = await llm.callModel({
    provider: o.target.provider,
    model: o.target.model,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(o.problem, o.statement, oracle) }],
    maxTokens: (o.params && o.params.maxTokens) || undefined,
    stream: true
  });
  const text = String((res && res.content) || '');
  const got = record.extractFinalCode(text);
  if (!got || !got.code || !got.code.trim()) {
    return { ok: false, error: '模型没有给出可用的代码块', usage: res && res.usage, calls: 1, ms: Date.now() - t0 };
  }
  const lang = got.lang === 'cpp' || got.lang === 'c' ? 'cpp' : (got.lang === 'python' || got.lang === 'py' ? 'python' : oracle.lang);
  const code = got.code.trim();

  const gate = await gateGen({ gen: { lang, code }, oracle, samples: o.samples, statement: o.statement });
  return {
    ok: gate.ok,
    error: gate.ok ? undefined : gate.detail,
    lang, code, gate,
    usage: res && res.usage,
    calls: 1,
    ms: Date.now() - t0
  };
}

/**
 * 机械体检一份生成器。导出是为了让测试（selftest）能直接喂"坏生成器"验证它真的会拦。
 * @returns {Promise<{ok:boolean, status:string, detail:string, warnings:string[], sample:string, maxNumber:number, diverse:boolean, oracleStable:boolean}>}
 */
async function gateGen(o) {
  const warnings = [];
  const arena = await runner.openArena({ sol: o.oracle, brute: o.oracle, gen: o.gen });
  if (!arena.ok) return { ok: false, status: 'prepare', detail: '编译/落地失败：' + arena.error, warnings, sample: '', maxNumber: 0, diverse: false, oracleStable: true };
  try {
    const pre = await oraclePreflight(arena, o.samples, warnings, { statement: o.statement, specialJudge: o.specialJudge });
    if (pre) return pre;
    const cases = [];
    for (let i = 0; i < 4; i++) {
      // **故意不给任何 argv、也不给 stdin**：判分走 runner.stressTest，正是这么调生成器的
      // （见 lib/runner.js:408-458）。生成器必须自己就能产出一组数据。
      const g = await arena.run('gen', '', runner.RUN_TIMEOUT_MS);
      if (!g.ok || !String(g.output || '').trim()) {
        return {
          ok: false, status: 'gen', warnings, sample: '',
          detail: '生成器跑不动或没有输出（**不给任何命令行参数**也要能跑）' + (g.timedOut ? '：超时' : (g.err ? '：' + g.err : '')),
          maxNumber: 0, diverse: false, oracleStable: true
        };
      }
      cases.push(g.output);
    }
    const sample = cases[0];
    const maxNumber = arena.maxNumericToken(sample);
    const diverse = new Set(cases.map((c) => c.trim())).size > 1;
    if (!diverse) warnings.push('生成器每次都产出同一组数据：对拍覆盖面会很小（建议加随机）');
    if (maxNumber >= 1e9) warnings.push('数据里出现了 ' + maxNumber + ' 这种量级的数值：对拍会明显变慢');

    const a = await arena.run('sol', sample);
    if (a.timedOut || !a.ok) {
      const err = String(a.err || '');
      // 编译/语法错与数据无关：那是 oracle 自己的问题，得说清楚（否则用户会一直去改生成器）
      if (CODE_ERROR.test(err)) {
        return {
          ok: false, status: 'oracle-broken', warnings, sample, maxNumber, diverse, oracleStable: true,
          detail: 'oracle 自己跑不起来（和生成的数据无关）：' + err.slice(0, 300) + '。' + HINT_CODE
        };
      }
      return {
        ok: false, status: 'oracle', warnings, sample, maxNumber, diverse, oracleStable: true,
        detail: '生成的数据把你的 oracle 跑崩了' + (a.timedOut ? '（超时）' : '') + '：' + err.slice(0, 300)
          + '。多半是数据违反了输入格式或取值范围。'
      };
    }
    const b = await arena.run('sol', sample);
    const oracleStable = !(a.ok && b.ok) || runner.compareOutputs(a.output, b.output).ok;
    if (!oracleStable) warnings.push('oracle 在同一个输入上跑两次结果不同（随机/时间相关）：对拍会误报不一致');
    return { ok: true, status: 'ok', detail: '', warnings, sample: String(sample).slice(0, 800), maxNumber, diverse, oracleStable };
  } finally {
    try { await arena.close(); } catch { /* ignore */ }
  }
}

module.exports = { makeGen, gateGen, SYSTEM, userPrompt, genLangFor, looksSpecialJudge, oraclePreflight };
