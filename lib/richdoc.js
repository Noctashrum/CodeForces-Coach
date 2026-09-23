/**
 * lib/richdoc.js — 图文讲解文档的校验与包装
 *
 * 参考 learn 站的 validate.py / audit_svg_text.py 思路：
 * 模型只写「内容标记」（用设计系统里已有的 class），校验器负责挡住
 * 外部资源、脚本、越界标签与不完整结构；通过后再套上宿主的 CSS/JS（sandbox iframe）。
 *
 * 安全：产物渲染在 <iframe sandbox="allow-scripts">（无 allow-same-origin）里，
 * 并在文档内加 CSP，禁止一切外部请求；模型输出里的 <script>/on* 一律拒绝。
 */
'use strict';

const MAX_BYTES = 160 * 1024;
const MAX_LEN = 120000;

/** 允许的标签（白名单） */
const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'b', 'strong', 'i', 'em', 'u', 's', 'mark', 'small', 'sup', 'sub', 'code', 'pre', 'kbd', 'abbr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'use', 'clipPath', 'linearGradient',
  'radialGradient', 'stop', 'pattern', 'filter', 'feGaussianBlur', 'mask', 'image', 'button', 'details', 'summary'
]);

/** 允许的 class（设计系统词汇表；未列出的会被提示为"自造样式"） */
const ALLOWED_CLASSES = new Set([
  // 结构
  'wrap', 'hero', 'kicker', 'subtitle', 'meta', 'oneliner', 'chapter', 'num', 'lead', 'sub', 'subsub',
  'footer', 'topbar', 'toc', 'card', 'grid', 'g2', 'g3', 'g4', 'mini', 'ico',
  // 提示框
  'callout', 'tip', 'key', 'warn', 'danger', 'analogy', 'quote', 'ttl',
  // 图 / 流程 / 对比
  'diagram', 'flow', 'step', 'n', 'arrow', 'violet', 'green', 'amber', 'compare', 'side', 'a', 'b',
  // 表格 / 公式 / 步骤
  'table-wrap', 'data', 'num', 'best', 'worst', 'formula', 'fx', 'var', 'legend', 'why',
  'steps',
  // 交互
  'anim-box', 'head', 'ctl', 'ghost', 'tokens', 'tok', 'alt', 'bars', 'bar-item', 'bar', 'cap',
  'slider-steps', 'pane', 'on', 'slider-nav', 'dot', 'pos', 'note',
  // 自测 / 术语
  'quiz', 'q', 'qh', 'idx', 'qa', 'ans', 'glossary', 'g', 'en',
  // 代码 / 行内
  'code', 'cm', 'kw', 'fn2', 'hi', 'hl', 'hl-blue', 'term', 'inline'
]);

const FORBIDDEN_TAGS = new Set(['script', 'style', 'link', 'iframe', 'object', 'embed', 'form',
  'input', 'textarea', 'select', 'video', 'audio', 'source', 'canvas', 'base', 'meta', 'noscript']);

/** 校验一份"富讲解正文"（模型输出的 body 内容片段） */
/**
 * 粗检"输出是不是被截断了"。
 * 实测教训：deepseek-flash 那次的图文文档两次都没过校验，最可能的原因就是**输出被 max_tokens 截断**——
 * 文档没有正常收尾（缺 </div> / 末尾停在半个标签或半个属性上），校验器却只会报"标签未闭合"，
 * 让人以为是模型写错了结构。识别出来就能给出更有用的修复指令（压缩篇幅重写）。
 */
function looksTruncated(html) {
  const s = String(html || '').trim();
  if (!s) return false;
  // 1) 正常收尾的文档一定以闭合的 </div> 结尾
  if (!/<\/div>\s*$/.test(s)) return true;
  // 2) 开闭数量明显不等（缺闭合）
  const open = (s.match(/<div\b/gi) || []).length;
  const close = (s.match(/<\/div>/gi) || []).length;
  if (close < open) return true;
  // 3) 末尾停在半个标签 / 未结束的属性上
  if (/<[^>]*$/.test(s) || /="[^"]*$/.test(s)) return true;
  // 4) 常见"写一半"的收尾
  if (/(class|style|data-anim|viewBox)\s*=\s*["'][^"']*$/i.test(s)) return true;
  return false;
}

function validate(html) {
  const errors = [];
  const warnings = [];
  let s = String(html || '').trim();

  if (!s) return { ok: false, errors: ['内容为空'], warnings, stats: {} };
  if (s.length > MAX_LEN) errors.push('内容过长（' + s.length + ' 字符，上限 ' + MAX_LEN + '）');
  if (!/<div[^>]*class="[^"]*\bwrap\b/.test(s) && !/<section[^>]*class="[^"]*\bchapter\b/.test(s)) {
    errors.push('缺少结构：需要一个 <div class="wrap"> 或若干 <section class="chapter">');
  }

  // 1) 禁止的标签与外部资源
  const tagRe = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g;
  let m;
  const seenTags = {};
  while ((m = tagRe.exec(s)) !== null) {
    const tag = m[1];
    const lower = tag.toLowerCase();
    seenTags[lower] = (seenTags[lower] || 0) + 1;
    if (FORBIDDEN_TAGS.has(lower)) errors.push('不允许的标签：<' + lower + '>（外部脚本/资源一律禁止，交互由内置运行时提供）');
    else if (tag !== lower && !ALLOWED_TAGS.has(tag)) {
      // SVG 的 camelCase 标签（viewBox 属性另说）允许白名单内的
      if (!ALLOWED_TAGS.has(tag)) warnings.push('未知标签：<' + tag + '>');
    } else if (!ALLOWED_TAGS.has(lower) && !ALLOWED_TAGS.has(tag)) {
      warnings.push('未知标签：<' + lower + '>');
    }
  }
  if (/\son[a-z]+\s*=/i.test(s)) errors.push('不允许内联事件属性（onclick 等）：交互请用设计系统里的 data-anim 组件');
  if (/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(s)) errors.push('不允许外部 URL（src/href 指向站外）：图片请用内联 SVG，链接用 #锚点');
  if (/javascript:/i.test(s)) errors.push('不允许 javascript: 协议');
  if (/<style[\s\S]*?<\/style>/i.test(s)) errors.push('不允许 <style> 块：只能用设计系统已有的 class（少量 style="" 微调可以）');
  if (/\sstyle\s*=\s*["'][^"']{240,}/i.test(s)) warnings.push('存在很长的内联 style，建议改用 class');

  // 2) 标签配对（粗检，忽略自闭合与 void 标签）
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'source', 'stop', 'path', 'rect',
    'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'image', 'feGaussianBlur']);
  const stack = [];
  const pairRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let p;
  while ((p = pairRe.exec(s)) !== null) {
    const closing = p[1] === '/';
    const tag = p[2].toLowerCase();
    const selfClose = p[4] === '/' || VOID.has(tag);
    if (closing) {
      if (!stack.length) { warnings.push('多余的闭合标签 </' + tag + '>'); continue; }
      if (stack[stack.length - 1] === tag) stack.pop();
      else {
        const at = stack.lastIndexOf(tag);
        if (at >= 0) {
          // 交叉嵌套：<a><b></a> —— 这是结构错误，必须挡（渲染会错位）
          errors.push('标签嵌套错误：<' + stack[stack.length - 1] + '> 还没闭合就出现了 </' + tag + '>');
          stack.splice(at, 1);
        } else {
          warnings.push('闭合标签没有对应开标签：</' + tag + '>');
        }
      }
    } else if (!selfClose) stack.push(tag);
  }
  if (stack.length) errors.push('标签未闭合：' + stack.slice(0, 4).map((t) => '<' + t + '>').join('、'));

  // 3) class 白名单
  const classRe = /class\s*=\s*["']([^"']+)["']/gi;
  const badClasses = {};
  let c;
  while ((c = classRe.exec(s)) !== null) {
    c[1].split(/\s+/).filter(Boolean).forEach((cls) => {
      if (!ALLOWED_CLASSES.has(cls)) badClasses[cls] = (badClasses[cls] || 0) + 1;
    });
  }
  const badList = Object.keys(badClasses);
  if (badList.length) {
    warnings.push('用了设计系统之外的 class（不会有样式）：' + badList.slice(0, 8).join('、'));
  }

  // 4) 结构与内容要求
  //    图解计数要**宽容**：模型可能写成 <figure class="diagram">、<div class="diagram">，
  //    也可能只是 <div class="card"> 里插了一张大 svg —— 图确实画出来了，就不该判不合格。
  const figures = (s.match(/<figure[^>]*class="[^"]*\bdiagram\b/gi) || []).length;
  const diagramDivs = (s.match(/<div[^>]*class="[^"]*\bdiagram\b/gi) || []).length;
  const bigSvgs = diagramSvgs(s);
  const figureCount = Math.max(figures, diagramDivs, bigSvgs.length);
  if (bigSvgs.length < 1) {
    errors.push('没有任何 SVG 图解（至少要有 1 张 viewBox 尺寸正常的 <svg> 图；这是"图文讲解"的核心）');
  } else if (figureCount < 2) {
    warnings.push('只有 ' + figureCount + ' 张图解（建议 ≥2 张：例如"算法流程"+"数据变化"）');
  }
  const anims = (s.match(/data-anim="(sequence|bars|roam)"|class="[^"]*slider-steps/gi) || []).length;
  if (anims < 1) warnings.push('没有交互演示（建议加 1 个：data-anim="sequence|bars|roam" 或 class="slider-steps"）');
  const chapters = (s.match(/class="[^"]*\bchapter\b/gi) || []).length;
  if (chapters < 3) warnings.push('章节偏少（建议 4–6 个 chapter：题面/思路/复杂度/代码/讲解）');
  if (!/class="[^"]*(callout|formula|table-wrap)/.test(s)) warnings.push('没有用到提示框/公式/表格，讲解可以更结构化');
  // 图文文档里没有公式渲染器：出现 LaTeX 记号会被学员当成"代码暴露"（实测反馈）——
  // 净化阶段会机械翻译成可读文本，这里额外提醒模型改用设计系统的写法
  if (/\$[^$\n]{1,200}\$|\\[a-zA-Z]{2,}/.test(s)) {
    warnings.push('文档里出现了 LaTeX（$…$ / \\le 之类）：图文文档没有公式渲染器，'
      + '请改成 `<div class="formula"><div class="fx">…</div></div>`（行内用 `<code>`）');
  }

  // 5) SVG 文本越界粗检：text 的 x/y 必须落在 viewBox 内
  const svgBlocks = s.match(/<svg[\s\S]*?<\/svg>/gi) || [];
  const svgs = svgBlocks.filter((svg) => /viewBox\s*=/i.test(svg)).length;
  svgBlocks.forEach((svg, i) => {
    const vb = svg.match(/viewBox\s*=\s*["']([\d.\-\s]+)["']/i);
    if (!vb) return;
    const v = vb[1].trim().split(/\s+/).map(Number);
    if (v.length !== 4 || v.some((n) => !isFinite(n))) { warnings.push('图 ' + (i + 1) + ' 的 viewBox 不合法'); return; }
    const [vx, vy, vw, vh] = v;
    const textRe = /<text[^>]*>/gi;
    let t;
    while ((t = textRe.exec(svg)) !== null) {
      const tag = t[0];
      const x = parseFloat((tag.match(/\sx\s*=\s*["']([\d.\-]+)["']/i) || [])[1]);
      const y = parseFloat((tag.match(/\sy\s*=\s*["']([\d.\-]+)["']/i) || [])[1]);
      if (isFinite(x) && (x < vx - 1 || x > vx + vw + 1)) warnings.push('图 ' + (i + 1) + ' 有文字 x=' + x + ' 超出 viewBox 宽度 ' + vw + '（可能被裁掉）');
      if (isFinite(y) && (y < vy - 1 || y > vy + vh + 1)) warnings.push('图 ' + (i + 1) + ' 有文字 y=' + y + ' 超出 viewBox 高度 ' + vh + '（可能被裁掉）');
    }
  });

  return {
    ok: errors.length === 0,
    errors: dedupe(errors),
    warnings: dedupe(warnings).slice(0, 8),
    stats: { len: s.length, chapters, figures: figureCount, figureTags: figures, svgs, anims,
      bytes: Buffer.byteLength(s, 'utf8') }
  };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

/** LaTeX 片段 → 可读文本（希腊字母/关系符/命令名；不追求排版，只求学员看得懂） */
function texToText(tex) {
  const map = {
    '\\leqslant': '≤', '\\geqslant': '≥', '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥',
    '\\ne': '≠', '\\neq': '≠', '\\times': '×', '\\cdot': '·', '\\div': '÷', '\\pm': '±',
    '\\to': '→', '\\rightarrow': '→', '\\Rightarrow': '⇒', '\\in': '∈', '\\notin': '∉',
    '\\subseteq': '⊆', '\\cup': '∪', '\\cap': '∩', '\\emptyset': '∅', '\\sum': 'Σ', '\\prod': 'Π',
    '\\infty': '∞', '\\forall': '∀', '\\exists': '∃', '\\lfloor': '⌊', '\\rfloor': '⌋',
    '\\lceil': '⌈', '\\rceil': '⌉', '\\equiv': '≡', '\\approx': '≈', '\\alpha': 'α', '\\beta': 'β',
    '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε', '\\varepsilon': 'ε', '\\theta': 'θ',
    '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ', '\\phi': 'φ', '\\omega': 'ω',
    '\\log': 'log', '\\ln': 'ln', '\\max': 'max', '\\min': 'min', '\\gcd': 'gcd', '\\bmod': 'mod',
    '\\pmod': 'mod', '\\quad': ' ', '\\qquad': ' ', '\\,': ' ', '\\;': ' ', '\\!': '',
    '\\left': '', '\\right': '', '\\displaystyle': '', '\\limits': ''
  };
  let t = String(tex || '');
  t = t.replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>');
  t = t.replace(/\\text(?:rm|bf|it|sf|tt)?\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\(?:mathrm|mathbf|mathit|mathsf)\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\operatorname\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
  t = t.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
  t = t.replace(/\^\{([^{}]*)\}/g, '^$1').replace(/_\{([^{}]*)\}/g, '_$1');
  Object.keys(map).forEach((k) => { t = t.split(k).join(map[k]); });
  t = t.replace(/\\([a-zA-Z]+)/g, '$1');   // 剩下的 \xxx → xxx（宁可留名字，也不留反斜杠）
  return t;
}

/**
 * 把模型写进 HTML 文档里的 **LaTeX / Markdown 残渣**机械转成设计系统能显示的写法。
 *
 * 为什么必须机械处理：图文文档里**没有公式渲染器**（设计系统要求公式用 HTML 排版），
 * 模型却常写成 `$s_i=\texttt{1}$`、`\lfloor n/2\rfloor` —— 学员看到的就是一串公式源码
 * （实测反馈："怎么又有代码直接暴露出来了"）。与其反复求模型别写（它总会写），不如就地翻译。
 */
function demathify(html) {
  let s = String(html || '');
  const before = s;
  // ① 行间公式 $$...$$ / \[...\] → 设计系统的 .formula 块
  s = s.replace(/\$\$([\s\S]{1,400}?)\$\$/g, (m, body) => '<div class="formula"><div class="fx">' + texToText(body) + '</div></div>');
  s = s.replace(/\\\[([\s\S]{1,400}?)\\\]/g, (m, body) => '<div class="formula"><div class="fx">' + texToText(body) + '</div></div>');
  // ② 行内 $...$ / \(...\) → <code>…</code>（含单字符 $s$）
  s = s.replace(/\$([^$\n]{1,200}?)\$/g, (m, body) => '<code>' + texToText(body) + '</code>');
  s = s.replace(/\\\(([\s\S]{1,200}?)\\\)/g, (m, body) => '<code>' + texToText(body) + '</code>');
  // ③ 漏写 $ 的裸 LaTeX 命令 → 就地翻译
  if (/\\[a-zA-Z]{2,}/.test(s)) s = texToText(s);
  // ④ Markdown 残渣：代码围栏与行内反引号
  s = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/`([^`\n]{1,120})`/g, '<code>$1</code>');
  return { html: s, changed: s !== before };
}

/** 从 html 里把"剩下的开标签"按顺序取出来（用于机械补齐闭合标签） */
function openStack(html) {
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'source', 'stop', 'path', 'rect',
    'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'image', 'feGaussianBlur']);
  const stack = [];
  const re = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClose = m[4] === '/' || VOID.has(tag);
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at >= 0) stack.splice(at, 1);
    } else if (!selfClose) stack.push(tag);
  }
  return stack;
}

/**
 * 机械净化 + 修补：把"可以救回来的结构问题"就地修好，而不是整份文档作废。
 *
 * 为什么需要它：模型写图文文档时最常犯的三类问题——
 *   ① 夹带了 <script>/<style>/外链图片（安全上必须去掉）；
 *   ② 末尾少了一两个 </div>（结构不完整，但内容全在）；
 *   ③ 图解没用 <figure class="diagram"> 而是自成一格的 <div class="card"><svg …>（图其实画了）。
 * 这三类都不该导致"整份图文讲解作废、回落到没有图的 Markdown"——那才是学员真正看到的"生不出图"。
 * 净化后仍会走同一套 validate，硬性错误（禁止标签/外部 URL/未闭合）在这里就被消掉了。
 */
function sanitize(html) {
  const changes = [];
  let s = String(html || '');

  // ① 去掉注释与脚本/样式块（连同内容）
  const before1 = s.length;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  if (s.length !== before1) changes.push('去掉了 <script>/<style>/注释');

  // ② 去掉整类危险/无意义标签（保留内部文字）
  const before2 = s;
  s = s.replace(/<\/?(iframe|object|embed|link|meta|base|form|input|textarea|select|option|video|audio|source|canvas|noscript|frame|frameset|applet)\b[^>]*>/gi, '');
  if (s !== before2) changes.push('去掉了不允许的标签（iframe/form/link 等）');

  // ③ 去掉内联事件、javascript: 协议
  const before3 = s;
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src|xlink:href)\s*=\s*("|')?\s*javascript:[^"'\s>]*("|')?/gi, '$1="#"');
  if (s !== before3) changes.push('去掉了内联事件属性 / javascript: 链接');

  // ④ 外链资源：图片/链接指向站外一律去掉（文档必须自包含）
  const before4 = s;
  s = s.replace(/\s(src|href|xlink:href)\s*=\s*("|')?(?:https?:)?\/\/[^"'\s>]*("|')?/gi, '');
  if (s !== before4) changes.push('去掉了指向站外的 src/href（图文文档必须自包含）');

  // ⑤ LaTeX / Markdown 残渣：图文文档里没有公式渲染器，就地翻译（学员看到的是可读文本，而不是 $…$\texttt）
  const dm = demathify(s);
  if (dm.changed) { s = dm.html; changes.push('把 LaTeX / Markdown 残渣翻译成了可读写法（文档里没有公式渲染器）'); }

  // ⑥ 末尾缺闭合标签 → 机械补齐（内容都在，只是没收尾）
  const stack = openStack(s);
  if (stack.length) {
    s = s.trim() + '\n' + stack.slice().reverse().map((t) => '</' + t + '>').join('');
    changes.push('补齐了未闭合的标签：' + stack.slice(-4).map((t) => '<' + t + '>').join('、'));
  }
  return { html: s, changes };
}

/** "算得上图解"的 SVG：有 viewBox 且尺寸像一张图（不是 16px 的小图标） */
function diagramSvgs(s) {
  const blocks = s.match(/<svg[\s\S]*?<\/svg>/gi) || [];
  return blocks.filter((svg) => {
    const vb = svg.match(/viewBox\s*=\s*["']([\d.\-\s]+)["']/i);
    if (!vb) return false;
    const v = vb[1].trim().split(/\s+/).map(Number);
    if (v.length !== 4 || v.some((n) => !isFinite(n))) return false;
    return v[2] >= 160 && v[3] >= 50;      // 宽度 ≥160 且高度 ≥50 才算"图解"（排掉 16px 小图标）
  });
}

/** 把校验过的正文包成完整文档（内联 CSS/JS + CSP），供 iframe srcdoc 使用 */
function wrap(bodyHtml, opts) {
  const o = opts || {};
  const theme = o.theme === 'light' ? 'light' : 'dark';
  const css = String(o.css || '');
  const js = String(o.js || '');
  const title = String(o.title || '图文讲解').slice(0, 80);
  return [
    '<!DOCTYPE html><html lang="zh-CN" data-theme="' + theme + '"><head>',
    '<meta charset="utf-8">',
    // 禁止一切外部请求（含图片/字体/网络），只允许内联样式与脚本
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; font-src data:">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + title.replace(/[<>&]/g, '') + '</title>',
    '<style>' + css + '</style>',
    '</head><body>',
    '<div id="progress"></div>',
    '<div class="wrap">',
    bodyHtml,
    '</div>',
    '<script>' + js + '<\/script>',
    '</body></html>'
  ].join('\n');
}

module.exports = { validate, wrap, looksTruncated, sanitize, diagramSvgs, ALLOWED_CLASSES, ALLOWED_TAGS, MAX_LEN };
