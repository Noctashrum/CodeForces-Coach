'use strict';
/**
 * 反「标尺投机」：机械识别 打表 / 硬编码样例答案 / 假生成器。
 *
 * 为什么必须有这一层：**官方样例只能证明格式，不能证明正确性**。
 * 把样例答案硬编码进代码（`if (n == 6) ans = "010100";`）就能轻松骗过"样例全过"这一关；
 * 而暴力解一旦这样通过，对拍就退化成"拿骗子当裁判"——正确的题解反而会被反复"修正"，永不收敛。
 *
 * 设计原则：只报有确凿证据的（宁可漏报，不可误报）——
 * 误报会把一份正确实现打回重写，代价远高于漏报。
 */

/** 常见判词：太短、且合法代码里本来就会出现，绝不能当"打表证据" */
const VERDICT_WORD = /^(yes|no|true|false|possible|impossible|none|null|nil|ok|win|lose|first|second|-1|0|1|2)$/i;

function normText(s) {
  return String(s == null ? '' : s).replace(/\r/g, '').trim();
}

/** 空白归一：用于比较"两份输入是不是同一份数据" */
function normWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从官方样例输出里挑出"足以当证据"的字面量。
 * 规则：长度 ≥ 4、不是常见判词；纯数字要 ≥ 6 位（避免 60 / 1000 这类正常常量误伤）。
 */
function answerLiterals(samples) {
  const out = [];
  const seen = new Set();
  (samples || []).forEach(function (s, si) {
    const body = normText(s && s.output);
    if (!body) return;
    body.split(/\s+/).slice(0, 30).forEach(function (raw) {
      const t = raw.trim();
      if (t.length < 4 || VERDICT_WORD.test(t) || seen.has(t)) return;
      const numeric = /^\d+$/.test(t);
      if (numeric && t.length < 6) return;
      seen.add(t);
      out.push({ literal: t, sample: si + 1, numeric });
    });
  });
  return out;
}

/** 输出是不是"退化"的（空 / 全是同一个字符）——打表与按规模特判的典型指纹 */
function degenerateOutput(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, '');
  if (!t) return true;
  for (let i = 1; i < t.length; i++) if (t[i] !== t[0]) return false;
  return true;
}

/** 样例输出整体是否"有变化"（若样例本身就全是常量，退化判据失效，不能用它怀疑暴力解） */
function samplesHaveVariety(samples) {
  const outs = (samples || []).map((s) => normText(s && s.output)).filter(Boolean);
  if (outs.length < 2) return false;
  const nonDeg = outs.filter((o) => !degenerateOutput(o));
  return nonDeg.length >= 2 && new Set(outs).size >= 2;
}

/**
 * 静态扫描：代码里有没有官方样例答案的字面量 / 小尺寸特判链。
 * @returns {{blocked:boolean, hits:Array, signals:Object, reason:string}}
 */
function scanHardcoding(o) {
  const opt = o || {};
  const code = String(opt.code || '');
  const samples = opt.samples || [];
  const lits = answerLiterals(samples);
  const hits = [];

  lits.forEach(function (l) {
    const quoted = new RegExp('["\'`]' + esc(l.literal) + '["\'`]');
    if (quoted.test(code)) {
      hits.push({ kind: 'sample-literal', literal: l.literal, sample: l.sample });
      return;
    }
    if (l.numeric) {
      const bare = new RegExp('(^|[^0-9])' + esc(l.literal) + '([^0-9]|$)');
      if (bare.test(code)) hits.push({ kind: 'sample-number', literal: l.literal, sample: l.sample });
    }
  });

  // 小尺寸特判链：与"样例规模"逐一对应的 ==/!= 分支（只作为佐证，不单独定罪）
  const nums = new Set();
  const re = /(?:==|!=)\s*([1-9]\d?)\b/g;
  let m;
  while ((m = re.exec(code))) nums.add(Number(m[1]));
  const chain = [1, 2, 3, 4, 5, 6, 7, 8].filter((k) => nums.has(k)).length;

  const withDigit = hits.filter((h) => /\d/.test(h.literal)).length;
  // 定罪条件（保守）：① 命中的字面量含数字（"010100" 这种就是打表铁证）；
  // ② 命中 ≥ 2 个不同样例答案；③ 命中 1 个 + 同时存在小尺寸特判链。
  const blocked = withDigit > 0 || hits.length >= 2 || (hits.length >= 1 && chain >= 4);

  let reason = '';
  if (hits.length) {
    reason = '代码里出现了官方样例输出的字面量：'
      + hits.slice(0, 3).map((h) => '「' + h.literal + '」(样例 ' + h.sample + ')').join('、')
      + (chain >= 4 ? '，并伴随 ' + chain + ' 处小尺寸特判' : '');
    if (!blocked) reason += '（仅提示，未拦截）';
  }
  return { blocked, hits, signals: { sampleSizeChain: chain, literals: lits.length }, reason };
}

/**
 * 生成器体检：多次生成是否完全一样、是否直接吐出官方样例输入。
 * @param {{runs:string[], sampleInputs:string[]}} o
 */
function checkGenerator(o) {
  const opt = o || {};
  const runs = (opt.runs || []).map(normWs).filter(Boolean);
  const findings = [];
  if (runs.length >= 2 && new Set(runs).size === 1) {
    findings.push({ kind: 'gen-fixed', detail: '连续多次生成的数据完全相同（生成器没有引入随机性）' });
  }
  const sampleSet = new Set((opt.sampleInputs || []).map(normWs).filter(Boolean));
  const replay = runs.filter((r) => sampleSet.has(r));
  if (replay.length) {
    findings.push({ kind: 'gen-sample-replay', detail: '生成器输出与官方样例输入完全相同（直接吐样例，不是生成数据）' });
  }
  return { findings, blocked: findings.some((f) => f.kind === 'gen-sample-replay') };
}

/**
 * 题面里是否存在**跨变量约束**（和/积形式，例如 "a_i + a_j ≤ 10^9"、"Σn ≤ 2·10^5"、"product of ... at most"）。
 *
 * 为什么需要它：编排器会建议生成器把"数值"控制在小范围（好让穷举型暴力跑得动）。
 * 这对**单变量上界**永远安全（值变小只会更宽松），但遇到跨变量约束时，机械地"把数值压小"
 * 有可能把关系改坏（例如 a_i + a_j ≤ 1e9 这类约束下的相对大小、或"和恰好等于 S"的构造题）。
 * 所以：扫到这类约束就不强行压数值，只在结论里标注，把数值范围交回给生成器自己按契约决定。
 */
function hasCrossVarConstraint(contract) {
  const c = contract || {};
  const text = [String(c.inputSpec || ''), String(c.outputSpec || ''), (c.guarantees || []).join(' ')].join('\n');
  if (!text.trim()) return false;
  const cmp = '[≤≥<>=]|\\ble\\b|\\bge\\b|不超过|至多|至少|at most|no more than|less than|greater than|exceed|不超过';
  const cross = [
    /\bsum\b|Σ|\\sum|总和|之和|求和|的和/i,
    /\bproduct\b|乘积|之积|\\prod/i,
    /[a-z]_?\{?[ijkl1-9]\}?\s*\+\s*[a-z]_?\{?[ijkl1-9]\}?/i,   // a_i + a_j
    /[a-z]_?\{?[ijkl1-9]\}?\s*[*×]\s*[a-z]_?\{?[ijkl1-9]\}?/i, // a_i * a_j
    /所有.{0,6}(数|元素|值).{0,8}(之和|总和|的和)/
  ];
  const hasCmp = new RegExp(cmp, 'i').test(text);
  return cross.some((re) => re.test(text)) && hasCmp;
}

/**
 * 题面体检（机械）：题面残缺必须先声明假设，不能默不作声地猜。
 * @returns {string[]} 警告列表（空 = 正常）
 */
function statementWarnings(statement, samples, contract) {
  const s = String(statement || '');
  const list = (samples || []).filter((x) => x && x.input != null);
  const c = contract || {};
  const w = [];
  if (s.trim().length < 40) w.push('题面很短，可能只贴了片段');
  if (!String(c.inputSpec || '').trim()) w.push('题面里找不到「输入格式」段（I/O 契约只能从样例反推）');
  if (!String(c.outputSpec || '').trim()) w.push('题面里找不到「输出格式」段');
  if (!list.length) w.push('没有可用的官方样例（本次没有任何 ground truth）');
  else if (list.length === 1) w.push('只有 1 组官方样例，锚点很弱');
  const noOut = list.filter((x) => x.output == null || String(x.output).trim() === '').length;
  if (noOut) w.push('有 ' + noOut + ' 组样例没有给出输出（无法用它校准）');
  // 数据范围：CF 题面通常把范围写在 Input 段里（"1 ≤ n ≤ 2·10^5"），不是"保证..."句式；
  // 只有通篇看不到任何范围写法时才提示，避免每道题都误报。
  const rangeRe = /[≤≥]|\\le\b|\\ge\b|10\^|<[=]?\s*\d|>[=]?\s*\d|不超过|至多|至少|at most|no more than/i;
  const rangeText = String(c.inputSpec || '') + String(c.outputSpec || '')
    + (c.guarantees || []).join(' ') + s;
  if (!rangeRe.test(rangeText)) w.push('题面里看不到数据范围（复杂度无法对照，契约可能不完整）');
  return w;
}

/**
 * 常量化输出体检：同一档位上多组不同输入却给出完全相同的输出 → 疑似打表/特判。
 * @param {string[]} inputs 多组**不同**的输入
 * @param {string[]} outputs 对应的题解输出
 */
function checkConstantOutput(inputs, outputs) {
  const ins = (inputs || []).map(normWs).filter(Boolean);
  const outs = (outputs || []).map((x) => normWs(x)).filter((x) => x !== '');
  if (ins.length < 4 || outs.length !== ins.length) return { suspicious: false };
  if (new Set(ins).size < 4) return { suspicious: false };
  if (new Set(outs).size > 1) return { suspicious: false };
  // 全部输出相同，且这个常量本身就是某组样例答案 → 铁证
  return { suspicious: true, detail: '4 组不同输入下题解输出了完全相同的结果（疑似硬编码常量）', constant: outs[0] };
}

module.exports = {
  answerLiterals, scanHardcoding, checkGenerator, checkConstantOutput,
  hasCrossVarConstraint,
  statementWarnings, degenerateOutput, samplesHaveVariety, normWs, normText
};
