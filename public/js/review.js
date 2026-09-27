/**
 * review.js — 赛后复盘界面
 *
 * 为什么单独一个文件：这是**独立于对话**的一条工作流。
 * 复盘的输入是"你在 CF 上的真实提交"，不是你说的话；它不需要跑对拍、不需要花 token 讲解，
 * 所以不该塞进会话流里——打开面板、选一场比赛、看逐题明细，再决定要不要让 AI 深挖。
 *
 * 数据来源与降级（都已实测确认）：
 *   · 提交记录 → **官方 API**（不受 Cloudflare 影响）：判定 / 用时 / 内存 / 尝试次数 / 难度 / 标签
 *   · 源码     → CF 网页，只能走桌面版内嵌浏览器通道；取不到就如实说"请手动打开"
 *   · 官方题解 → CF 网页，**不是每道题都有**（老比赛常缺）；找不到就显示"本题没有官方题解"，绝不编造
 *
 * 本文件不依赖 app.js 的内部状态，自己往 DOM 里挂载，避免动那个 3800 行的主文件。
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);

  const state = {
    loading: false,
    handle: '',
    contestId: '',
    data: null,
    picked: {},         // "1900A" -> true（勾选哪几题要做 AI 复盘；默认全选）
    editorial: {},      // "1900A" -> { ok, content, url, hint, loading }
    source: {},         // submissionId -> { ok, code, lang, loading, hint }
    sel: null,          // 当前展开的题
    busy: false,        // 正在建复盘会话（要逐题抓题解+源码，可能要一分钟）
    prog: null,         // 装材料进度 { i, total, message, items[], failed }
    error: ''           // 拉取失败的可见原因（"点了没反应"是最糟的体验，失败必须看得见）
  };

  /* ---------------- 小工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtDur(ms) {
    if (ms == null) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  const VERDICT_CN = {
    OK: 'AC', WRONG_ANSWER: 'WA', TIME_LIMIT_EXCEEDED: 'TLE', MEMORY_LIMIT_EXCEEDED: 'MLE',
    RUNTIME_ERROR: 'RE', COMPILATION_ERROR: 'CE', IDLENESS_LIMIT_EXCEEDED: '闲置超时',
    SKIPPED: '跳过', TESTING: '评测中', REJECTED: '被拒', CHALLENGED: '被 hack',
    PARTIAL: '部分分', FAILED: '失败', CRASHED: '崩溃', SECURITY_VIOLATED: '安全违规',
    INPUT_PREPARATION_CRASHED: '输入生成失败'
  };
  const vCn = (v) => VERDICT_CN[v] || v || '?';
  /** 结局码 → 配色（复用题目面板已有的色系语义） */
  function vClass(v) {
    if (v === 'OK') return 'rv-ok';
    if (v === 'WRONG_ANSWER' || v === 'CHALLENGED' || v === 'REJECTED') return 'rv-bad';
    if (v === 'TIME_LIMIT_EXCEEDED' || v === 'MEMORY_LIMIT_EXCEEDED' || v === 'IDLENESS_LIMIT_EXCEEDED') return 'rv-slow';
    return 'rv-other';
  }

  async function api(path) {
    const r = await fetch(path, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  /* ---------------- 渲染 ---------------- */

  function pageHtml() {
    return ''
      + '<div class="rv-head">'
      + '  <div class="page-title">🔍 赛后复盘</div>'
      + '  <div class="page-sub">用你在 Codeforces 上的真实提交做复盘：判定、用时、尝试次数、失败模式。'
      + '不重跑对拍，不烧 token。</div>'
      + '</div>'
      + '<div class="rv-bar">'
      + '  <input id="rv-handle" class="form-input" type="text" placeholder="CF 用户名（留空用设置里的）" autocomplete="off">'
      + '  <input id="rv-contest" class="form-input" type="text" placeholder="比赛号（留空 = 最近一场）" autocomplete="off">'
      + '  <input id="rv-entry" class="form-input" type="text" placeholder="题解链接/entry 号（可选，填了直接用它）" autocomplete="off">'
      + '  <button id="rv-load" class="btn-primary">拉取提交记录</button>'
      + '  <button id="rv-login" class="btn-ghost" title="Codeforces 要求登录后才能查看提交源码；未登录时抓源码会一直失败。点这里在应用内浏览器登录一次，登录态长期保留。">🔑 登录 Codeforces</button>'
      + '  <button id="rv-challenge" class="btn-ghost" title="抓取反复超时（Cloudflare 挑战没过）时点这里：会打开一个可见窗口让挑战跑完，之后抓取就正常了">🛡 过一次反爬挑战</button>'
      + '</div>'
      + '<div id="rv-body" class="rv-body"></div>';
  }

  function renderBody() {
    const root = $('#rv-body');
    if (!root) return;
    if (state.loading) { root.innerHTML = '<div class="rv-empty">正在从 Codeforces 拉取提交记录（官方 API，约 1–2 秒）…</div>'; return; }
    if (state.error) {
      root.innerHTML = '<div class="rv-empty rv-err">' + esc(state.error)
        + '<div class="rv-note">检查一下用户名是否拼对；如果没填用户名，先在「我的」页或设置里配置 CF handle。</div></div>';
      return;
    }
    if (!state.data) { root.innerHTML = '<div class="rv-empty">填用户名后点「拉取提交记录」。留空比赛号会自动选最近一场有提交的比赛。</div>'; return; }

    const d = state.data;
    const c = d.current;
    if (!c) { root.innerHTML = '<div class="rv-empty">这个账号最近没有提交记录。</div>'; return; }

    const info = d.contestInfo;
    const parts = [];

    // ① 本场概览
    parts.push('<div class="rv-card">');
    parts.push('  <div class="rv-card-head">'
      + '<b>比赛 ' + esc(c.contestId) + (info && info.name ? '「' + esc(info.name) + '」' : '') + '</b>'
      + (info ? '<span class="rv-chip' + (info.finished ? '' : ' rv-chip-warn') + '">'
        + (info.finished ? '已结束' : '进行中') + '</span>' : '')
      + '</div>');
    parts.push('  <div class="rv-stats">'
      + stat('提交', c.submissions + ' 条')
      + stat('涉及题目', c.problems + ' 题')
      + stat('AC', c.solved + ' 题', c.solved > 0 ? 'ok' : '')
      + stat('本场跨度', fmtDur(c.spanMs))
      + stat('罚时（估）', String(c.penaltyApprox), 'warn')
      + stat('未 AC 白交', c.failedSubmissions + ' 发', c.failedSubmissions > 2 ? 'bad' : '')
      + '</div>');
    parts.push('  <div class="rv-note">罚时口径：只计 AC 题的失败提交 × 50（CF 规则；未 AC 的题不计罚时，只统计白交了几发）。</div>');
    parts.push('</div>');

    // ② 逐题表
    parts.push('<div class="rv-card">');
    parts.push('  <div class="rv-card-head"><b>逐题明细</b>'
      + '<span class="rv-note rv-inline">勾选要复盘的题 → 点右边按钮开一个**带材料的教练会话**，之后可以随便追问</span>'
      + '<button id="rv-session" class="btn-primary rv-right rv-mini">🧠 开始 AI 复盘</button>'
      + '<button id="rv-bundle" class="btn-ghost rv-mini" title="把材料直接放进教练的输入框（不建会话、不占剪贴板）">💬 放进对话框</button></div>');
    parts.push('  <div class="rv-pickbar" id="rv-pickbar">'
      + '<button class="btn-ghost rv-mini" data-rv-pick="all">全选</button>'
      + '<button class="btn-ghost rv-mini" data-rv-pick="none">全不选</button>'
      + '<button class="btn-ghost rv-mini" data-rv-pick="failed">只选没过的</button>'
      + '<label class="rv-check"><input type="checkbox" id="rv-src-opt" checked> 连源码一起抓（慢，但诊断更准）</label>'
      + '</div>');
    parts.push('  <table class="rv-table"><thead><tr>'
      + '<th class="rv-chk"></th><th>题</th><th>难度</th><th>结果</th><th>提交</th><th>判定序列</th><th>最后一发用时</th><th>资料</th>'
      + '</tr></thead><tbody>');
    for (const p of c.problemList) {
      const key = c.contestId + p.index;
      const seq = p.verdicts.slice().reverse().map((v) => '<span class="rv-v ' + vClass(v) + '">' + esc(vCn(v)) + '</span>').join('<span class="rv-arrow">→</span>');
      const ed = state.editorial[key];
      const edBtn = ed && ed.ok
        ? '<button class="btn-ghost rv-mini" data-rv-ed="' + esc(key) + '">📖 题解</button>'
        : (ed && !ed.loading && ed.tried
          ? '<span class="rv-none" title="' + esc(ed.hint || '') + '">无题解（AI 会自己解）</span>'
          : '<button class="btn-ghost rv-mini" data-rv-ed="' + esc(key) + '">📖 找题解</button>');
      const srcBtn = '<button class="btn-ghost rv-mini" data-rv-src="' + esc(String(p.lastSubmissionId)) + '" data-rv-ct="' + esc(c.contestId) + '" data-rv-idx="' + esc(p.index) + '">💻 源码</button>';
      const checked = state.picked[key] === undefined ? true : !!state.picked[key];
      parts.push('<tr>'
        + '<td class="rv-chk"><input type="checkbox" data-rv-check="' + esc(key) + '"' + (checked ? ' checked' : '') + '></td>'
        + '<td><b>' + esc(p.index) + '</b><div class="rv-pname">' + esc(p.problemName || '') + '</div>'
        + (p.tags && p.tags.length ? '<div class="rv-tags">' + esc(p.tags.slice(0, 3).join(' · ')) + '</div>' : '') + '</td>'
        + '<td>' + (p.rating || '—') + '</td>'
        + '<td><span class="rv-v ' + vClass(p.solved ? 'OK' : p.lastVerdict) + '">' + esc(p.solved ? 'AC' : vCn(p.lastVerdict)) + '</span></td>'
        + '<td>' + p.attempts + ' 次' + (p.attempts > 2 && !p.solved ? '<span class="rv-warn-dot" title="死磕">!</span>' : '') + '</td>'
        + '<td class="rv-seq">' + seq + '</td>'
        + '<td>' + (p.lastTimeMs != null ? p.lastTimeMs + 'ms' : '—') + '</td>'
        + '<td class="rv-acts">' + edBtn + srcBtn + '</td>'
        + '</tr>');
    }
    parts.push('  </tbody></table>');
    parts.push('</div>');

    // ③ 展开区（题解 / 源码）
    if (state.sel) parts.push(renderDetail(state.sel, c));

    // ④ 最近比赛列表（点一下切换）
    if (d.contests && d.contests.length > 1) {
      parts.push('<div class="rv-card"><div class="rv-card-head"><b>最近参加过的比赛</b></div><div class="rv-recent">');
      for (const cc of d.contests) {
        parts.push('<button class="rv-recent-item' + (String(cc.contestId) === String(c.contestId) ? ' active' : '') + '" data-rv-ct2="' + esc(cc.contestId) + '">'
          + '<b>' + esc(cc.contestId) + '</b>'
          + '<span>' + fmtTime(cc.startAt) + '｜' + cc.solved + '/' + cc.problems + ' AC'
          + (cc.failed && cc.failed.length ? '｜未过 ' + esc(cc.failed.join('/')) : '') + '</span>'
          + '</button>');
      }
      parts.push('</div></div>');
    }

    root.innerHTML = parts.join('');
    // 动态内容**不需要**在这里绑事件：bindStatic() 已经在 #rv-body 上装了事件委派
    // （早期版本在这里逐个 addEventListener，结果 DOM 一重建监听就没了，
    //   加上常驻按钮被误放在这里绑定 —— 用户实测"点拉取没反应"就是这个原因）。
  }

  function stat(label, value, tone) {
    return '<div class="rv-stat' + (tone ? ' rv-stat-' + tone : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }

  function renderDetail(key, c) {
    const ed = state.editorial[key];
    const p = c.problemList.find((x) => (c.contestId + x.index) === key);
    if (!p) return '';
    const out = ['<div class="rv-card rv-detail">'];
    out.push('<div class="rv-card-head"><b>' + esc(p.index) + ' · ' + esc(p.problemName || '') + '</b>'
      + '<button class="btn-ghost rv-right rv-mini" data-rv-close="1">收起</button></div>');

    // 题解区
    if (ed && ed.loading) out.push('<div class="rv-empty">正在抓官方题解…（要过 Cloudflare 挑战，可能要十几秒）</div>');
    else if (ed && ed.ok) {
      out.push('<div class="rv-sec"><div class="rv-sec-title">📖 官方题解'
        + (ed.entryId ? ' <a class="rv-link" href="#" data-rv-open="' + esc(ed.url || '') + '">blog/entry/' + esc(ed.entryId) + '</a>' : '')
        + (ed.whole ? '<span class="rv-chip">整篇</span>' : (ed.sliced ? '' : '<span class="rv-chip rv-chip-warn">未能精确切出本题，以下是整篇</span>'))
        + (ed.letterMentioned === false ? '<span class="rv-chip rv-chip-warn">内容里没找到题号，可能切错</span>' : '')
        + '</div><pre class="rv-pre">' + esc(ed.content) + '</pre></div>');
    } else if (ed && ed.tried) {
      out.push('<div class="rv-sec"><div class="rv-sec-title">📖 官方题解</div>'
        + '<div class="rv-empty">没有找到：' + esc(ed.hint || 'Codeforces 上这道题没有公开题解') + '</div></div>');
    } else {
      out.push('<div class="rv-sec"><div class="rv-sec-title">📖 官方题解</div>'
        + '<div class="rv-empty">还没查过。<button class="btn-ghost rv-mini" data-rv-ed="' + esc(key) + '">现在去找</button>'
        + '<div class="rv-note">Codeforces 上不是每道题都有题解，找不到就是找不到——不会编一个。</div></div></div>');
    }

    // 源码区
    const s = state.source[p.lastSubmissionId];
    out.push('<div class="rv-sec"><div class="rv-sec-title">💻 最后一发源码（提交 ' + esc(p.lastSubmissionId) + '，' + esc(vCn(p.lastVerdict)) + '）</div>');
    if (s && s.loading) out.push('<div class="rv-empty">正在抓源码…</div>');
    else if (s && s.ok) out.push('<pre class="rv-pre rv-code">' + esc(s.code) + '</pre>');
    else if (s && s.tried) out.push('<div class="rv-empty">没取到：' + esc(s.hint || s.reason || '') + '</div>');
    else out.push('<div class="rv-empty"><button class="btn-ghost rv-mini" data-rv-src="' + esc(String(p.lastSubmissionId)) + '" data-rv-ct="' + esc(c.contestId) + '" data-rv-idx="' + esc(p.index) + '">现在抓取</button></div>');
    out.push('</div>');

    out.push('</div>');
    return out.join('');
  }

  /* ---------------- 交互 ---------------- */

  /**
   * 旧版逐元素绑定（已废弃，保留仅为说明历史）。
   * 现在的做法见下面 bindStatic()：常驻控件绑一次 + #rv-body 上做事件委派。
   * 这两条一起解决了"点按钮没反应"（DOM 重建丢监听 / 按钮不在被重建的容器里）。
   */
  // eslint-disable-next-line no-unused-vars
  function bindBodyLegacy() {
    const root = $('#rv-body');
    if (!root) return;

    root.querySelectorAll('[data-rv-ed]').forEach((b) => {
      b.addEventListener('click', () => loadEditorial(b.getAttribute('data-rv-ed')));
    });
    root.querySelectorAll('[data-rv-src]').forEach((b) => {
      b.addEventListener('click', () => loadSource(b.getAttribute('data-rv-ct'), b.getAttribute('data-rv-src'), b.getAttribute('data-rv-idx')));
    });
    root.querySelectorAll('[data-rv-close]').forEach((b) => {
      b.addEventListener('click', () => { state.sel = null; renderBody(); });
    });
    root.querySelectorAll('[data-rv-ct2]').forEach((b) => {
      b.addEventListener('click', () => { $('#rv-contest').value = b.getAttribute('data-rv-ct2'); doLoad(); });
    });
    root.querySelectorAll('[data-rv-open]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const u = a.getAttribute('data-rv-open');
        if (window.chatbox && window.chatbox.openExternal) window.chatbox.openExternal(u);
        else window.open(u, '_blank');
      });
    });
  }

  /**
   * 绑定"常驻控件"（输入框 / 拉取按钮 / 复制材料 / 开始复盘）。
   *
   * ⚠️ 必须在**创建页面时绑定一次**，不能放在 bindBody() 里。
   * 踩过的坑：这些元素属于 `pageHtml()` 的静态部分，而 `renderBody()` 只替换 `#rv-body` 的内容；
   * 早期把按钮监听写在 bindBody() 里，结果按钮在页面初始化时就被绑过一次、之后
   * 每次 renderBody 又尝试找它（此时它不在 #rv-body 内，找不到/或绑到旧节点），
   * 最终表现为**点「拉取提交记录」没有任何反应**（用户实测报的就是这个）。
   */
  function bindStatic() {
    const load = $('#rv-load');
    if (load && !load._bound) {
      load._bound = true;
      load.addEventListener('click', () => { doLoad(); });
      // 回车即拉取，少一次鼠标移动
      ['#rv-handle', '#rv-contest', '#rv-entry'].forEach((sel) => {
        const el = $(sel);
        if (el && !el._bound) {
          el._bound = true;
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLoad(); });
        }
      });
    }
    const bundleBtn = $('#rv-bundle');
    if (bundleBtn && !bundleBtn._bound) { bundleBtn._bound = true; bundleBtn.addEventListener('click', copyBundle); }
    const chBtn = $('#rv-challenge');
    if (chBtn && !chBtn._bound) { chBtn._bound = true; chBtn.addEventListener('click', doChallenge); }
    const lgBtn = $('#rv-login');
    if (lgBtn && !lgBtn._bound) { lgBtn._bound = true; lgBtn.addEventListener('click', doLogin); }
    const pickbar = $('#rv-pickbar');
    if (pickbar && !pickbar._bound) {
      pickbar._bound = true;
      pickbar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-rv-pick]');
        if (!b) return;
        const how = b.getAttribute('data-rv-pick');
        const c = state.data && state.data.current;
        if (!c) return;
        for (const p of c.problemList) {
          const key = c.contestId + p.index;
          if (how === 'all') state.picked[key] = true;
          else if (how === 'none') state.picked[key] = false;
          else state.picked[key] = !p.solved;
        }
        renderBody();
      });
    }
    // 委派绑定：动态内容里的按钮（用 closest 判断），这样即使 DOM 被重建也不会丢
    const body = $('#rv-body');
    if (body && !body._bound) {
      body._bound = true;
      body.addEventListener('click', (e) => {
        const t = e.target;
        const ed = t.closest('[data-rv-ed]');
        if (ed) { loadEditorial(ed.getAttribute('data-rv-ed')); return; }
        const src = t.closest('[data-rv-src]');
        if (src) { loadSource(src.getAttribute('data-rv-ct'), src.getAttribute('data-rv-src'), src.getAttribute('data-rv-idx')); return; }
        const close = t.closest('[data-rv-close]');
        if (close) { state.sel = null; renderBody(); return; }
        const c2 = t.closest('[data-rv-ct2]');
        if (c2) { const el = $('#rv-contest'); if (el) el.value = c2.getAttribute('data-rv-ct2'); doLoad(); return; }
        const sess = t.closest('#rv-session');
        if (sess) { startSession(); return; }
        const bun = t.closest('#rv-bundle');
        if (bun) { bundleToComposer(); return; }
        const open = t.closest('[data-rv-open]');
        if (open) {
          e.preventDefault();
          const u = open.getAttribute('data-rv-open');
          if (window.chatbox && window.chatbox.openExternal) window.chatbox.openExternal(u);
          else window.open(u, '_blank');
        }
      });
      // 勾选框用 change 事件，单独委派一次
      body.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-rv-check]');
        if (cb) state.picked[cb.getAttribute('data-rv-check')] = cb.checked;
      });
    }
  }

  /** 当前勾选的题号（默认全选 = 空数组表示全量） */
  function pickedProblems() {
    const c = state.data && state.data.current;
    if (!c) return [];
    const out = [];
    let all = true;
    for (const p of c.problemList) {
      const key = c.contestId + p.index;
      const on = state.picked[key] === undefined ? true : !!state.picked[key];
      if (on) out.push(p.index); else all = false;
    }
    return all ? [] : out;   // 全选 → 传空数组，表示"全量"
  }

  /**
   * 开一个"已装好复盘材料"的教练会话，然后跳到会话视图。
   *
   * 这就是"复盘也是 harness"的落点：复盘材料（判定/用时/题解/源码）先由后端装进会话，
   * 之后用户在这个会话里**随便追问**——"B 题那个反例再走一遍""C 题为什么 TLE"
   * 都走正常的教练工具循环，不需要重开复盘。
   *
   * ⚠️ 服务端改成 **SSE 流式报进度**了，不能再用 `fetch().json()`。
   * 原因（用户实测反馈）：11 道题逐题抓题解+源码要几分钟，早先只有一行"正在装材料"，
   * 用户等了十分钟不知道卡在哪。现在每完成一题推一条进度，界面上能看见 "第 3/11 题"。
   */
  async function startSession() {
    if (state.busy) return;
    const c = state.data && state.data.current;
    if (!c) return;
    const btn = $('#rv-session');
    const srcOpt = $('#rv-src-opt');
    state.busy = true;
    state.prog = { i: 0, total: 0, message: '准备中…', items: [] };
    if (btn) { btn.disabled = true; btn.textContent = '正在装材料…'; }
    renderProgress();

    let convId = null;
    try {
      const resp = await fetch('/api/review/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: state.handle,
          contestId: c.contestId,
          problems: pickedProblems(),
          entryId: parseEntryId(($('#rv-entry') || {}).value || ''),
          includeSource: !srcOpt || srcOpt.checked
        })
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      // 手写 SSE 读取：EventSource 只支持 GET，而这里要 POST 带 body
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev = null;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.type === 'start') {
            state.prog.total = ev.total;
            state.prog.contestId = ev.contestId;
            state.prog.message = '共 ' + ev.total + ' 题要装材料（每题都要过一次 CF 反爬挑战，请耐心）';
            renderProgress();
          } else if (ev.type === 'item') {
            state.prog.i = ev.i;
            state.prog.message = '第 ' + ev.i + '/' + ev.total + ' 题 ' + ev.index + '：' + (ev.message || '');
            if (ev.srcWant) {
              state.prog.message += '（源码 ' + (ev.srcGot || 0) + '/' + ev.srcWant + ' 发'
                + ((ev.srcGot || 0) < ev.srcWant ? '，缺的会写进材料里' : '') + '）';
              state.srcGot = (state.srcGot || 0) + (ev.srcGot || 0);
              state.srcWant = (state.srcWant || 0) + ev.srcWant;
            }
            state.prog.items.push(ev);
            renderProgress();
          } else if (ev.type === 'stage') {
            state.prog.message = ev.message || '';
            renderProgress();
          } else if (ev.type === 'done') {
            convId = ev.conversationId;
            state.prog.message = '材料装好了（题解 ' + (ev.editorialOk || 0) + ' 题到手，'
              + (ev.editorialNone || 0) + ' 题没有官方题解 → 让 AI 自己解并验证'
              + (ev.sourceWant ? '｜源码 ' + (ev.sourceGot || 0) + '/' + ev.sourceWant + ' 发' : '') + '）';
            if (ev.degraded) state.prog.message += '｜' + ev.degraded;
            renderProgress();
          } else if (ev.type === 'error') {
            throw new Error(ev.message || '装材料失败');
          }
        }
      }
      if (!convId) throw new Error('服务端没有返回会话 id（装材料可能被中断）');
      if (btn) btn.textContent = '✅ 已开好会话，正在开讲…';
      if (window.CF_COACH && window.CF_COACH.switchView) window.CF_COACH.switchView('coach');
      if (window.CF_COACH && window.CF_COACH.openConversation) await window.CF_COACH.openConversation(convId);
      // **自动让教练开始讲**：材料已经装在会话里了，不该还要用户再打一句"开始吧"
      // （真实反馈：材料都给我了还得我推一下，麻烦）。
      // 这里用 mode='continue'：不新增用户消息，直接以现有历史起一轮。
      let started = false;
      if (window.CF_COACH && window.CF_COACH.continueConversation) {
        // 等会话渲染完再触发，否则 startStream 找不到当前会话
        await new Promise((r) => setTimeout(r, 320));
        started = window.CF_COACH.continueConversation(convId);
      }
      state.prog.message = started
        ? '已开始：教练正在按材料做复盘（下面就是它的回答，可以直接追问）'
        : '会话已开好。进入会话后点输入框旁边的「继续」或直接提问即可。';
      renderProgress();
    } catch (e) {
      state.prog.message = '❌ ' + (e.message || '失败');
      state.prog.failed = true;
      renderProgress();
    } finally {
      state.busy = false;
      if (btn) { btn.textContent = '🧠 开始 AI 复盘'; btn.disabled = false; }
      renderProgress();
    }
  }

  /** 进度面板：装材料期间实时显示，绝不静默 */
  function renderProgress() {
    let box = $('#rv-progress');
    if (!box) {
      const card = document.querySelector('.rv-card');
      if (!card) return;
      box = document.createElement('div');
      box.id = 'rv-progress';
      box.className = 'rv-card rv-progress';
      card.parentNode.insertBefore(box, card);
    }
    const p = state.prog;
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    const pct = p.total ? Math.round((p.i / p.total) * 100) : (p.failed ? 100 : 8);
    const items = (p.items || []).map((it) => {
      const cls = it.editorial === 'ok' ? 'ok' : (it.editorial === 'timeout' ? 'timeout' : 'none');
      const mark = it.editorial === 'ok' ? '📖' : (it.editorial === 'timeout' ? '⏱' : '✎');
      return '<span class="rv-pitem ' + cls + '" title="' + esc(it.message || '') + '">' + esc(it.index) + ' ' + mark + '</span>';
    }).join('');
    box.innerHTML = '<div class="rv-progress-head">'
      + '<b>' + (state.busy ? '正在装复盘材料…' : (p.failed ? '装材料中断' : '装材料完成')) + '</b>'
      + (p.total ? '<span class="rv-chip">' + p.i + ' / ' + p.total + '</span>' : '')
      + '</div>'
      + '<div class="rv-bar-track"><div class="rv-bar-fill' + (p.failed ? ' bad' : '') + '" style="width:' + pct + '%"></div></div>'
      + '<div class="rv-progress-msg">' + esc(p.message || '') + '</div>'
      + (items ? '<div class="rv-pitems">' + items + '</div>' : '')
      + '<div class="rv-note">📖 = 拿到官方题解；✎ = CF 上这道题没有题解；⏱ = 抓取超时（这种可以单独重试）。'
      + '抓取要过 Cloudflare 挑战，每题几秒到几十秒；总预算 200 秒，超时会如实标注，不会静默卡住。</div>';
  }

  async function doLoad() {
    const handle = ($('#rv-handle') || {}).value || '';
    const contestId = ($('#rv-contest') || {}).value || '';
    state.handle = handle.trim();
    state.contestId = contestId.trim();
    state.data = null;
    state.sel = null;
    state.loading = true;
    state.error = '';
    const btn = $('#rv-load');
    if (btn) { btn.disabled = true; btn.textContent = '正在拉取…'; }
    renderBody();
    try {
      const q = new URLSearchParams();
      if (state.handle) q.set('handle', state.handle);
      if (state.contestId) q.set('contestId', state.contestId);
      state.data = await api('/api/review?' + q.toString());
      state.loading = false;
    } catch (e) {
      state.loading = false;
      state.error = '拉取失败：' + (e.message || '未知错误');
    }
    if (btn) { btn.disabled = false; btn.textContent = '拉取提交记录'; }
    renderBody();
  }

  /**
   * 登录 Codeforces（抓提交源码的前提）。
   *
   * 实测根因：CF 现在要求登录后才能查看提交源码 —— 未登录访问提交页（**连别人的公开提交也一样**）
   * 会被直接 302 到首页，所以"取源码"永远失败，而错误信息看起来像是"提交不存在"。
   * 登录窗口用同一个抓取会话分区，登录一次长期有效。
   */
  async function doLogin() {
    const btn = $('#rv-login');
    if (btn) { btn.disabled = true; btn.textContent = '请在弹出的窗口里登录…'; }
    state.prog = {
      i: 0, total: 0, items: [],
      message: '已打开 Codeforces 登录窗口：请在里面输入账号密码（含验证码）完成登录。'
        + '登录成功后本窗口会自动结束，登录态保存在应用内，之后抓源码/题解都能用。'
    };
    renderProgress();
    try {
      const r = await api2('/api/review/login', { waitMs: 180000 });
      if (r && r.loggedIn) {
        state.prog.message = '✅ ' + (r.note || '登录成功');
        state.prog.failed = false;
        // 登录后把之前失败的源码/题解状态清掉，方便重试
        state.source = {};
      } else {
        state.prog.message = '⚠ ' + ((r && (r.note || r.error)) || '没有检测到登录状态');
        state.prog.failed = true;
      }
    } catch (e) {
      state.prog.message = '❌ ' + (e.message || '登录失败');
      state.prog.failed = true;
    } finally {
      renderProgress();
      if (btn) { btn.disabled = false; btn.textContent = '🔑 登录 Codeforces'; }
    }
  }

  /**
   * 人工兜底：打开可见窗口过一次 Cloudflare 挑战。
   *
   * 这是"抓取反复超时"时唯一可靠的出路（实测：同一个 URL 在隐藏窗口里反复失败，
   * 屏幕外的可见窗口能过）。挑战通过后 cf_clearance 存在同一个会话分区里，
   * 后续的题面/题解/源码抓取都会直接可用。
   */
  async function doChallenge() {
    const btn = $('#rv-challenge');
    const c = state.data && state.data.current;
    const entryId = parseEntryId(($('#rv-entry') || {}).value || '');
    const index = state.sel ? state.sel.slice(String(c ? c.contestId : '').length) : '';
    const target = {
      contestId: c ? c.contestId : (($('#rv-contest') || {}).value || '').trim(),
      index: index || 'A',
      entryId: entryId || undefined
    };
    if (btn) { btn.disabled = true; btn.textContent = '窗口已打开，请在里面完成验证…'; }
    // 进度面板同时给出提示（挑战窗口是独立窗口，用户可能没注意）
    state.prog = {
      i: 0, total: 0, message: '已打开一个 Codeforces 窗口用于通过反爬挑战：请切到那个窗口，'
        + '如果有"正在检查浏览器"就等它过去（必要时手动点一下验证）。完成后回到这里继续点「开始 AI 复盘」。',
      items: []
    };
    renderProgress();
    try {
      const r = await api2('/api/review/challenge', target);
      if (r && r.ok) {
        state.prog.message = '挑战窗口已关闭/等待结束（' + Math.round((r.waitedMs || 0) / 1000) + ' 秒）。'
          + '现在可以再试一次「📖 找题解」或「🧠 开始 AI 复盘」。';
      } else {
        state.prog.message = '❌ ' + ((r && r.error) || '打开挑战窗口失败');
        state.prog.failed = true;
      }
    } catch (e) {
      state.prog.message = '❌ ' + (e.message || '失败');
      state.prog.failed = true;
    } finally {
      renderProgress();
      if (btn) { btn.disabled = false; btn.textContent = '🛡 过一次反爬挑战'; }
    }
  }

  async function api2(path, body) {
    const r = await fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
    });
    return await r.json().catch(() => ({}));
  }
  /** 从输入里抠出题解 entry 号：支持纯数字、blog 链接、带 ?locale= 的链接 */
  function parseEntryId(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^\d{3,12}$/.test(s)) return s;
    const m = s.match(/blog\/entry\/(\d+)/i);
    return m ? m[1] : '';
  }

  async function loadEditorial(key) {
    const c = state.data && state.data.current;
    if (!c) return;
    const index = key.slice(String(c.contestId).length);
    const entryId = parseEntryId(($('#rv-entry') || {}).value || '');
    state.editorial[key] = { loading: true };
    state.sel = key;
    renderBody();
    try {
      const q = new URLSearchParams();
      if (entryId) q.set('entryId', entryId);
      else { q.set('contestId', c.contestId); q.set('index', index); }
      const r = await api('/api/review/editorial?' + q.toString());
      state.editorial[key] = Object.assign({ tried: true }, r);
    } catch (e) {
      state.editorial[key] = { tried: true, ok: false, hint: e.message };
    }
    renderBody();
  }

  async function loadSource(contestId, submissionId, index) {
    state.source[submissionId] = { loading: true };
    state.sel = contestId + index;
    renderBody();
    try {
      const r = await api('/api/review/source?contestId=' + encodeURIComponent(contestId) + '&submissionId=' + encodeURIComponent(submissionId));
      state.source[submissionId] = Object.assign({ tried: true }, r);
    } catch (e) {
      state.source[submissionId] = { tried: true, ok: false, hint: e.message };
    }
    renderBody();
  }

  /**
   * 把打包好的材料**直接放进对话框**（不建会话、不经过剪贴板）。
   *
   * 与「🧠 开始 AI 复盘」的区别：那个是开一个新会话、把材料装进上下文并立刻让教练开讲；
   * 这个是"我想自己接着说"时的入口 —— 材料落到输入框里，用户可以改题、加自己的问法再发。
   * 旧实现是复制到剪贴板让用户手动粘，用户明确吐槽过（"不能直接扔对话框里面吗"）。
   */
  async function bundleToComposer() {
    const btn = $('#rv-bundle');
    if (btn) { btn.disabled = true; btn.textContent = '正在打包（会顺带抓题解/源码，可能要 1 分钟）…'; }
    try {
      const q = new URLSearchParams();
      if (state.handle) q.set('handle', state.handle);
      if (state.data && state.data.current) q.set('contestId', state.data.current.contestId);
      const r = await api('/api/review/bundle?' + q.toString());
      if (!r.ok) throw new Error(r.reason || '打包失败');
      if (!window.CF_COACH || !window.CF_COACH.intoComposer) throw new Error('界面接口缺失，请重启应用');
      const okPut = await window.CF_COACH.intoComposer(r.bundle);
      if (!okPut) throw new Error('没能打开输入框');
      if (btn) btn.textContent = '✅ 已放进输入框，切过去看看';
    } catch (e) {
      if (btn) btn.textContent = '❌ ' + (e.message || '失败');
    }
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '💬 放进对话框'; } }, 2600);
  }

  /* ---------------- 挂载 ---------------- */

  function mount() {
    const main = $('#main');
    const sidebar = $('#sidebar');
    if (!main || !sidebar) return false;

    // 侧边栏按钮（放在"我的"前面）
    if (!$('#btn-review')) {
      const anchor = $('#btn-library');
      const btn = document.createElement('button');
      btn.id = 'btn-review';
      btn.className = 'icon-btn nav-btn';
      btn.title = '赛后复盘（拉取真实提交记录）';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/><circle cx="7" cy="15" r="1.4" fill="currentColor" stroke="none"/></svg>';
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
      else sidebar.querySelector('.sb-footer').appendChild(btn);
      btn.addEventListener('click', () => toggle());
    }

    // 页面容器
    if (!$('#page-review')) {
      const page = document.createElement('div');
      page.id = 'page-review';
      page.className = 'page';
      page.hidden = true;
      page.innerHTML = '<div class="page-inner">' + pageHtml() + '</div>';
      const lastPage = $('#page-settings');
      if (lastPage && lastPage.parentNode) lastPage.parentNode.insertBefore(page, lastPage.nextSibling);
      else main.appendChild(page);
    }
    return true;
  }

  /**
   * 打开/关闭复盘页。
   *
   * 这里直接操作 DOM 的 hidden 属性而不是调用 app.js 的 switchView()：
   * 那个函数在 app.js 的 IIFE 闭包里，没有对外暴露；而复盘页是**独立工作流**，
   * 不需要参与会话视图状态。代价是：切走时 app.js 可能仍认为 view 是 coach —— 所以
   * 在打开时把工作台藏起来、关闭时恢复，行为上等价。
   */
  function toggle() {
    const page = $('#page-review');
    if (!page) return;
    const wb = document.querySelector('.workbench');
    const on = page.hidden;
    if (on) {
      // 关掉其它页面（它们是 app.js 管的，直接按 id 收起来）
      ['library', 'profile', 'settings', 'conv-settings', 'provider-edit'].forEach((k) => {
        const el = $('#page-' + k);
        if (el) el.hidden = true;
      });
      if (wb) wb.hidden = true;
      page.hidden = false;
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.id === 'btn-review'));
      const t = $('#header-title');
      if (t) t.textContent = '🔍 赛后复盘';
      const chips = document.querySelector('.header-chips');
      if (chips) chips.hidden = true;
      const h = $('#rv-handle');
      if (h && !h.value && state.data === null) {
        // 首次打开：预填设置里的用户名，减少一次输入
        fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).then((c) => {
          if (c && c.cfHandle && !h.value) h.value = c.cfHandle;
        }).catch(() => {});
      }
      // 顺手预热 CF 会话（幂等）：新进程里第一个 CF 网页请求容易被拒，
      // 提前花掉这笔开销，用户点「开始 AI 复盘」时第一条就能直接用（不然第一条要慢 6~12 秒）。
      // 静默执行：失败也不提示，正式抓取时会给出真正的原因。
      api2('/api/review/warm', {}).catch(() => {});
    } else {
      page.hidden = true;
      if (wb) wb.hidden = false;
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', false));
      const t = $('#header-title');
      if (t) t.textContent = 'CF Coach';
      const chips = document.querySelector('.header-chips');
      if (chips) chips.hidden = false;
    }
  }

  // 挂载：等 app.js 把骨架渲染完（它在 DOMContentLoaded 里初始化）
  function boot() {
    if (mount()) { bindStatic(); renderBody(); return; }
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (mount() || tries > 40) { clearInterval(timer); bindStatic(); renderBody(); }
    }, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.CF_REVIEW = { state, toggle };
})();
