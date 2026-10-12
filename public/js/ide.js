/**
 * public/js/ide.js — 内嵌 IDE 的前端（写代码 + 按按钮出现半透明补全 + 自己填 stdin 跑一次）
 *
 * 编辑器怎么叠出来的（三层对齐，和 github 的 copilot 幽灵文字一个思路）：
 *   1. `<pre class="ide-hl">`  —— 语法高亮的**可见**文本层。幽灵提示也画在这一层里：
 *      把"光标前的代码"和"光标后的代码"分别高亮，中间插入 `<span class="ide-ghost">`。
 *      因为幽灵插在光标处，所以光标之前的部分与 textarea 完全对齐 → 提示正好落在光标右边。
 *   2. `<textarea class="ide-input">` —— 真输入层，字色透明、只留 caret 与选区，负责键盘输入/撤销/输入法。
 *   3. `.ide-gutter` —— 行号，跟着 textarea 的 scrollTop 走。
 *   三层共用同一套 font-family/size/line-height/padding 且 `white-space: pre`（不折行），
 *   所以只要把滚动同步一下，它们就是完全重合的（同步见 syncScroll）。
 *
 * 纪律（与 lib/ide.js、AGENTS.md 一致）：
 *   - 只有按「补全 / 提示」按钮才发起模型调用，**不做随打字的自动补全**（每次都是真金白银）。
 *   - 幽灵文字永远是"建议"：Tab/点「接受」才落进代码，Esc/继续打字/点别处就丢弃。
 *   - 补全只看题面 + 你自己写的代码（服务端只读会话本地字段，不读教练已验证的题解）。
 *
 * 这个文件是 UMD 形态：浏览器里挂 `window.CFIde`；Node 里 require 进来能拿到纯函数
 * （acceptSuggestion / lineNumbers / highlightToHtml / escapeHtml / capOutput），
 * scripts/test-ide.js 就是靠这一点在没有浏览器的情况下测它的。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFIde = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * IDE 只有两种语言：C++23 与 Python 3。
   * 为什么没有 JavaScript：这是**竞赛**编辑器，补全的提示词、围栏语言、注释符号都按竞赛语言写；
   * 多挂一种语言只会在"模型按别的语言给写法"时添乱。老状态里存过的 'js' 会回落到默认的 C++。
   */
  var LANGS = [
    { v: 'cpp', label: 'C++23' },
    { v: 'python', label: 'Python 3' }
  ];
  var REPORT_LS_KEY = 'cfide.report';    // 右侧讲解栏是否收起（记住学员的选择）
  var OUTPUT_CAP = 8000;      // 界面里最多显示多少字符的输出（再长就截断并提示）
  var SAVE_DEBOUNCE_MS = 900;
  var HIGHLIGHT_DEBOUNCE_MS = 30;

  /* ---------------- 纯函数（可单测） ---------------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function langOf(lang) {
    var s = String(lang == null ? '' : lang).toLowerCase();
    if (s === 'python' || s === 'py' || s === 'python3' || s === 'pypy') return 'python';
    return 'cpp';   // 只认 C++ 与 Python（js/javascript/node 也回落到 C++）
  }
  function hljsName(lang) {
    return langOf(lang) === 'python' ? 'python' : 'cpp';
  }
  function langLabel(lang) {
    var l = langOf(lang);
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].v === l) return LANGS[i].label;
    return l;
  }

  /**
   * 高亮一段代码 → HTML。
   * 语言没注册就直接转义（**不猜**：编辑器里半截代码用 highlightAuto 会染成随机语言，比不染色更难看）。
   * @param {string} code
   * @param {string} lang
   * @param {object} [hljsLib] 测试用注入；缺省取 window.hljs
   */
  function highlightToHtml(code, lang, hljsLib) {
    var src = String(code == null ? '' : code);
    if (!src) return '';
    var H = hljsLib || (typeof window !== 'undefined' ? window.hljs : null);
    if (H && typeof H.highlight === 'function' && typeof H.getLanguage === 'function') {
      var name = hljsName(lang);
      try {
        if (H.getLanguage(name)) return H.highlight(src, { language: name, ignoreIllegals: true }).value;
      } catch (e) { /* 高亮失败不能影响写代码 */ }
    }
    return escapeHtml(src);
  }

  function lineNumbers(count) {
    var n = Math.max(1, Number(count) || 1);
    var out = [];
    for (var i = 1; i <= n; i++) out.push(String(i));
    return out;
  }

  /** 把一段补全插进光标处，返回新的代码与新的光标位置 */
  function acceptSuggestion(code, caret, text) {
    var src = String(code == null ? '' : code);
    var at = Math.max(0, Math.min(src.length, Number(caret) || 0));
    var ins = String(text == null ? '' : text);
    return { code: src.slice(0, at) + ins + src.slice(at), caret: at + ins.length };
  }

  function capOutput(text, cap) {
    var s = String(text == null ? '' : text);
    var c = Number(cap) || OUTPUT_CAP;
    if (s.length <= c) return { text: s, truncated: false };
    return { text: s.slice(0, c), truncated: true };
  }

  function verdictText(v) {
    if (v === 'OK') return '运行成功';
    if (v === 'TLE') return '超时';
    if (v === 'RE') return '运行错误';
    if (v === 'CE') return '编译失败';
    if (v === 'EMPTY') return '代码为空';
    return v || '未知';
  }

  /**
   * 渲染编辑器可见层：光标前的代码 + 幽灵提示 + 光标后的代码。
   * @returns {string} HTML
   */
  function renderLayerHtml(code, caret, ghost, lang, hljsLib) {
    var src = String(code == null ? '' : code);
    var at = Math.max(0, Math.min(src.length, Number(caret) || 0));
    if (!ghost) return highlightToHtml(src, lang, hljsLib);
    return highlightToHtml(src.slice(0, at), lang, hljsLib)
      + '<span class="ide-ghost">' + escapeHtml(ghost) + '</span>'
      + highlightToHtml(src.slice(at), lang, hljsLib);
  }

  /* ---------------- DOM 部分 ---------------- */

  var deps = { api: null, toast: null };
  var el = null;               // { page, ta, hl, gutter, ... }
  var mounted = false;
  var curConvId = null;

  function lsGet(k) {
    try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* 存不了就算了 */ }
  }

  var st = {
    lang: 'cpp',
    configured: false,
    model: '',
    hasProblem: true,
    problem: null,
    ghost: null,          // { text, caret, mode }
    busy: false,
    dirty: false,
    saveTimer: null,
    hlTimer: null,
    lastSaved: 0,
    /**
     * 右侧「讲题报告」：跟着当前会话最新一份讲解走（图文文档优先，否则用文字讲解的正文）。
     * 它**只展示**教练已经讲过的东西，不额外调用模型（IDE 只有在按补全/提示时才花钱）。
     */
    report: null,         // { id, html } 或 { id, text }
    reportKey: '',
    reportCollapsed: lsGet(REPORT_LS_KEY) === '1'
  };

  function q(sel) { return document.querySelector(sel); }

  function setStatus(msg) {
    if (el && el.status) el.status.textContent = msg || '';
  }

  function toast(msg, type) {
    if (typeof deps.toast === 'function') deps.toast(msg, type || 'info', type === 'error' ? 5000 : 2600);
  }

  function buildDom(page) {
    var opts = LANGS.map(function (l) { return '<option value="' + l.v + '">' + l.label + '</option>'; }).join('');
    page.innerHTML = ''
      + '<div class="ide-wrap" data-ide-wrap>'
      + '  <div class="ide-head">'
      + '    <div class="ide-title"><span class="ide-problem" data-ide-problem>未关联题目</span>'
      + '      <span class="ide-sub" data-ide-sub></span></div>'
      + '    <div class="ide-tools">'
      + '      <select class="form-select ide-lang" data-ide-lang title="语言">' + opts + '</select>'
      + '      <button class="ide-btn primary" data-ide-complete title="让模型接着你的光标往下写一小段（Tab 接受 / Esc 丢弃）">✨ 补全</button>'
      + '      <button class="ide-btn" data-ide-hint title="只要思路点拨，不写代码">💡 提示</button>'
      + '      <button class="ide-btn" data-ide-accept hidden title="把提示落进代码">接受</button>'
      + '      <button class="ide-btn" data-ide-report-toggle title="展开 / 收起右边的讲题报告（写代码时也能看着它）">📄 讲解</button>'
      + '      <span class="ide-status" data-ide-status></span>'
      + '    </div>'
      + '  </div>'
      + '  <div class="ide-cols">'
      + '    <div class="ide-col-edit">'
      + '      <div class="ide-main">'
      + '        <div class="ide-gutter" data-ide-gutter></div>'
      + '        <div class="ide-editor">'
      + '          <pre class="ide-hl ide-layer hljs" data-ide-hl aria-hidden="true"><code></code></pre>'
      + '          <textarea class="ide-input ide-layer" data-ide-input spellcheck="false" wrap="off"'
      + '            placeholder="在这里写你的代码…（写到一半卡住了就按上面的「✨ 补全」，模型会在光标处给一段半透明的提示）"></textarea>'
      + '          <div class="ide-ghost-hint" data-ide-ghost-hint hidden>Tab 接受 · Esc 丢弃</div>'
      + '        </div>'
      + '      </div>'
      + '      <div class="ide-foot">'
      + '        <div class="ide-foot-left">'
      + '          <div class="ide-foot-label">测试输入（stdin）<span class="ide-foot-note">自己造数据调试，不比对答案</span></div>'
      + '          <textarea class="ide-stdin" data-ide-stdin spellcheck="false" placeholder="例如：&#10;3&#10;1 2 3"></textarea>'
      + '        </div>'
      + '        <div class="ide-foot-right">'
      + '          <div class="ide-foot-label">运行结果'
      + '            <button class="ide-btn" data-ide-run title="用上面的输入跑一次你的代码">▶ 运行</button>'
      + '            <span class="ide-verdict" data-ide-verdict></span>'
      + '          </div>'
      + '          <pre class="ide-output" data-ide-output></pre>'
      + '        </div>'
      + '      </div>'
      + '    </div>'
      + '    <aside class="ide-report" data-ide-report>'
      + '      <div class="ide-report-head">'
      + '        <span class="ide-report-title">讲题报告</span>'
      + '        <span class="ide-report-badge" data-ide-report-badge></span>'
      + '        <button class="ide-report-close" data-ide-report-close title="收起讲解（编辑器会更宽）">✕</button>'
      + '      </div>'
      + '      <div class="ide-report-body" data-ide-report-body></div>'
      + '    </aside>'
      + '  </div>'
      + '</div>';

    el = {
      page: page,
      wrap: q('[data-ide-wrap]'),
      problem: q('[data-ide-problem]'),
      sub: q('[data-ide-sub]'),
      lang: q('[data-ide-lang]'),
      btnComplete: q('[data-ide-complete]'),
      btnHint: q('[data-ide-hint]'),
      btnAccept: q('[data-ide-accept]'),
      btnRun: q('[data-ide-run]'),
      btnReport: q('[data-ide-report-toggle]'),
      btnReportClose: q('[data-ide-report-close]'),
      report: q('[data-ide-report]'),
      reportBody: q('[data-ide-report-body]'),
      reportBadge: q('[data-ide-report-badge]'),
      status: q('[data-ide-status]'),
      gutter: q('[data-ide-gutter]'),
      hl: q('[data-ide-hl]'),
      ta: q('[data-ide-input]'),
      ghostHint: q('[data-ide-ghost-hint]'),
      stdin: q('[data-ide-stdin]'),
      output: q('[data-ide-output]'),
      verdict: q('[data-ide-verdict]')
    };
    mounted = true;
    bindEvents();
  }

  function bindEvents() {
    el.ta.addEventListener('input', function () {
      dismissGhost();
      st.dirty = true;
      scheduleHighlight();
      scheduleSave();
    });
    el.ta.addEventListener('scroll', syncScroll);
    el.ta.addEventListener('keydown', onKeyDown);
    // 光标被鼠标/键盘挪走 → 幽灵提示已经不对位了，直接丢弃（别让提示停在错的位置）
    ['keyup', 'mouseup', 'select'].forEach(function (ev) {
      el.ta.addEventListener(ev, function () {
        if (st.ghost && el.ta.selectionStart !== st.ghost.caret) dismissGhost();
      });
    });
    el.ta.addEventListener('blur', function () { dismissGhost(); flushSave(); });
    el.lang.addEventListener('change', function () {
      st.lang = langOf(el.lang.value);
      st.dirty = true;
      scheduleHighlight();
      scheduleSave();
    });
    el.btnComplete.addEventListener('click', function () { complete('continue'); });
    el.btnHint.addEventListener('click', function () { complete('hint'); });
    el.btnAccept.addEventListener('click', acceptGhost);
    el.btnRun.addEventListener('click', runCode);
    if (el.btnReport) el.btnReport.addEventListener('click', function () { toggleReport(); });
    if (el.btnReportClose) el.btnReportClose.addEventListener('click', function () { toggleReport(true); });
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushSave);
  }

  function onKeyDown(e) {
    if (e.key === 'Tab' && st.ghost) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    if (e.key === 'Escape' && st.ghost) {
      e.preventDefault();
      dismissGhost();
      return;
    }
    // 任何别的按键都当"我想自己写" → 丢弃提示（与 copilot 一致）
    if (st.ghost && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
      dismissGhost();
    }
  }

  function syncScroll() {
    if (!el) return;
    el.hl.scrollTop = el.ta.scrollTop;
    el.hl.scrollLeft = el.ta.scrollLeft;
    el.gutter.scrollTop = el.ta.scrollTop;
  }

  function renderGutter() {
    var n = el.ta.value.split('\n').length;
    if (el.gutter.childElementCount !== n) {
      el.gutter.innerHTML = lineNumbers(n).map(function (x) { return '<div>' + x + '</div>'; }).join('');
    }
    el.gutter.scrollTop = el.ta.scrollTop;
  }

  function paint() {
    if (!el) return;
    var caret = el.ta.selectionStart == null ? el.ta.value.length : el.ta.selectionStart;
    var ghost = st.ghost && st.ghost.caret === caret ? st.ghost.text : null;
    var html = renderLayerHtml(el.ta.value, caret, ghost, st.lang, typeof window !== 'undefined' ? window.hljs : null);
    el.hl.innerHTML = '<code>' + html + '</code>' + (el.ta.value.slice(-1) === '\n' ? '\n' : '');
    if (st.ghost && st.ghost.caret !== caret) dismissGhost();
    renderGutter();
    if (el.ghostHint) el.ghostHint.hidden = !st.ghost;
    if (el.btnAccept) el.btnAccept.hidden = !st.ghost;
    syncScroll();
  }

  function scheduleHighlight() {
    if (st.hlTimer) return;
    st.hlTimer = setTimeout(function () {
      st.hlTimer = null;
      paint();
    }, HIGHLIGHT_DEBOUNCE_MS);
  }

  /* ---------------- 幽灵提示 ---------------- */

  function setGhost(text) {
    st.ghost = { text: text, caret: el.ta.selectionStart == null ? 0 : el.ta.selectionStart, mode: st.mode || 'continue' };
    paint();
  }

  function dismissGhost() {
    if (!st.ghost) return;
    st.ghost = null;
    paint();
  }

  function acceptGhost() {
    if (!st.ghost) return;
    var r = acceptSuggestion(el.ta.value, st.ghost.caret, st.ghost.text);
    el.ta.value = r.code;
    el.ta.selectionStart = el.ta.selectionEnd = r.caret;
    st.ghost = null;
    st.dirty = true;
    paint();
    scheduleSave();
    setStatus('已插入提示（记得自己检查一遍）');
  }

  /* ---------------- 右侧「讲题报告」（写代码时也能看着讲解） ---------------- */

  /** FNV-1a：只用来判断"还是不是同一份报告"（内容变了才重建 iframe，不然每次重画都闪一下） */
  function hashString(s) {
    var str = String(s == null ? '' : s);
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(36);
  }

  function reportKeyOf(rep) {
    if (!rep) return '';
    var body = rep.html ? rep.html : rep.text;
    return String(rep.id || '') + '|' + (rep.html ? 'doc' : 'text') + '|' + hashString(body);
  }

  function renderReport() {
    if (!el || !el.reportBody) return;
    var rep = st.report;
    if (el.wrap) el.wrap.classList.toggle('report-collapsed', !!st.reportCollapsed);
    if (el.report) el.report.hidden = !!st.reportCollapsed;
    if (el.btnReport) el.btnReport.textContent = st.reportCollapsed ? '📄 讲解' : '📄 收起';
    if (el.reportBadge) el.reportBadge.textContent = rep ? (rep.html ? '图文文档' : '文字讲解') : '暂无';
    var host = el.reportBody;
    if (!rep) {
      host.innerHTML = '<div class="ide-report-empty">这道题还没有讲解。<br>'
        + '回到对话页让教练讲一遍，最新一份会同步显示在这里（写代码时一直看得见）。</div>';
      return;
    }
    if (rep.html) {
      // 与对话页同一套隔离：sandbox iframe + srcdoc（允许脚本，但没有同源权限、不能做顶层跳转）
      host.innerHTML = '';
      var iframe = document.createElement('iframe');
      iframe.className = 'ide-report-frame';
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.srcdoc = rep.html;
      host.appendChild(iframe);
      return;
    }
    var md = (typeof window !== 'undefined' && window.MD && typeof window.MD.renderMarkdown === 'function')
      ? window.MD.renderMarkdown(String(rep.text || ''))
      : '<pre class="ide-report-pre">' + escapeHtml(String(rep.text || '')) + '</pre>';
    host.innerHTML = '<div class="ide-report-md">' + md + '</div>';
  }

  /** app.js 在会话/讲解变化时调用（内容没变就直接返回，避免重建 iframe） */
  function setReport(rep) {
    var next = rep || null;
    var key = reportKeyOf(next);
    if (key === st.reportKey && mounted) return;
    st.reportKey = key;
    st.report = next;
    if (mounted) renderReport();
  }

  function toggleReport(forceCollapse) {
    st.reportCollapsed = forceCollapse === true ? true : !st.reportCollapsed;
    lsSet(REPORT_LS_KEY, st.reportCollapsed ? '1' : '0');
    renderReport();
  }

  /* ---------------- 与服务器交互 ---------------- */

  function scheduleSave() {
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (!el) return;
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
    if (!st.dirty) return;
    st.dirty = false;
    var payload = { convId: curConvId || '', lang: st.lang, code: el.ta.value };
    Promise.resolve()
      .then(function () { return deps.api('/api/ide/save', { method: 'POST', body: JSON.stringify(payload) }); })
      .then(function () {
        st.lastSaved = Date.now();
        setStatus('已保存');
      })
      .catch(function (e) {
        st.dirty = true;
        toast('代码保存失败：' + e.message, 'error');
      });
  }

  function complete(mode) {
    if (!el || st.busy) return;
    if (!st.configured) { toast('还没有可用的模型服务：先去「设置 → 模型服务」配一个', 'error'); return; }
    st.busy = true;
    st.mode = mode;
    el.btnComplete.disabled = true;
    el.btnHint.disabled = true;
    setStatus(mode === 'hint' ? '要提示中…' : '补全中…');
    var caret = el.ta.selectionStart == null ? 0 : el.ta.selectionStart;
    var body = { convId: curConvId || '', lang: st.lang, code: el.ta.value, caret: caret, mode: mode };
    deps.api('/api/ide/complete', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) {
        if (!r || !r.ok || !r.text) {
          setStatus('');
          toast((r && r.error) || '模型没有给出可用的补全', 'error');
          return;
        }
        setGhost(r.text);
        var bits = [];
        if (r.ms) bits.push((r.ms / 1000).toFixed(1) + 's');
        if (r.usage) bits.push((r.usage.promptTokens || 0) + '→' + (r.usage.completionTokens || 0) + ' tokens');
        if (r.cost && r.cost.amount != null) bits.push('≈¥' + Number(r.cost.amount).toFixed(4));
        if (r.capped) bits.push('已截断');
        if (!st.hasProblem) bits.push('本题没题面，只能依据代码');
        setStatus((mode === 'hint' ? '提示：' : '补全：') + bits.join(' · '));
      })
      .catch(function (e) {
        setStatus('');
        toast('补全失败：' + e.message, 'error');
      })
      .then(function () {
        st.busy = false;
        if (el) { el.btnComplete.disabled = false; el.btnHint.disabled = false; }
      });
  }

  function runCode() {
    if (!el || st.busy) return;
    var code = el.ta.value;
    if (!code.trim()) { toast('先写点代码再运行', 'error'); return; }
    st.busy = true;
    el.btnRun.disabled = true;
    el.verdict.textContent = '运行中…';
    el.verdict.className = 'ide-verdict';
    el.output.textContent = '';
    flushSave();
    deps.api('/api/ide/run', {
      method: 'POST',
      body: JSON.stringify({ lang: st.lang, code: code, input: el.stdin.value })
    }).then(function (r) {
      var cls = r.verdict === 'OK' ? 'ok' : (r.verdict === 'TLE' ? 'warn' : 'bad');
      el.verdict.className = 'ide-verdict ' + cls;
      el.verdict.textContent = verdictText(r.verdict) + (r.timeMs != null ? ' · ' + r.timeMs + 'ms' : '')
        + (r.exitCode != null && r.exitCode !== 0 ? ' · 退出码 ' + r.exitCode : '');
      var parts = [];
      if (r.stdout) parts.push(capOutput(r.stdout).text);
      if (r.truncated) parts.push('\n…（输出过长，只显示前 ' + OUTPUT_CAP + ' 字符）');
      if (r.stderr) parts.push('\n[stderr]\n' + capOutput(r.stderr).text);
      if (r.error && !r.stderr) parts.push('\n' + r.error);
      if (!parts.length) parts.push('（没有输出）');
      el.output.textContent = parts.join('\n');
    }).catch(function (e) {
      el.verdict.className = 'ide-verdict bad';
      el.verdict.textContent = '运行失败';
      el.output.textContent = e.message;
    }).then(function () {
      st.busy = false;
      if (el) el.btnRun.disabled = false;
    });
  }

  function applyProblem(p) {
    var prob = p.problem || {};
    if (el.problem) {
      el.problem.textContent = prob.title || '未关联题目';
      el.problem.title = prob.title || '';
    }
    if (el.sub) {
      var bits = [];
      if (prob.rating) bits.push('rating ' + prob.rating);
      if (prob.tags && prob.tags.length) bits.push(prob.tags.slice(0, 4).join(' / '));
      if (!p.hasProblem) bits.push('本题没有本地题面 → 补全只能依据你的代码');
      el.sub.textContent = bits.join(' · ');
    }
  }

  function loadInto(page, convId) {
    if (!mounted) buildDom(page);
    setStatus('加载中…');
    deps.api('/api/ide?convId=' + encodeURIComponent(convId || ''))
      .then(function (r) {
        st.lang = langOf(r.lang);
        st.configured = !!r.configured;
        st.model = r.model || '';
        st.hasProblem = !!r.hasProblem;
        st.problem = r.problem || null;
        st.ghost = null;
        st.dirty = false;
        el.lang.value = st.lang;
        el.ta.value = r.code || '';
        el.ta.selectionStart = el.ta.selectionEnd = el.ta.value.length;
        el.stdin.value = '';
        el.output.textContent = '';
        el.verdict.textContent = '';
        applyProblem(r);
        paint();
        renderReport();     // 右侧讲解：open() 里 setReport 存下的那份（可能是已讲过的图文文档）
        setStatus(r.configured ? ('模型：' + st.model) : '还没有配置模型服务（补全不可用，但可以自己写、自己跑）');
      })
      .catch(function (e) {
        setStatus('');
        toast('IDE 加载失败：' + e.message, 'error');
      });
  }

  /** 页面进入时调用（app.js 的 switchView('ide') 分支）；同一题重复进入不会重新拉取 */
  function open(opts) {
    var o = opts || {};
    if (o.api) deps.api = o.api;
    if (o.toast) deps.toast = o.toast;
    if (typeof document === 'undefined') return;
    var page = document.getElementById('page-ide');
    if (!page || typeof deps.api !== 'function') return;
    var convId = o.convId || '';
    // 讲解永远跟着当前会话走：同一道题再进来也要把最新一份同步过来（可能刚从对话页拿到图文文档）
    if (o.report !== undefined) setReport(o.report);
    if (mounted && convId === curConvId) { paint(); return; }
    if (mounted) flushSave();      // 切到另一题之前，先把上一题的代码存了
    curConvId = convId;
    loadInto(page, convId);
  }

  function close() {
    flushSave();
    dismissGhost();
  }

  return {
    open: open,
    close: close,
    setReport: setReport,       // app.js 把最新的讲解（图文文档 / 文字版）推过来
    LANGS: LANGS,
    OUTPUT_CAP: OUTPUT_CAP,
    REPORT_LS_KEY: REPORT_LS_KEY,
    // 纯函数（单测用）
    escapeHtml: escapeHtml,
    langOf: langOf,
    langLabel: langLabel,
    hljsName: hljsName,
    highlightToHtml: highlightToHtml,
    lineNumbers: lineNumbers,
    acceptSuggestion: acceptSuggestion,
    capOutput: capOutput,
    verdictText: verdictText,
    renderLayerHtml: renderLayerHtml,
    hashString: hashString,
    reportKeyOf: reportKeyOf
  };
});
