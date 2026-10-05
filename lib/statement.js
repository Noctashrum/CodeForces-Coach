'use strict';
/**
 * statement.js — 题面"是不是标准格式"的机械判断 + 非标准题面的整理。
 *
 * 为什么需要：CF 取题走的是官方页面解析，题面正文与样例是**分开**的结构化数据；
 * 而用户粘贴的题面是一坨自由文本（`**输入**` 可能写在句子结尾、样例夹在正文里、没有显式输出格式段）。
 * 这类题面若直接进流水线：契约切不出格式段、样例为 0 组 → "没有标尺就不开测" → 整条验证链塌掉，
 * 尽管题面里可能明明白白带着十几组样例。
 *
 * 所以：先机械判断"是否标准"，不标准就派一个**题面整理 Agent**把它整理成标准形状
 * （正文 / 输入格式 / 输出格式 / 数据保证 / 样例），再进正常流水线。
 * 整理 Agent 的最高纪律：**只做搬运与结构化，不许改写题意、不许自己算样例答案**。
 */

/**
 * 段落标记：必须是**真锚点**（独立成行 / 加粗成节 / 标题），否则会误匹配正文里的普通词。
 * 注意量词不能写成 `\*{0,2}`：它允许 0 次，等于锚点失效 → "样例输出" 里的"输出"会被当成输出格式段标记。
 */
const HEAD = '(?:\\*{2}|#{1,4}[ \\t]*|(?:^|\\n)[ \\t]*)';
const MARK = {
  input: new RegExp(HEAD + '(?:Input(?:\\s*format)?|输入格式|输入描述|输入)\\*{0,2}[ \\t]*[:：]?[ \\t]*(?=\\n|$)', 'i'),
  output: new RegExp(HEAD + '(?:Output(?:\\s*format)?|输出格式|输出描述|输出)\\*{0,2}[ \\t]*[:：]?[ \\t]*(?=\\n|$)', 'i'),
  sampleHead: /(?:^|\n)[ \t]*(?:[#>*\-\s]{0,4})(?:Examples?[ \t]*[0-9]*|Samples?(?:[ \t]*(?:[0-9]+|Input|Output|Tests?))*|(?:输入|输出)?样例(?:[ \t]*(?:输入|输出|样例|[0-9]+))*|(?:输入|输出)?示例(?:[ \t]*(?:输入|输出|示例|[0-9]+))*|输入输出样例|输入输出示例)[ \t]*(?::|：)?[ \t]*(?=\n|$)/i
};

/**
 * 多解题（special judge）的机械识别 —— **判据的判据**。
 *
 * 为什么必须有：这类题的官方样例只给出**一个**合法答案，真正的判题靠 checker 判"是不是合法答案"。
 * 用"字面比对样例输出"去判它，会把**完全正确的解**判成 WA。实证（2026-10 消融报告，2241B）：
 * 外部 AC 标程、L0、L2 四方全被判"样例 WA"，链条随后烧掉 20 分钟去"修"一份本来正确的题解，
 * 最后交白卷（2267B 同型：1209s 烧穿 20 分钟上限、0 字节交付）。
 *
 * 纪律：宁可漏判（漏判 = 维持现状）也**不可误判** —— 把一个正常题当成多解题，等于关掉它的验证。
 * 所以：① 只认与"输出任意合法答案"直接相关的表述；② 命中点附近若有**明确打破平局**的规则
 * （字典序最小 / 答案唯一），说明字面比对仍然成立 → 判为正常题。
 */
const SPECIAL_JUDGE = /(?:output|print)\s+any\b|any\s+(?:valid|correct)\s+answer|(?:multiple|several)\s+(?:valid\s+|correct\s+|optimal\s+|possible\s+)?answers|if\s+there\s+are\s+(?:several|multiple)|any\s+of\s+the\s+(?:following|answers)|in\s+any\s+order|special\s+judge|(?:output|print|give)[^.\n]{0,24}?(?:in\s+any\s+order|任意|任何)|多解|答案不唯一|多种合法/i;
/** 明确打破平局的规则：命中它就说明"输出是唯一的"（哪怕题面里有 multiple answers 的字样） */
const TIE_BREAK = /lexicographically|字典序|答案(?:是|为)?唯一|the\s+answer\s+is\s+unique|output\s+the\s+(?:smallest|largest|minimum|maximum)/i;

/** 这题是不是"输出任意合法答案"的多解题（只能靠题面判断） */
function looksSpecialJudge(text) {
  const s = String(text || '');
  if (!s) return false;
  const m = SPECIAL_JUDGE.exec(s);
  if (!m) return false;
  const near = s.slice(Math.max(0, m.index - 200), m.index + 200);
  if (TIE_BREAK.test(near)) return false;
  return true;
}

/**
 * 机械判断题面是否"标准格式"。
 * @returns {{standard:boolean, hasInput:boolean, hasOutput:boolean, hasSamples:boolean, reasons:string[]}}
 */
function looksStandard(text, samples) {
  const s = String(text || '').replace(/\r/g, '');
  const list = (samples || []).filter((x) => x && x.input != null && String(x.input).trim() !== '');
  const hasInput = MARK.input.test(s);
  const hasOutput = MARK.output.test(s);
  // "有样例"必须是**能拿到手的结构化样例**：文本里出现"样例输入"字样但抽不出数据，
  // 对流水线来说等于没有样例（没标尺就不开测，链条会断在这里）
  const mech = list.length ? [] : extractSamples(s);
  const hasSamples = list.length > 0 || mech.length > 0;
  const reasons = [];
  if (!hasInput) reasons.push('题面里找不到「输入格式」段');
  if (!hasOutput) reasons.push('题面里找不到「输出格式」段');
  if (!hasSamples) reasons.push('题面里找不到可解析的样例（输入/输出对）');
  // 标准 = 有输入/输出格式段 + 至少一组可解析样例；缺任何一项都交给整理 Agent
  return { standard: hasInput && hasOutput && hasSamples, hasInput, hasOutput, hasSamples, reasons, mechanicalSamples: mech };
}

/**
 * 把一段文本按"样例输入/样例输出"这类标记切成若干组（机械兜底用）。
 *
 * ⚠️ 血泪教训（2026-10 事故，系统性污染 5 道题）：CF 题面的**格式段标题就是裸的 `Input` / `Output` 两行**，
 *    它们与"样例"的标记长得一模一样。一旦把它们当成样例锚点，就会把
 *    "输入格式段正文 / 输出格式段正文" 配成第 1 组样例 —— 这组假样例会把**正确的题解**判成"样例不过"，
 *    于是 `sol-samples-fail` → 暴力解也跟着栽 → `no-bruler` → 整条验证链塌掉（2258B1/B2、2258E、2259E、2260F 全中）。
 *    所以：裸的 `Input`/`Output`/`输入`/`输出` 必须落在**样例段标题之后**才算锚点；
 *    显式样本标签（样例输入 / 示例输出 / Sample Input）与带编号的（输入 1 / Input 2）不受此限。
 * 纪律：宁可返回 0 组（让上游如实说"没有可解析样例"），也绝不返回一组假样例。
 */
function extractSamples(text) {
  const s = String(text || '').replace(/\r/g, '');
  // 先扫出所有标记（输入侧/输出侧），再按顺序配对：输入标记 → 下一个输出标记 → 下一组输入标记为止
  const markRe = /(?:^|\n)[ \t]*(?:[#>*\-\s]{0,4})(样例输入|输入样例|输入\s*#?\d+|Sample\s*Input|Input|样例输出|输出样例|输出\s*#?\d+|Sample\s*Output|Output)[ \t]*([0-9]*)[ \t]*[:：]?[ \t]*(?=\n|$)/gi;
  const headM = MARK.sampleHead.exec(s);
  const sampleHeadAt = headM ? headM.index : null;
  const marks = [];
  let m;
  while ((m = markRe.exec(s)) !== null) {
    const raw = String(m[1] || '');
    const label = raw.toLowerCase();
    const kind = /输出|output/.test(label) ? 'out' : 'in';
    const explicit = /样例|示例|sample/.test(label);          // 显式样本标签，不会与格式段标题撞车
    const numbered = /[0-9]/.test(raw + String(m[2] || ''));  // "输入 1"/"Input 2"：只有样例才编号
    if (!explicit && !numbered && !(sampleHeadAt != null && m.index > sampleHeadAt)) continue;
    marks.push({ kind, at: m.index, end: m.index + m[0].length });
  }
  const stopRe = /(?:^|\n)[ \t]*(?:[#>*\-\s]{0,4})(说明|提示|注意|Note|Notes|Hints?|Examples?|数据范围|Constraints?)[ \t]*(?::|：)?[ \t]*(?=\n|$)/i;
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].kind !== 'in') continue;
    const next = marks[i + 1];
    if (!next || next.kind !== 'out') continue;          // 输入后面没有输出标记 → 不配对
    const after = marks[i + 2] ? marks[i + 2].at : s.length;
    const stop = s.slice(next.end).match(stopRe);
    // ⚠️ 截断要取"更早的那个"：下一组样例标记 vs 说明/Note 段。
    //    只按 stopRe 截会把后面几组样例一起吞进第 1 组的输出里（多组样例 + 结尾"说明"的题面必踩），
    //    样例错了 → 验证链会把**正确答案**判成"样例不过"，正好踩在"不许把对的改坏"上。
    const stopAt = stop && stop.index != null ? next.end + stop.index : null;
    const outEnd = stopAt != null ? Math.min(stopAt, after) : after;
    out.push({
      input: tidy(s.slice(marks[i].end, next.at)),
      output: tidy(s.slice(next.end, outEnd))
    });
    if (out.length >= 8) break;
  }
  return out.filter((x) => x.input || x.output);
}

function tidy(s) {
  return String(s == null ? '' : s)
    .replace(/^[ \t]*[:：][ \t]*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 把整理结果渲染成"标准形状"的题面文本。
 * 这样下游（契约切片 / 样例剥离 / 各 Agent）完全不用改：它们只认标准形状。
 */
function buildStandardStatement(o) {
  const opt = o || {};
  const parts = [];
  if (opt.title) parts.push('# ' + String(opt.title).trim());
  parts.push(String(opt.body || '').trim());
  if (String(opt.inputFormat || '').trim()) parts.push('输入格式\n' + String(opt.inputFormat).trim());
  if (String(opt.outputFormat || '').trim()) parts.push('输出格式\n' + String(opt.outputFormat).trim());
  const g = (opt.guarantees || []).filter((x) => String(x || '').trim());
  if (g.length) parts.push('数据范围与保证\n' + g.map((x) => '- ' + String(x).trim()).join('\n'));
  if ((opt.assumptions || []).length) {
    parts.push('【以下为整理时推断的假设（原题面未明说）】\n' + opt.assumptions.map((x) => '- ' + String(x).trim()).join('\n'));
  }
  return parts.filter((x) => String(x).trim()).join('\n\n');
}

/** 校验整理 Agent 的产出：宁可判失败走机械兜底，也不能把编造的样例喂给对拍 */
function validateNormalized(j) {
  const errors = [];
  if (!j || typeof j !== 'object') return { ok: false, errors: ['整理结果不是 JSON 对象'] };
  const body = String(j.body || '').trim();
  const inputFormat = String(j.inputFormat || '').trim();
  const outputFormat = String(j.outputFormat || '').trim();
  if (body.length < 40) errors.push('正文过短（整理后正文少于 40 字，疑似把题面丢了）');
  if (!inputFormat) errors.push('没有给出输入格式段');
  if (!outputFormat) errors.push('没有给出输出格式段');
  const samples = (Array.isArray(j.samples) ? j.samples : []).filter((s) => s && String(s.input || '').trim() !== '');
  return { ok: errors.length === 0, errors, samples: samples.slice(0, 8) };
}

/** 题面整理 Agent 的系统提示词（纪律优先：只搬运，不改写，不算答案） */
const NORMALIZE_SYSTEM = [
  '你是【题面整理 Agent】。用户粘贴了一段题面（格式很乱：可能没有分段、样例夹在正文里、公式用了 $$$ 或 $）。',
  '你的任务：把它**整理成标准结构**，供后续的自动化验证使用。',
  '',
  '【最高纪律（违反即失败）】',
  '1. **不许改写题意**：正文、数据范围、保证条件都要**原样搬运**（可以调整分段与 Markdown 格式，不要"顺手补全"你没看到的条件）；',
  '2. **不许自己计算样例答案**：样例输出必须**原样抄录**题面里给出的内容。如果题面只给了输入没给输出，就留空并在 assumptions 里说明；',
  '3. **不确定的写进 assumptions**，不要猜进正文（例如"输入格式未明确给出，按样例推断为：第一行 t…"）；',
  '4. 公式保留 LaTeX（把 $$$x$$$ 规范成 $x$），不要翻译成文字描述。',
  '',
  '只输出一个 JSON 对象，不要任何其它文字：',
  '{"title":"题目标题（没有就给一句话概括，别编比赛编号）",',
  ' "body":"题面正文：背景 + 任务 + 限制条件（**不含**输入格式段/输出格式段/样例段）",',
  ' "inputFormat":"输入格式段（逐行说明：第一行是什么、每个测试用例几行）",',
  ' "outputFormat":"输出格式段（每行输出什么、多测怎么输出、大小写要求）",',
  ' "guarantees":["数据范围与保证（如 1 ≤ t ≤ 10^4、n 之和 ≤ 2·10^5）"],',
  ' "samples":[{"input":"样例输入原文","output":"样例输出原文"}],',
  ' "assumptions":["哪些内容是你从样例/上下文推断出来的"]}'
].join('\n');

/** 调用整理 Agent（失败返回 null，调用方回落到机械兜底） */
async function normalizeWithAgent(o) {
  const opt = o || {};
  if (typeof opt.callAgent !== 'function') return null;
  try {
    const text = await opt.callAgent({
      role: 'normalize',
      system: NORMALIZE_SYSTEM,
      user: '【用户粘贴的原始内容】\n' + String(opt.text || '').slice(0, 12000)
        + (opt.mechanicalSamples && opt.mechanicalSamples.length
          ? '\n\n【机械解析出的样例（供你校对；如与原文不符以原文为准）】\n'
            + opt.mechanicalSamples.map((s, i) => '样例 ' + (i + 1) + ' 输入：' + String(s.input).slice(0, 400)
              + '\n样例 ' + (i + 1) + ' 输出：' + String(s.output).slice(0, 400)).join('\n')
          : ''),
      stream: false
    });
    const j = typeof opt.parseJson === 'function' ? opt.parseJson(text) : null;
    const v = validateNormalized(j);
    if (!v.ok) return { ok: false, errors: v.errors, raw: j };
    return { ok: true, data: j, samples: v.samples };
  } catch (e) {
    return { ok: false, errors: [String((e && e.message) || e)] };
  }
}

/**
 * 假样例识别：这个"样例"其实是题面的**格式段散文**，不是数据。
 *
 * 血泪教训（2026-10 另一台机器整批数据）：粘贴题面走机械抽取时，把「输入格式」段落当成了样例 1，
 * 于是 `cfProblemSamples[0]` 变成
 *   `input = "Each test contains multiple test cases. The first line contains the number of test cases $t$…"`
 *   `output = "For each test case, output a single integer — the answer for $k=1$.\n\n样例："`
 * 真样例被挤到 `[1]`。后果是系统性的：19 个会话里 17 个的第一组样例是假的，题解/标尺在假样例上
 * 必挂 → 整批 10 道题得出 `no-bruler`（"题解没过样例/暴力解不可用"），**一次随机对拍都没跑**，
 * 交付给用户的却是"未验证通过"。所以老会话里存着的假样例必须能被识别并清掉（见 sanitizeSamples）。
 *
 * 判据（宁可漏判也不误判：只把"明显是散文"的当假样例）：
 *  - LaTeX 标记（`$t$`、`\le`、`\sum`…）—— 真样例里不可能出现；
 *  - 以「样例：」结尾 —— 机械切片把下一段标题粘了进来；
 *  - 题面散文句式（contains / denote / The first line / For each test case / respectively …）。
 * 真样例是数据（数字、字符串、多行 token），不会命中这些。
 */
function isBogusSample(s) {
  if (!s || typeof s !== 'object') return false;
  const inp = String(s.input == null ? '' : s.input).trim();
  const out = String(s.output == null ? '' : s.output).trim();
  if (!inp && !out) return true;                      // 空样例没有任何用处，留着只会误导
  const prose = (t) => {
    if (!t) return false;
    if (/\$|\\le\b|\\ge\b|\\cdot|\\sum|\\max|\\min|\\times/.test(t)) return true;
    if (/样例\s*[:：]?\s*$/.test(t)) return true;
    if (/\b(?:contains?|denote[sd]?|described|respectively|For each test case|The (?:first|only|second|third) line|\d\s*≤\s*\w+)/i.test(t)) return true;
    return false;
  };
  return prose(inp) || prose(out);
}

/**
 * 清掉假样例。返回 { samples, dropped }：
 *  - `samples`：过滤后的真样例（可能为空 —— 调用方该去重抓题）；
 *  - `dropped`：被丢掉的假样例（供调用方决定"要不要用缓存题里的真样例替换"）。
 * ⚠️ 只在**确实有假样例**时才动数组：正常数据原样返回（同一个引用），不制造无谓的写盘。
 */
function sanitizeSamples(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const bad = list.filter((s) => isBogusSample(s));
  if (!bad.length) return { samples: list, dropped: [] };
  return { samples: list.filter((s) => !isBogusSample(s)), dropped: bad };
}

module.exports = {
  looksStandard, extractSamples, buildStandardStatement, validateNormalized,
  normalizeWithAgent, NORMALIZE_SYSTEM, MARK, looksSpecialJudge,
  isBogusSample, sanitizeSamples
};
