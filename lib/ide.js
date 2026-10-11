/**
 * lib/ide.js — 内嵌 IDE 的"补全"侧：题面上下文 / 提示词 / 输出清洗 / 代码状态存储
 *
 * 这个模块只做**纯逻辑**（没有网络、没有子进程、没有 DOM），所以能被 scripts/test-ide.js
 * 直接 require 进来当纯函数测；server.js 只负责把模型调用（callAgentLLM）与运行器（lib/runner.js）接上。
 *
 * ⚠️ 三条纪律（同时写进 AGENTS.md，改动前先读）：
 *  1. **补全只看「题面 + 用户自己写的代码」**。绝不把 workspace 里教练已验证的题解/暴力解/讲解
 *     塞进提示词 —— 那等于给学员一键抄答案，也让 IDE 变成自证工具（消融纪律里的"oracle 不能来自自己"）。
 *     所以本文件只读 conv 的本地字段（statementText / problemMeta / cfProblemSamples）。
 *  2. 只在用户按按钮时调用，**不做随打字的自动补全**（每次调用都是一次真金白银的模型请求）。
 *  3. IDE 里"运行"必须走 lib/runner.js（windowsHide + 超时任务的统一出口），不得自己 spawn。
 *
 * 状态存储：DATA_DIR/ide/<key>.json（key 用 workspace.keyFor(conv)，即"一题一份"，
 * 同一道题换会话/换设备打开都接着写）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const workspace = require('./workspace');

/** 光标占位符：喂给模型时用它标出"从这里往下写" */
const CURSOR_MARK = '<|CURSOR|>';

const MAX_STATEMENT_CHARS = 6000;   // 题面截断（够描述题意与约束，不至于把上下文撑爆）
const MAX_CODE_CHARS = 12000;       // 送进提示词的代码上限（超了就只留光标附近）
const CODE_BEFORE_KEEP = 8000;      // 超长时保留光标前多少字符
const CODE_AFTER_KEEP = 1200;       // 超长时保留光标后多少字符
const MAX_SUGGESTION_LINES = 14;    // 幽灵提示最多几行（"补一小段"而不是"写完这道题"）
const MAX_SUGGESTION_CHARS = 900;   // 幽灵提示最多几个字符
const MAX_STATE_CODE = 200000;      // 落盘的单份代码上限（防手滑粘进来一个 10MB 的东西）

let IDE_DIR = null;

/** 由 server.js 在启动时注入数据目录（与 workspace.setRoot 同一处） */
function setRoot(dir) {
  IDE_DIR = path.join(String(dir), 'ide');
}
function ideDir() {
  return IDE_DIR || path.join(process.cwd(), 'data', 'ide');
}

/* ---------------- 语言 ---------------- */

/**
 * IDE 只有两种语言：C++ 与 Python。
 * 为什么没有 JS（学员明确要求去掉）：IDE 是**竞赛**编辑器，补全的提示词、代码围栏语言、注释符号
 * 都是按竞赛语言写的；多挂一种语言只会在"模型按别的语言给写法"时添乱。
 * 老状态里存过的 'js' 会回落到默认的 C++（下面的 langOf 不再认它）。
 */
const LANG_LABEL = { cpp: 'C++23', python: 'Python 3' };
const LANG_FENCE = { cpp: 'cpp', python: 'python' };

/** 把用户/前端给的语言名归一化成 cpp / python（认不出的、包括 js/node，一律回落到 cpp） */
function langOf(lang) {
  const s = String(lang == null ? '' : lang).trim().toLowerCase();
  if (s === 'python' || s === 'py' || s === 'python3' || s === 'pypy') return 'python';
  return 'cpp';
}
function langLabel(lang) {
  return LANG_LABEL[langOf(lang)];
}
/** 代码注释符号（提示模式用它把建议写成注释） */
function commentPrefix(lang) {
  return langOf(lang) === 'python' ? '#' : '//';
}

/* ---------------- 提示词 ---------------- */

const CONTINUE_SYSTEM = [
  '你是 Codeforces 竞赛编程的代码补全引擎。学员写代码写到一半卡住了，按了「补全」按钮，',
  '请你补上**光标处接下来的那一小段**代码。',
  '',
  '硬性规则（违反任何一条这条补全就是废的）：',
  '1. 只输出"要插入到光标处"的代码本身。不要解释、不要开场白、不要 markdown 围栏、',
  '   不要把学员已经写过的代码重复一遍。',
  '2. 补得短：默认 1~8 行，最多 14 行，最多 900 个字符。**宁可少补一点，也不要一次写出整道题的解**。',
  '3. 风格必须与学员已有代码一致：同样的缩进、同样的变量命名、同样的输入输出习惯',
  '   （学员用 cin/cout 就别换成 scanf；学员用 print 就别换成 sys.stdout）。',
  '4. 不要修改、不要重写学员已经写下的任何一行 —— 你写的这段是要原地插进光标处的。',
  '5. 如果学员的主体已经写完，就只补收尾（输出、return、多测例清空、边界特判）。',
  '6. 如果解题方向还不明确，就补"下一步能跑起来的最小骨架"，并用一行注释说明思路。'
].join('\n');

const HINT_SYSTEM = [
  '你是 Codeforces 竞赛编程的陪练。学员卡住了，按了「提示」按钮，',
  '请你只给**思路上的点拨**，不要替他写代码。',
  '',
  '硬性规则：',
  '1. 只输出 1~3 行注释（C++ 用 //、Python 用 #）。不要输出任何可运行的代码语句。',
  '2. 点出"下一步该想什么"（该用哪个数据结构 / 该注意哪个边界 / 复杂度够不够），',
  '   不要直接给出完整算法或最终答案。',
  '3. 与题目强相关，别说套话；不超过 200 个字符。'
].join('\n');

function systemPromptOf(mode) {
  return mode === 'hint' ? HINT_SYSTEM : CONTINUE_SYSTEM;
}

/* ---------------- 题面上下文（只读会话本地字段） ---------------- */

function clampText(s, cap) {
  const t = String(s == null ? '' : s);
  if (t.length <= cap) return t;
  return t.slice(0, cap) + '\n…（已截断，共 ' + t.length + ' 字符）';
}

/**
 * 从会话对象里取"题目上下文"。**只读 conv 自己的本地字段**：
 *  - conv.statementText：完整题面（用户粘贴或 CF 取题后都落在这里）
 *  - conv.problemMeta：rating / summary / tags / knowledge
 *  - conv.cfProblem：contestId / index / title
 *  - conv.cfProblemSamples：官方样例
 * 刻意不读 workspace（那里放着教练已验证的题解）。
 */
function problemContextOf(conv) {
  const c = conv || {};
  const meta = c.problemMeta || {};
  const p = c.cfProblem || {};
  const title = p.contestId
    ? String(p.contestId) + String(p.index || '') + '. ' + String(p.title || meta.title || '')
    : String(meta.title || c.title || '');
  const samples = (c.cfProblemSamples || [])
    .filter((s) => s && s.input != null)
    .slice(0, 3)
    .map((s) => ({ input: clampText(s.input, 400), output: s.output == null ? null : clampText(s.output, 400) }));
  const statement = clampText(String(c.statementText || '').replace(/\n{4,}/g, '\n\n\n').trim(), MAX_STATEMENT_CHARS);
  return {
    title: title.trim(),
    rating: meta.rating || 0,
    tags: (meta.tags || []).slice(0, 8),
    knowledge: (meta.knowledge || []).slice(0, 8),
    summary: clampText(meta.summary || '', 600),
    statement,
    samples
  };
}

/** 本地有没有题面素材（没有就只靠代码补全，界面上要如实说明） */
function hasProblemContext(problem) {
  const p = problem || {};
  return !!(p.statement || p.title);
}

/* ---------------- 组装一次补全请求 ---------------- */

/**
 * 超长代码只留光标附近：上下文预算有限，光标前后 20 万行之外的代码对"下一行写什么"没有帮助。
 * @returns {{ text: string, omitted: number }}
 */
function clipAroundCaret(code, caret) {
  const src = String(code == null ? '' : code);
  const at = Math.max(0, Math.min(src.length, Number(caret) || 0));
  if (src.length <= MAX_CODE_CHARS) return { text: src, omitted: 0 };
  const before = src.slice(0, at);
  const after = src.slice(at);
  const keptBefore = before.length > CODE_BEFORE_KEEP ? before.slice(before.length - CODE_BEFORE_KEEP) : before;
  const keptAfter = after.length > CODE_AFTER_KEEP ? after.slice(0, CODE_AFTER_KEEP) : after;
  const omitted = src.length - keptBefore.length - keptAfter.length;
  return { text: keptBefore + keptAfter, omitted, caret: keptBefore.length };
}

/**
 * 组装 system + messages。
 * @param {{mode?:'continue'|'hint', lang?:string, code?:string, caret?:number, problem?:object}} o
 * @returns {{system:string, messages:Array<{role:string,content:string}>, caret:number, clipped:boolean}}
 */
function buildMessages(o) {
  const opts = o || {};
  const mode = opts.mode === 'hint' ? 'hint' : 'continue';
  const lang = langOf(opts.lang);
  const src = String(opts.code == null ? '' : opts.code);
  const caret = Math.max(0, Math.min(src.length, Number(opts.caret) || 0));
  const clip = clipAroundCaret(src, caret);
  const cut = clip.caret == null ? caret : clip.caret;
  const marked = clip.text.slice(0, cut) + CURSOR_MARK + clip.text.slice(cut);
  const problem = opts.problem || {};

  const lines = [];
  if (problem.title) lines.push('【题目】' + problem.title + (problem.rating ? '（rating ' + problem.rating + '）' : ''));
  if (problem.tags && problem.tags.length) lines.push('【标签】' + problem.tags.join(' / '));
  if (problem.summary) lines.push('【一句话大意】' + problem.summary);
  if (problem.statement) lines.push('【题面】\n' + problem.statement);
  if (problem.samples && problem.samples.length) {
    const blocks = problem.samples.map((s, i) => {
      let b = '样例 ' + (i + 1) + ' 输入：\n' + s.input;
      if (s.output != null) b += '\n样例 ' + (i + 1) + ' 输出：\n' + s.output;
      return b;
    });
    lines.push('【官方样例】\n' + blocks.join('\n\n'));
  }
  if (!problem.statement && !problem.title) lines.push('【题目】未知（学员没有提供题面，只能依据代码本身判断）');
  lines.push('【语言】' + langLabel(lang));
  lines.push('【学员当前的代码】' + (clip.omitted ? '（中间省略了 ' + clip.omitted + ' 个字符，' + CURSOR_MARK + ' 是光标）' : '（' + CURSOR_MARK + ' 是光标位置）'));
  lines.push('```' + LANG_FENCE[lang] + '\n' + marked + '\n```');
  lines.push(mode === 'hint'
    ? '【任务】学员卡住了。请只给 1~3 行注释形式的思路点拨，不要写代码。'
    : '【任务】请补上 ' + CURSOR_MARK + ' 处接下来的那一小段代码（只给要插入的片段）。');

  return {
    system: systemPromptOf(mode),
    messages: [{ role: 'user', content: lines.join('\n\n') }],
    caret,
    clipped: !!clip.omitted
  };
}

/* ---------------- 清洗模型输出 ---------------- */

/** 取第一个围栏代码块（优先与语言匹配的） */
function firstFencedBlock(text, lang) {
  const re = /```([A-Za-z0-9+#._-]*)\n?([\s\S]*?)```/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push({ lang: String(m[1] || '').toLowerCase(), body: m[2] });
  if (!found.length) return null;
  const want = LANG_FENCE[langOf(lang)];
  const hit = found.find((b) => b.lang === want) || found.find((b) => b.lang && want && b.lang.indexOf(want.slice(0, 2)) === 0) || found[0];
  return hit.body;
}

/** 去掉模型爱说的开场白（只删行首那 1~2 行，且只在它明显不是代码时） */
function stripPreamble(text, mode, lang) {
  const lines = String(text).split('\n');
  const cmt = commentPrefix(lang);
  const isCodeish = (l) => {
    const s = l.trim();
    if (!s) return false;
    if (mode === 'hint') return s.indexOf(cmt) === 0 || s.indexOf('#') === 0;
    if (s.indexOf(cmt) === 0 || s.indexOf('#') === 0) return true;
    return /[;{}()=<>\[\]+]|^\s*(for|while|if|else|return|int|long|vector|print|cin|cout|scanf|printf|def|import)\b/.test(s);
  };
  let removed = 0;
  while (lines.length && removed < 2 && !isCodeish(lines[0])) {
    const s = lines[0].trim();
    // 只吃"开场白/说明性"的行，别把真正的注释吃掉（注释在 isCodeish 里已经算代码了）
    if (/^(好的|当然|没问题|这是|下面是|以下是|补全如下|Sure|Here|Okay|OK|当然可以|可以这样)/i.test(s) || /[：:。]$/.test(s)) {
      lines.shift();
      removed++;
      while (lines.length && !lines[0].trim()) lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n');
}

/** 去掉模型把"学员已有代码"回显出来的部分（按行比对尾部） */
function stripEcho(suggestion, code, caret) {
  const before = String(code || '').slice(0, Math.max(0, Number(caret) || 0));
  const suggLines = String(suggestion).split('\n');
  if (!before.trim()) return suggLines.join('\n');
  // 注意：光标常停在"代码末尾的换行之后"，所以要先扔掉结尾的空行，
  // 否则比对的锚点是空串，模型回显整行时一行都砍不掉（这是最初版本的 bug）。
  const beforeLines = before.replace(/\s+$/, '').split('\n');
  let dropped = 0;
  while (suggLines.length && dropped < 4) {
    const last = beforeLines[beforeLines.length - 1 - dropped];
    if (last == null || !last.trim()) break;
    if (suggLines[0].trim() && suggLines[0].trim() === last.trim()) {
      suggLines.shift();
      dropped++;
      continue;
    }
    break;
  }
  // 单行重叠：光标在某一行末尾，模型从这一行的开头重写了一遍 → 砍掉重复的前缀
  // （连带砍掉紧随其后的空白：光标处已经有一个空格了，否则会插出两个空格）
  if (suggLines.length && beforeLines.length) {
    const tail = beforeLines[beforeLines.length - 1];
    const head = suggLines[0];
    const t = tail.replace(/\s+$/, '');
    if (t.length >= 4 && head.indexOf(t) === 0 && head.length > t.length) {
      suggLines[0] = head.slice(t.length).replace(/^[ \t]+/, '');
    }
  }
  return suggLines.join('\n');
}

function capSuggestion(text) {
  let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  let capped = false;
  if (lines.length > MAX_SUGGESTION_LINES) {
    s = lines.slice(0, MAX_SUGGESTION_LINES).join('\n');
    capped = true;
  }
  if (s.length > MAX_SUGGESTION_CHARS) {
    const cut = s.lastIndexOf('\n', MAX_SUGGESTION_CHARS);
    s = cut > MAX_SUGGESTION_CHARS / 2 ? s.slice(0, cut) : s.slice(0, MAX_SUGGESTION_CHARS);
    capped = true;
  }
  return { text: s, capped };
}

/**
 * 把模型输出洗成"可以直接插进光标处的代码片段"。
 * @returns {{ text:string, capped:boolean, note:string }}
 */
function cleanSuggestion(text, o) {
  const opts = o || {};
  const mode = opts.mode === 'hint' ? 'hint' : 'continue';
  const lang = langOf(opts.lang);
  const raw = String(text == null ? '' : text);
  let note = '';
  let body = raw.replace(/^\uFEFF/, '');
  const fenced = firstFencedBlock(body, lang);
  if (fenced != null) {
    body = fenced;
    note = '已去掉 markdown 围栏';
  }
  body = stripPreamble(body, mode, lang).replace(/\r\n?/g, '\n');
  if (mode === 'continue') body = stripEcho(body, opts.code, opts.caret);
  // 去掉首尾空行（但保留行内的相对缩进）
  body = body.replace(/^\n+/, '').replace(/\s+$/, '');
  const c = capSuggestion(body);
  if (c.capped && c.text !== body.replace(/\s+$/, '')) note = (note ? note + '；' : '') + '已截到 ' + MAX_SUGGESTION_LINES + ' 行以内';
  return { text: c.text, capped: c.capped, note };
}

/* ---------------- 代码状态（一题一份） ---------------- */

function safeKey(key) {
  const s = String(key == null ? '' : key).replace(/[^A-Za-z0-9._-]/g, '_');
  return s.slice(0, 120) || 'scratch';
}

/** 会话 → IDE 状态键（与 workspace 同一口径：同题共享一份代码） */
function stateKeyOf(conv) {
  if (!conv) return 'scratch';
  try {
    return safeKey(workspace.keyFor(conv));
  } catch (e) {
    return 'scratch';
  }
}

function stateFile(key) {
  return path.join(ideDir(), safeKey(key) + '.json');
}

/** 读一份代码状态；不存在返回 { lang:'cpp', code:'', updatedAt:0 } */
function loadState(key) {
  const file = stateFile(key);
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      lang: langOf(obj && obj.lang),
      code: String((obj && obj.code) || ''),
      updatedAt: Number((obj && obj.updatedAt) || 0)
    };
  } catch (e) {
    return { lang: 'cpp', code: '', updatedAt: 0 };
  }
}

/**
 * 写一份代码状态（原子写：先写 .tmp-<随机> 再 rename，别让中途崩溃留下半截 JSON）。
 * @returns {{ ok:boolean, error?:string, state?:object, file?:string }}
 */
function saveState(key, patch) {
  const p = patch || {};
  const code = String(p.code == null ? '' : p.code);
  if (code.length > MAX_STATE_CODE) {
    return { ok: false, error: '代码超过 ' + MAX_STATE_CODE + ' 字符上限，没有保存（是不是粘错东西了？）' };
  }
  const prev = loadState(key);
  const state = {
    lang: p.lang == null ? prev.lang : langOf(p.lang),
    code: code === '' && p.keepCode ? prev.code : code,
    updatedAt: Date.now()
  };
  try {
    fs.mkdirSync(ideDir(), { recursive: true });
    const file = stateFile(key);
    const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(file); } catch (e2) { /* ignore */ }
      fs.renameSync(tmp, file);
    }
    return { ok: true, state, file };
  } catch (e) {
    return { ok: false, error: '保存失败: ' + e.message };
  }
}

module.exports = {
  CURSOR_MARK,
  MAX_SUGGESTION_LINES,
  MAX_SUGGESTION_CHARS,
  setRoot,
  ideDir,
  langOf,
  langLabel,
  commentPrefix,
  systemPromptOf,
  CONTINUE_SYSTEM,
  HINT_SYSTEM,
  problemContextOf,
  hasProblemContext,
  clipAroundCaret,
  buildMessages,
  cleanSuggestion,
  stateKeyOf,
  safeKey,
  stateFile,
  loadState,
  saveState
};
