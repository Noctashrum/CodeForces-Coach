'use strict';
/**
 * explaindoc.js — 讲解文档校验器（普通 Markdown 模式）。
 *
 * 为什么需要：讲解质量不能只靠提示词"请求"，必须有一层机械闸门。
 * - 编码：`<viz-*>` 组件写坏（漏闭合、非白名单）绝不能漏到界面上（写坏的标记会以裸文本露出）；
 * - 逻辑：必须有 关键观察 → 为什么 → 手算演示 → 算法 → 复杂度 → 代码 → 易错点 的推理链，
 *   且**每句断言都要有依据**（禁止"显然/易得/不难发现"这类跳过推理的话）；
 * - 保真：讲解里的代码必须与**已验证的代码**一致（防止讲解里悄悄换了实现）。
 *
 * 目标骨架：实测对比 → 一句话根因 → 可执行判定 → 直觉（为什么）
 * → 样例手算（表格/分步）→ 最小反例 → 修正代码 → 验证情况。
 */

const VIZ_TAGS = new Set(['viz-callout', 'viz-compare', 'viz-formula', 'viz-steps', 'viz-step',
  'viz-array', 'viz-bars', 'viz-flow', 'viz-node', 'viz-quiz', 'viz-q']);

/** 逻辑跳跃 / 没有依据的断言（讲解里出现就是不合格） */
const LAZY_WORDS = /(显然|易得|易知|不难发现|不难看出|众所周知|稍微想想|一眼|trivial)/g;

function normCode(s) {
  return String(s == null ? '' : s)
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 扫描 viz 组件用法（配对/自闭合/写坏） */
function scanViz(md) {
  const s = String(md || '');
  const out = { used: [], unclosed: [], unknown: [], selfClosing: 0, paired: 0 };
  const stack = [];
  const re = /<(\/?)(viz-[a-z]+)((?:"[^"]*"|[^>])*?)(\/?)>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClose = m[4] === '/';
    if (!VIZ_TAGS.has(name)) { out.unknown.push(name); continue; }
    out.used.push(name);
    if (selfClose && !closing) { out.selfClosing++; continue; }
    if (closing) {
      const top = stack.pop();
      if (top !== name) out.unclosed.push(name);
    } else {
      stack.push(name); out.paired++;
    }
  }
  stack.forEach((n) => out.unclosed.push(n));
  return out;
}

/**
 * 机械兜底：只要文档里存在**写坏的组件**（未闭合/白名单外），就把整篇的组件标签剥掉（保留文字内容）。
 * 为什么不"只剥坏的那个"：半渲染的组件（例如孤立的 <viz-step> 没有 <viz-steps> 容器）在界面上同样难看，
 * 而讲解内容本身还在 —— 宁可退化成纯文字，也绝不让学员看到角括号汤。
 */
function sanitizeMarkdown(md) {
  const s = String(md || '');
  const v = scanViz(s);
  if (!v.unclosed.length && !v.unknown.length) return s;
  return s.replace(/<\/?viz-[a-z]+[^>]*>/gi, '');
}

function has(text, re) { return re.test(text); }

/**
 * 校验讲解文档。
 * @param {string} markdown 模型产出的讲解正文
 * @param {object} o { intent, level, solCode, lang, verification, hasCounterexample, rich }
 */
function validate(markdown, o) {
  const opt = o || {};
  const md = String(markdown || '');
  const intent = opt.intent || 'full';
  const level = opt.level || 'L3';
  const lang = opt.lang === 'python' ? 'python' : 'cpp';
  const errors = [];
  const warnings = [];
  const stats = { len: md.length };
  if (!md.trim()) return { ok: false, errors: ['讲解内容为空'], warnings, stats };

  const isDebug = intent === 'debug';
  const isFull = level === 'L3' && intent === 'full';

  /* ---------- 1. 逻辑骨架：必备章节 ---------- */
  const heads = (md.match(/^#{2,3}[ \t]*.+$/gm) || []).map((h) => h.replace(/^#+[ \t]*/, '').trim());
  stats.sections = heads;
  const sectionBody = (keys) => {
    const re = new RegExp('^#{2,3}[ \\t]*(' + keys.join('|') + ')[^\\n]*$', 'm');
    const m = md.match(re);
    if (!m || m.index == null) return '';
    const rest = md.slice(m.index + m[0].length);
    const next = rest.match(/^#{2,3}[ \t]*/m);
    return next && next.index != null ? rest.slice(0, next.index) : rest;
  };
  const needAny = (keys, label) => {
    if (!heads.some((h) => keys.some((k) => h.indexOf(k) >= 0))) {
      errors.push('缺少「' + label + '」章节（推理链不能跳步）');
    }
  };
  if (isFull) {
    if (!heads.length) errors.push('完全没有章节标题（必须按骨架分节：题面拆解 / 思路 / 复杂度分析 / 代码 / 讲解）');
    needAny(['题面拆解', '题意'], '题面拆解');
    needAny(['思路', '关键观察', '算法'], '思路');
    needAny(['为什么', '原因', '依据', '正确性'], '为什么（依据）');
    needAny(['复杂度'], '复杂度分析');
    needAny(['代码'], '代码');
    needAny(['易错', '坑', '注意'], '易错点');
  } else if (isDebug) {
    needAny(['根因', '错在', '问题', '为什么'], '根因/为什么');
    needAny(['复杂度'], '复杂度分析');
    needAny(['修正', '代码', '改法'], '修正代码');
  }

  /* ---------- 2. 复杂度必须落到记号上（只看复杂度章节本身） ---------- */
  if (isFull || isDebug) {
    const cx = sectionBody(['复杂度[^\\n]*']);
    if (!cx) errors.push('没有讲复杂度（复杂度分析是标准环节）');
    else if (!/O\s*\(|\\mathcal\{O\}|\\mathrm\{O\}/.test(cx)) warnings.push('复杂度章节里看不到 O(...) 记号，可能没算清');
  }

  /* ---------- 3. 代码保真：必须与已验证代码一致 ---------- */
  const fences = md.match(/```[ \t]*[\w+#.\-]*[ \t]*\n[\s\S]*?```/g) || [];
  stats.codeBlocks = fences.length;
  const sol = normCode(opt.solCode);
  if ((isFull || isDebug) && sol) {
    if (!fences.length) errors.push('没有代码块（必须给出与已验证代码一致的完整实现）');
    else {
      const hit = fences.some((f) => {
        const body = normCode(f.replace(/```[ \t]*[\w+#.\-]*[ \t]*\n?/, '').replace(/```\s*$/, ''));
        if (!body) return false;
        if (body === sol) return true;
        // 规则：允许"只贴核心片段"（漏行），但**不允许改动任何一行**——
        // 讲解里出现的每一行都必须能在已验证代码里原文找到（防止悄悄换实现/夹带私货）。
        const solArr = sol.split('\n').map((x) => x.trim()).filter((x) => x.length > 3);
        const solSet = new Set(solArr);
        const bodyArr = body.split('\n').map((x) => x.trim()).filter((x) => x.length > 3);
        const outside = bodyArr.filter((x) => !solSet.has(x));
        const common = bodyArr.length - outside.length;
        return outside.length === 0 && common >= 2 && common / Math.max(1, solArr.length) >= 0.5;
      });
      if (!hit) errors.push('讲解里的代码与**已验证的代码**不一致（必须原样引用验证通过的那份，不要手改）');
    }
  }

  /* ---------- 4. 组件规范（图文结合：这是我们的表达优势） ---------- */
  const viz = scanViz(md);
  stats.viz = viz.used.length;
  stats.vizTags = [...new Set(viz.used)];
  if (viz.unknown.length) errors.push('用了不存在的组件标签：' + [...new Set(viz.unknown)].join('、') + '（白名单外的标签不会渲染，会变成裸文本）');
  if (viz.unclosed.length) errors.push('组件标签没闭合：' + [...new Set(viz.unclosed)].join('、') + '（写坏了会在界面上露出原始标记）');
  const minViz = isFull ? 3 : (isDebug ? 1 : 0);
  if (viz.used.length < minViz) {
    errors.push('组件太少（至少 ' + minViz + ' 个，图文结合是我们的表达优势）：手算演示用 `<viz-steps>`/`<viz-array>`，'
      + '复杂度用 `<viz-formula>`，易错点用 `<viz-callout type="danger">`，对比用 `<viz-compare>`，自测用 `<viz-quiz>`');
  }

  /* ---------- 5. 手算演示（"讲得清楚"的核心判据） ---------- */
  if (isFull) {
    // 具体例子：出现 举例/例如/走一遍，或任何 `x = 具体值` 形式（n=5 / s="ca" / a=[2,1,1,3]）
    const hasNumbers = /(举例|例如|比如|拿.{0,10}(举例|来说|走一遍)|走一遍|[A-Za-z_]\w*\s*=\s*[\[{"'\w])/.test(md);
    const hasWalkthrough = /(viz-steps|viz-array)/.test(md) || /第\s*1\s*步|一步步|手算/.test(md);
    if (!hasNumbers || !hasWalkthrough) {
      errors.push('缺少「手算演示」：必须拿一个**具体的小数据**（例如 n=5、a=[2,1,1,3,3]）一步步算给学员看，'
        + '用 `<viz-steps>` 或 `<viz-array>` 呈现每一步的状态变化');
    }
  }

  /* ---------- 6. 空话/逻辑跳跃 ---------- */
  const lazy = md.match(LAZY_WORDS) || [];
  if (lazy.length) {
    warnings.push('出现了"显然/易得/不难发现"之类跳过推理的说法（' + [...new Set(lazy)].join('、')
      + '）：要么补上依据，要么删掉这句话');
    if (lazy.length >= 3) errors.push('推理跳跃太多（' + lazy.length + ' 处"显然/易得"）：每一步都要给出依据（为什么 / 反例 / 实测）');
  }

  /* ---------- 7. 反例引用（代码评估/验证失败时的教学素材） ---------- */
  if (opt.hasCounterexample && !opt.rich) {
    if (!/(反例|这组数据|该输入|你输出|期望输出|正确输出)/.test(md)) {
      warnings.push('手里有最小反例，但讲解里没引用它（用具体输入 + 你的输出 vs 正确输出对比，最能让学员信服）');
    }
  }

  /* ---------- 8. 验证口径一致性 ---------- */
  const v = opt.verification || {};
  const failed = v.status && v.status !== 'ok' && v.status !== 'skipped';
  if (failed && /(已验证|已对拍通过|验证通过|全部一致)/.test(md)) {
    errors.push('验证未通过，却声称"已验证"：必须改成诚实口径（这题我还没能验证通过）');
  }
  if (!failed && /(我很有把握|我已反复验证|我不能保证|没有把握)/.test(md)) {
    warnings.push('验证已通过，不要写"我很有把握/没有把握"这类话，把篇幅留给题目本身');
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/** 给模型的定向修复说明（一次修复机会用） */
function repairHint(errors) {
  return '【你上次的讲解没通过结构校验，请修复后重新输出**完整**讲解】\n错误：\n- '
    + (errors || []).slice(0, 6).join('\n- ')
    + '\n\n修复要求：保持已经写对的部分，只补齐/改正上面列出的问题；'
    + '组件的正确写法：`<viz-callout type="key" title="标题">内容</viz-callout>`、'
    + '`<viz-steps title="手算过程"><viz-step title="第 1 步">…</viz-step></viz-steps>`、'
    + '`<viz-compare a="做法A" b="做法B">左边 || 右边</viz-compare>`、'
    + '`<viz-formula title="复杂度" fx="$T(n)=O(n\\log n)$" legend="n=元素个数" why="每个元素进出堆一次"/>`、'
    + '`<viz-array values="3,0,2" highlight="1" title="状态"/>`、'
    + '`<viz-quiz><viz-q q="问题" a="答案">补充</viz-q></viz-quiz>`；每个标签都必须闭合。';
}

module.exports = { validate, sanitizeMarkdown, scanViz, repairHint, VIZ_TAGS, LAZY_WORDS };
