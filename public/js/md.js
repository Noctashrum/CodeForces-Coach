/* ============================================================
 * md.js — Markdown / 代码高亮 / KaTeX 公式渲染
 * 依赖（均为本地 vendored，无外部请求）：marked / highlight.js / katex
 * ============================================================ */
(function () {
  'use strict';

  const HLJS = window.hljs || null;
  const KATEX = window.katex || null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let mdConfigured = false;
  function ensureMarked() {
    if (mdConfigured || !window.marked) return;
    mdConfigured = true;
    try {
      const opts = { gfm: true, breaks: true };
      if (typeof window.marked.use === 'function') window.marked.use(opts);
      else window.marked.setOptions(opts);
    } catch (e) { /* ignore */ }
  }

  /** 允许的自定义组件（与 md.js 的渲染器、讲解提示词三方对齐） */
  const VIZ_TAGS = ['viz-callout', 'viz-compare', 'viz-formula', 'viz-steps', 'viz-step',
    'viz-array', 'viz-bars', 'viz-flow', 'viz-node', 'viz-quiz', 'viz-q'];

  /**
   * 保护自定义组件块：配对形态与自闭合形态都替换成占位符，交给 renderViz 渲染。
   * 关键：**未闭合/写坏的标记必须剥掉**（哪怕模型漏了闭标签），
   * 因为漏到界面上的 `<viz-steps title="...">` 就是"代码裸露"（学员会看到一串裸标记）。
   */
  function protectViz(src, blocks) {
    const names = VIZ_TAGS.join('|');
    let s = String(src);
    // 配对形态（非贪婪；同名嵌套极少见，按最内层闭合处理）
    s = s.replace(new RegExp('<(viz-[a-z]+)([^>]*)>([\\s\\S]*?)<\\/\\1>', 'gi'), function (m) {
      blocks.push({ kind: 'viz', html: m });
      return '\u0000V' + (blocks.length - 1) + '\u0000';
    });
    // 自闭合形态 <viz-array ... />
    s = s.replace(new RegExp('<(viz-[a-z]+)([^>]*)\\/>', 'gi'), function (m) {
      blocks.push({ kind: 'viz', html: m });
      return '\u0000V' + (blocks.length - 1) + '\u0000';
    });
    // 兜底：剩下任何 viz-* 开/闭标签（写坏、漏闭合、非白名单）一律去掉，绝不显示角括号
    s = s.replace(new RegExp('<\\/?(?:' + names + ')[^>]*>', 'gi'), '');
    s = s.replace(/<\/?viz-[a-z]+[^>]*>/gi, '');
    return s;
  }

  function highlightCode(code, lang) {
    if (HLJS) {
      try {
        if (lang && HLJS.getLanguage(lang)) {
          return HLJS.highlight(code, { language: lang, ignoreIllegals: true }).value;
        }
      } catch (e) { /* ignore */ }
      try { return HLJS.highlightAuto(code).value; } catch (e) { /* ignore */ }
    }
    return escapeHtml(code);
  }

  function renderMath(tex, display) {
    if (!KATEX) return '<code>' + escapeHtml(tex) + '</code>';
    try {
      return KATEX.renderToString(tex, { displayMode: display, throwOnError: false, strict: false });
    } catch (e) {
      return '<code>' + escapeHtml(tex) + '</code>';
    }
  }

  function buildCodeBlock(b) {
    const lang = String(b.lang || '').toLowerCase();
    const shown = (HLJS && lang && HLJS.getLanguage(lang)) ? lang : (lang || 'text');
    return '<div class="code-wrap">'
      + '<div class="code-block-head"><span>' + escapeHtml(shown) + '</span>'
      + '<button class="code-copy" type="button" data-code-copy>复制</button></div>'
      + '<pre><code class="hljs">' + highlightCode(b.code, lang) + '</code></pre></div>';
  }

  /**
   * 渲染 Markdown。
   * 安全策略：默认转义原始 HTML；富讲解模式（opts.allowHtml）下放行白名单 HTML，
   * 并把 <viz-*> 自定义标签渲染成可视化组件（数组指针、分步讲解、柱状图、流程、提示框）。
   */
  function renderMarkdown(src, opts) {
    ensureMarked();
    if (src == null) return '';
    src = String(src);
    if (!src.trim()) return '';
    const allowHtml = !!(opts && opts.allowHtml);
    const blocks = [];

    // 1. 保护代码围栏与行内代码
    src = src.replace(/```([\w+#.\-]*)[ \t]*\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push({ kind: 'code', lang: lang || '', code: code.replace(/\n$/, '') });
      return '\u0000C' + (blocks.length - 1) + '\u0000';
    });
    src = src.replace(/`([^`\n]+)`/g, function (m, code) {
      blocks.push({ kind: 'icode', code: code });
      return '\u0000c' + (blocks.length - 1) + '\u0000';
    });

    // 2. 保护公式（块级 $$..$$ 与行内 $..$；行内允许单字符公式如 $s$、$n$）
    src = src.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) {
      blocks.push({ kind: 'math', tex: tex.trim(), display: true });
      return '\u0000M' + (blocks.length - 1) + '\u0000';
    });
    src = src.replace(/\$([^\s$](?:[^$\n]{0,200}[^\s$])?)\$/g, function (m, tex) {
      blocks.push({ kind: 'math', tex: tex, display: false });
      return '\u0000m' + (blocks.length - 1) + '\u0000';
    });

    // 3. 保护自定义组件（**两种模式都要**：普通讲解也用 viz-* 表达范式，
    //    若只在富模式保护，普通模式会把 <viz-steps ...> 当纯文本吐出来）
    src = protectViz(src, blocks);
    if (allowHtml) {
      src = sanitizeHtml(src);
    } else {
      src = escapeHtml(src);
    }

    // 4. marked 解析
    let html;
    try {
      html = window.marked
        ? window.marked.parse(src)
        : '<p>' + src.replace(/\n/g, '<br>') + '</p>';
    } catch (e) {
      html = escapeHtml(src);
    }

    // 5. 恢复块级占位符（<p>PLACEHOLDER</p> 形式）
    html = html.replace(/<p>\u0000([CcmMV])(\d+)\u0000<\/p>/g, function (m, kind, i) {
      const b = blocks[+i];
      if (!b) return m;
      if (b.kind === 'code') return buildCodeBlock(b);
      if (b.kind === 'math') return renderMath(b.tex, b.display);
      if (b.kind === 'viz') return renderViz(b.html);
      return m;
    });

    // 6. 恢复行内占位符
    html = html.replace(/\u0000([CcmMV])(\d+)\u0000/g, function (m, kind, i) {
      const b = blocks[+i];
      if (!b) return m;
      if (b.kind === 'code') return '<code>' + escapeHtml(b.code) + '</code>';
      if (b.kind === 'icode') return '<code>' + escapeHtml(b.code) + '</code>';
      if (b.kind === 'math') return renderMath(b.tex, b.display);
      if (b.kind === 'viz') return renderViz(b.html);
      return m;
    });

    return html;
  }

  /* ---------------- 富讲解：白名单清洗 + 可视化组件 ---------------- */

  const BAD_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'select', 'option', 'button', 'audio', 'video', 'source', 'track', 'canvas'];

  /** 白名单清洗：去危险标签、去 on* 事件与 javascript: 协议 */
  function sanitizeHtml(html) {
    let out = String(html);
    // 去危险标签（含内容）
    BAD_TAGS.forEach(function (tag) {
      out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), '');
      out = out.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), '');
    });
    // 去 on* 事件属性
    out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // 去 javascript: / data:text/html 协议
    out = out.replace(/(href|src|xlink:href)\s*=\s*("|')?\s*(javascript|data:text\/html)[^"'\s>]*/gi, '$1="#"');
    return out;
  }

  function attr(attrs, name) {
    const m = String(attrs).match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i')) || String(attrs).match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'));
    return m ? m[1] : '';
  }

  function numList(v) {
    return String(v || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x.length; });
  }

  /** 组件内部的轻量行内渲染：转义 HTML 后支持 $公式$ / **粗体** / `代码` / 换行 */
  function inlineRich(text) {
    let s = escapeHtml(String(text == null ? '' : text).trim());
    s = s.replace(/\$([^$\n]+?)\$/g, function (m, tex) { return renderMath(tex, false); });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  /** 把 <viz-*> 组件渲染为可视化 HTML */
  function renderViz(raw) {
    const tagM = String(raw).match(/^<(viz-[a-z]+)([^>]*)>/i);
    if (!tagM) return escapeHtml(raw);
    const name = tagM[1].toLowerCase();
    const attrs = tagM[2] || '';
    const inner = String(raw).replace(/^<viz-[a-z]+[^>]*>/i, '').replace(/<\/viz-[a-z]+>\s*$/i, '').replace(/\/>\s*$/, '');
    const title = attr(attrs, 'title');

    if (name === 'viz-callout') {
      const type = (attr(attrs, 'type') || 'idea').toLowerCase();
      return '<div class="viz-callout viz-' + escapeHtml(type) + '">'
        + (title ? '<div class="viz-callout-title">' + escapeHtml(title) + '</div>' : '')
        + '<div class="viz-callout-body">' + inner + '</div></div>';
    }

    if (name === 'viz-array') {
      const values = numList(attr(attrs, 'values'));
      const hi = numList(attr(attrs, 'highlight')).map(Number);
      const ptrs = numList(attr(attrs, 'ptr'));       // 形如 i:1
      const ptrMap = {};
      ptrs.forEach(function (p) {
        const parts = p.split(':');
        if (parts.length === 2) ptrMap[Number(parts[1])] = parts[0];
      });
      let cells = '';
      values.forEach(function (v, i) {
        const cls = hi.indexOf(i) >= 0 ? ' viz-cell-hi' : '';
        cells += '<div class="viz-cell' + cls + '">'
          + '<div class="viz-cell-val">' + escapeHtml(v) + '</div>'
          + '<div class="viz-cell-idx">' + i + '</div>'
          + (ptrMap[i] ? '<div class="viz-ptr">' + escapeHtml(ptrMap[i]) + '</div>' : '')
          + '</div>';
      });
      return '<div class="viz-box"><div class="viz-title">' + escapeHtml(title || '数组状态') + '</div>'
        + '<div class="viz-array">' + cells + '</div></div>';
    }

    if (name === 'viz-bars') {
      const values = numList(attr(attrs, 'values')).map(Number);
      const labels = numList(attr(attrs, 'labels'));
      const max = Number(attr(attrs, 'max')) || Math.max.apply(null, values.concat([1]));
      let bars = '';
      values.forEach(function (v, i) {
        const h = Math.max(4, Math.round((v / max) * 90));
        bars += '<div class="viz-bar-col">'
          + '<div class="viz-bar" style="height:' + h + '%"><span>' + v + '</span></div>'
          + '<div class="viz-bar-label">' + escapeHtml(labels[i] || i) + '</div></div>';
      });
      return '<div class="viz-box"><div class="viz-title">' + escapeHtml(title || '数值对比') + '</div><div class="viz-bars">' + bars + '</div></div>';
    }

    if (name === 'viz-flow') {
      const nodes = [];
      const re = /<viz-node[^>]*>([\s\S]*?)<\/viz-node>/gi;
      let m;
      while ((m = re.exec(inner)) !== null) nodes.push(m[1]);
      return '<div class="viz-box"><div class="viz-title">' + escapeHtml(title || '流程') + '</div><div class="viz-flow">'
        + nodes.map(function (n, i) { return (i ? '<span class="viz-arrow">→</span>' : '') + '<span class="viz-node">' + n + '</span>'; }).join('')
        + '</div></div>';
    }

    if (name === 'viz-steps') {
      const steps = [];
      const re = /<viz-step[^>]*title\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/viz-step>/gi;
      let m;
      while ((m = re.exec(inner)) !== null) steps.push({ title: m[1], body: m[2] });
      if (!steps.length) return escapeHtml(raw);
      return '<div class="viz-box viz-steps" data-step-total="' + steps.length + '">'
        + '<div class="viz-title">' + escapeHtml(title || '分步演示') + '</div>'
        + '<div class="viz-step-nav"><button class="viz-step-btn" data-step-prev>‹ 上一步</button>'
        + '<span class="viz-step-pos" data-step-pos>1 / ' + steps.length + '</span>'
        + '<button class="viz-step-btn" data-step-next>下一步 ›</button></div>'
        + steps.map(function (s, i) {
          return '<div class="viz-step" data-step="' + i + '"' + (i === 0 ? '' : ' hidden') + '>'
            + '<div class="viz-step-title">' + escapeHtml(s.title) + '</div>'
            + '<div class="viz-step-body">' + s.body + '</div></div>';
        }).join('')
        + '</div>';
    }

    // 方案对比双栏：<viz-compare><viz-a title="堆贪心">…</viz-a><viz-b title="排序枚举">…</viz-b></viz-compare>
    // 也支持极简写法：<viz-compare a="标题A" b="标题B">左侧 || 右侧</viz-compare>
    if (name === 'viz-compare') {
      const sides = [];
      const sideRe = /<viz-([ab])([^>]*)>([\s\S]*?)<\/viz-\1>/gi;
      let sm;
      while ((sm = sideRe.exec(inner)) !== null) {
        sides.push({ kind: sm[1].toLowerCase(), title: attr(sm[2], 'title'), body: sm[3] });
      }
      if (sides.length < 2) {
        const parts = String(inner).split('||');
        if (parts.length >= 2) {
          sides.length = 0;
          sides.push({ kind: 'a', title: attr(attrs, 'a') || '✅ 优点', body: parts[0] });
          sides.push({ kind: 'b', title: attr(attrs, 'b') || '❌ 代价', body: parts.slice(1).join('||') });
        }
      }
      if (sides.length < 2) return '<div class="viz-box">' + inlineRich(inner) + '</div>';
      return '<div class="viz-box viz-compare-wrap">'
        + (title ? '<div class="viz-title">' + escapeHtml(title) + '</div>' : '')
        + '<div class="viz-compare">'
        + sides.slice(0, 2).map(function (s) {
          return '<div class="viz-side viz-side-' + s.kind + '">'
            + (s.title ? '<div class="viz-side-title">' + escapeHtml(s.title) + '</div>' : '')
            + '<div class="viz-side-body">' + inlineRich(s.body) + '</div></div>';
        }).join('')
        + '</div></div>';
    }

    // 自测题：<viz-quiz title="自测"><viz-q q="问题？" a="答案">解析</viz-q></viz-quiz>
    if (name === 'viz-quiz') {
      const qs = [];
      const qRe = /<viz-q([^>]*)>([\s\S]*?)<\/viz-q>/gi;
      let qm;
      while ((qm = qRe.exec(inner)) !== null) {
        qs.push({ q: attr(qm[1], 'q'), a: attr(qm[1], 'a'), body: qm[2] });
      }
      const qqRe = /<viz-q([^>]*)\/>/gi;
      while ((qm = qqRe.exec(inner)) !== null) {
        qs.push({ q: attr(qm[1], 'q'), a: attr(qm[1], 'a'), body: '' });
      }
      if (!qs.length) return '<div class="viz-box">' + inlineRich(inner) + '</div>';
      return '<div class="viz-box viz-quiz-wrap">'
        + '<div class="viz-title">' + escapeHtml(title || '自测') + '</div><div class="viz-quiz">'
        + qs.map(function (it, i) {
          return '<div class="viz-q"><div class="viz-qh" data-quiz-toggle><span class="viz-q-idx">' + (i + 1) + '</span>'
            + inlineRich(it.q) + '<span class="viz-q-caret">▾</span></div>'
            + '<div class="viz-qa" hidden>' + (it.a ? '<p class="viz-q-ans">' + inlineRich(it.a) + '</p>' : '')
            + (it.body ? '<div class="viz-q-why">' + inlineRich(it.body) + '</div>' : '') + '</div></div>';
        }).join('')
        + '</div></div>';
    }

    // 公式块：<viz-formula fx="$T(n)=O(n\log n)$" legend="n=牌数; h=堆大小" why="大白话解释" title="复杂度"/>
    if (name === 'viz-formula') {
      const fx = attr(attrs, 'fx');
      const legend = attr(attrs, 'legend');
      const why = attr(attrs, 'why');
      const body = String(inner || '').trim();
      return '<div class="viz-box viz-formula">'
        + (title ? '<div class="viz-title">' + escapeHtml(title) + '</div>' : '')
        + '<div class="viz-fx">' + (fx ? inlineRich(fx) : inlineRich(body)) + '</div>'
        + (legend ? '<div class="viz-legend">' + legend.split(';').map(function (pair) {
          const kv = pair.split('=');
          if (kv.length < 2) return '';
          return '<div class="viz-legend-row"><span class="viz-legend-k">' + inlineRich(kv[0]) + '</span>'
            + '<span class="viz-legend-v">' + inlineRich(kv.slice(1).join('=')) + '</span></div>';
        }).join('') + '</div>' : '')
        + (why ? '<div class="viz-why"><b>它在说什么：</b>' + inlineRich(why) + '</div>' : '')
        + (!fx && body ? '' : '')
        + '</div>';
    }

    return escapeHtml(raw);
  }

  /** 分步演示 / 自测题的交互（事件委托，全局只需绑定一次） */
  function bindVizClicks(root) {
    (root || document).addEventListener('click', function (e) {
      // 自测题：点题干展开答案
      const qh = e.target.closest('[data-quiz-toggle]');
      if (qh) {
        const qa = qh.parentNode.querySelector('.viz-qa');
        if (qa) {
          qa.hidden = !qa.hidden;
          qh.classList.toggle('open', !qa.hidden);
        }
        return;
      }
      const btn = e.target.closest('[data-step-next], [data-step-prev]');
      if (!btn) return;
      const wrap = btn.closest('.viz-steps');
      if (!wrap) return;
      const total = parseInt(wrap.getAttribute('data-step-total'), 10) || 1;
      const posEl = wrap.querySelector('[data-step-pos]');
      let cur = parseInt(wrap.getAttribute('data-step-cur') || '0', 10);
      cur = btn.hasAttribute('data-step-next') ? Math.min(total - 1, cur + 1) : Math.max(0, cur - 1);
      wrap.setAttribute('data-step-cur', String(cur));
      wrap.querySelectorAll('.viz-step').forEach(function (el) {
        el.hidden = Number(el.getAttribute('data-step')) !== cur;
      });
      if (posEl) posEl.textContent = (cur + 1) + ' / ' + total;
    });
  }

  /* ---------------- 时间 / 尺寸格式化 ---------------- */

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatTime(ts) {
    const dt = new Date(ts);
    const now = new Date();
    const time = pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    if (now.toDateString() === dt.toDateString()) return time;
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + time;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const m = 60000, h = 3600000, d = 86400000;
    if (diff < m) return '刚刚';
    if (diff < h) return Math.floor(diff / m) + ' 分钟前';
    if (diff < d) return Math.floor(diff / h) + ' 小时前';
    if (diff < 7 * d) return Math.floor(diff / d) + ' 天前';
    const dt = new Date(ts);
    const sameYear = dt.getFullYear() === new Date().getFullYear();
    return sameYear
      ? (dt.getMonth() + 1) + '月' + dt.getDate() + '日'
      : dt.getFullYear() + '年' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  /** 侧边栏分组标签 */
  function groupLabel(ts) {
    const dt = new Date(ts);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 86400000;
    if (ts >= startOfDay) return '今天';
    if (ts >= startOfDay - dayMs) return '昨天';
    if (ts >= startOfDay - 7 * dayMs) return '7 天内';
    if (dt.getFullYear() === now.getFullYear()) return (dt.getMonth() + 1) + '月';
    return dt.getFullYear() + '年';
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /** 紧凑计数（12.3K / 1.2M） */
  function fmtCount(n) {
    const x = Number(n) || 0;
    if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (x >= 1e4) return (x / 1e3).toFixed(1) + 'K';
    return String(x);
  }

  function formatTokens(msg) {
    if (!msg || !msg.usage) return '';
    const u = msg.usage;
    const est = u.estimated ? '约 ' : '';
    const parts = [];
    if (u.promptTokens != null) parts.push('输入 ' + fmtCount(u.promptTokens));
    if (u.completionTokens != null) parts.push('输出 ' + fmtCount(u.completionTokens));
    if (!parts.length) return '';
    return est + parts.join(' · ') + ' tokens';
  }

  /**
   * 这题花了多少：整轮多 Agent 的 token 汇总 + 估算费用。
   * 费用按"参考单价表 / 用户自定义单价"估算；没有单价时只报 token —— 不编数字。
   */
  function formatCost(msg) {
    if (!msg || !msg.usage) return '';
    const u = msg.usage;
    const bits = [];
    if (u.calls) bits.push(u.calls + ' 次调用');
    if (u.cost) {
      const money = u.cost.amount >= 0.01 ? u.cost.amount.toFixed(2) : u.cost.amount.toFixed(4);
      // 服务商没返回缓存命中 token 时，我们只能按全价输入估 → 实际账单通常更低，如实说明
      bits.push('≈ ¥' + money + (u.cost.estimated ? '（估）' : (u.cost.cacheUnknown ? '（未含缓存折扣，实际通常更低）' : '（含缓存折扣）')));
    }
    return bits.join(' · ');
  }

  window.MD = {
    renderMarkdown: renderMarkdown,
    bindVizClicks: bindVizClicks,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    timeAgo: timeAgo,
    groupLabel: groupLabel,
    formatBytes: formatBytes,
    formatTokens: formatTokens,
    formatCost: formatCost,
    fmtCount: fmtCount,
    hasKatex: !!KATEX
  };
})();
