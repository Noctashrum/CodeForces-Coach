/* ============================================================
 * app.js — ChatBox 前端主逻辑
 * 会话管理 / 消息渲染与流式输出 / 编辑重发 / 重新生成多版本 /
 * 图片输入 / 多供应商设置 / 归档 / 导入导出
 * ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const MD = window.MD;

  /**
   * 对外的极简接口：给同页的独立模块（review.js 等）用。
   *
   * 为什么需要：app.js 整个包在 IIFE 里，switchView / openConversation 都是闭包内的函数，
   * 外部模块没法调用。复盘页要在"生成 AI 复盘"之后**跳到会话视图**去追问，
   * 所以这里只暴露这两个必要入口（函数声明会提升，写在这里也能引用到）。
   */
  window.CF_COACH = {
    switchView: (v) => switchView(v),
    openConversation: (id) => openConversation(id),
    /**
     * 重新拉取侧边栏列表（对话 + 文件夹）。
     * 给外部模块 / 冒烟自检用：它们在页面里直接调接口建了对话之后，
     * 需要让列表跟上，而不是整天刷新页面。
     */
    refreshList: () => refreshList(),
    /**
     * 让教练**对上一条用户消息**直接作答（不再要求用户再打字）。
     *
     * 为什么需要：复盘界面已经把整场比赛的材料装进了会话，如果只是把会话打开、
     * 等用户自己再说一句，用户会觉得"材料都给我了还要我推一下"（真实反馈）。
     * 服务端对 mode='continue' 的处理是：不加新的用户消息，直接以现有历史（含那份材料）起一轮。
     * @returns {boolean} 是否成功触发
     */
    continueConversation: (id) => {
      const conv = state.conv;
      if (!conv || conv.id !== id) return false;
      if (!state.config || !(state.config.providers || []).length) { toast('请先添加模型服务', 'error'); return false; }
      if (!conv.model) { toast('请先选择模型', 'error'); return false; }
      if (isStreaming(conv.id)) return false;
      startStream({ conversationId: conv.id, mode: 'continue' });
      scrollBottom(true);
      return true;
    },
    /**
     * 把一段文本**直接放进对话框**（走输入框，不走剪贴板）。
     *
     * 为什么需要：复盘页原本是"把材料复制到剪贴板、让用户自己粘进输入框"——
     * 用户明确吐槽过这个多余的中转（"为什么要弄到我的剪贴板我还要手动粘，不能直接扔对话框里面吗"）。
     * 文本本来就在这个应用里，就该一步到位落到输入框。
     * @param {string} text 要放进去的文本
     * @param {object} [opts] { newConversation: true } 强制开一个新会话再放
     * @returns {Promise<boolean>} 是否成功放入
     */
    intoComposer: async (text, opts) => {      const t = String(text == null ? '' : text);
      if (!t.trim()) return false;
      if (!(opts && opts.newConversation) && state.conv && !state.conv.archived) {
        switchView('coach');
      } else {
        await createConversation();
        switchView('coach');
      }
      const input = $('#input');
      if (!input) return false;
      input.value = t;
      autosizeInput();
      scrollBottom(true);
      input.focus();
      return true;
    }
  };

  /* ---------------- 状态 ---------------- */

  const state = {
    config: null,
    convs: [],
    conv: null,          // 当前打开的完整会话
    tab: 'active',       // active | archive
    query: '',
    streams: {},         // convId -> stream（支持多个会话同时生成）
    agentRuns: {},       // convId -> [{role,label,text,reasoning,open,ms,ok}] 实时 Agent 工作台
    watchers: {},        // convId -> interval（后台生成的轮询观察）
    edit: null,          // { messageId } 正在编辑的用户消息
    pendingImages: [],   // 遗留字段（图片输入已移除）
    variants: {},        // msgId -> 当前展示的版本序号（alternates 下标，或等于长度表示正文）
    view: 'coach',       // coach | library | profile | settings
    libFilter: { knowledge: '', rating: '', contest: '', search: '' },
    settingsTab: 'general',
    profileData: null,
    profileEditing: false,
    profileHydrating: false,
    workspace: null      // 本题验证工作区（/api/workspace）
  };

  /* ---------------- 侧边栏：文件夹 + 多选 ---------------- */

  /** 文件夹清单（服务端 data/folders.json） */
  state.folders = [];
  /** 多选模式：{ on: bool, ids: string[] }。ids 用数组而不是 Set，方便直接 JSON/长度判断 */
  state.sel = { on: false, ids: [] };
  /** 折叠状态：文件夹 id → true 折叠（存 localStorage，刷新后保持） */
  state.collapsed = {};
  try { state.collapsed = JSON.parse(localStorage.getItem('folderCollapsed') || '{}') || {}; } catch (e) { state.collapsed = {}; }

  function saveCollapsed() {
    try { localStorage.setItem('folderCollapsed', JSON.stringify(state.collapsed)); } catch (e) { /* ignore */ }
  }

  function selHas(id) { return state.sel.ids.indexOf(id) >= 0; }
  function selToggle(id) {
    const i = state.sel.ids.indexOf(id);
    if (i >= 0) state.sel.ids.splice(i, 1); else state.sel.ids.push(id);
    renderList();
  }
  function selClear() { state.sel.ids = []; }
  function selExit() { state.sel.on = false; selClear(); renderList(); }

  /* ---------------- 图标 ---------------- */

  const ICONS = {
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
    archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    restore: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    menu: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
    chevL: '<path d="M15 18l-6-6 6-6"/>',
    chevR: '<path d="M9 18l6-6-6-6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    model: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 14l3-3 2.5 2.5L16 10"/><circle cx="15.5" cy="9.5" r="1.5" fill="currentColor" stroke="none"/>',
    // 提问意图专用图标（每种意图一个，避免"图标全长一样"）
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    bug: '<rect x="8" y="6" width="8" height="12" rx="4"/><path d="M8 3l1.6 2.6"/><path d="M16 3l-1.6 2.6"/><path d="M3 12h5"/><path d="M16 12h5"/><path d="M4 7l4 2.2"/><path d="M20 7l-4 2.2"/><path d="M4 17l4-2.2"/><path d="M20 17l-4-2.2"/>',
    sigma: '<path d="M18 4H6l6 8-6 8h12"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/>'
  };

  function icon(name, size) {
    const p = ICONS[name] || '';
    return '<svg viewBox="0 0 24 24" width="' + (size || 14) + '" height="' + (size || 14)
      + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  /* ---------------- 基础工具 ---------------- */

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function contentText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (p) {
        if (!p) return '';
        if (p.type === 'text') return p.text;
        if (p.type === 'image_url') return '[图片]';
        return '';
      }).join('\n');
    }
    return '';
  }

  function contentImages(c) {
    if (!Array.isArray(c)) return [];
    return c.filter(function (p) { return p && p.type === 'image_url' && p.image_url && p.image_url.url; })
      .map(function (p) { return p.image_url.url; });
  }

  function providerById(id) {
    return (state.config && state.config.providers || []).find(function (p) { return p.id === id; });
  }

  function providerName(id) {
    const p = providerById(id);
    return p ? p.name : '';
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function isStreaming(convId) {
    return !!state.streams[convId];
  }

  /* ---------------- API ---------------- */

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const r = await fetch(path, opts);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }

  async function loadConfig() {
    state.config = await api('/api/config');
  }

  async function saveConfig() {
    await api('/api/config', { method: 'POST', body: JSON.stringify(state.config) });
  }

  async function refreshList() {
    const r = await api('/api/conversations');
    state.convs = r.conversations;
    try {
      const f = await api('/api/folders');
      state.folders = f.folders || [];
    } catch (e) { /* 文件夹拉不到不影响对话列表 */ }
    // 选中项里可能有已经被删掉的会话，清掉避免"已选 3 项"却只操作成功 2 项
    const alive = {};
    state.convs.forEach(function (c) { alive[c.id] = true; });
    state.sel.ids = state.sel.ids.filter(function (id) { return alive[id]; });
    renderList();
  }

  async function fetchInfo() {
    try { return await api('/api/info'); } catch (e) { return null; }
  }

  /* ---------------- Toast ---------------- */

  function toast(msg, type, timeout) {
    type = type || 'info';
    const root = $('#toast-root');
    const div = document.createElement('div');
    div.className = 'toast ' + type;
    const ic = type === 'success' ? '✓' : (type === 'error' ? '✕' : 'ℹ');
    div.innerHTML = '<span class="toast-icon">' + ic + '</span><span>' + MD.escapeHtml(String(msg)) + '</span>';
    root.appendChild(div);
    setTimeout(function () {
      div.classList.add('out');
      setTimeout(function () { div.remove(); }, 300);
    }, timeout || 2600);
  }

  /* ---------------- 弹窗 / 菜单 ---------------- */

  // 弹窗栈：支持多层弹窗（如 设置页 → 服务编辑），关闭只关最上层，返回上一级
  const modalStack = [];

  function closeModal() { // 关闭全部弹窗
    modalStack.length = 0;
    $('#modal-root').innerHTML = '';
  }

  function closeTopModal() { // 只关闭最上层弹窗
    const entry = modalStack.pop();
    if (!entry) return;
    entry.mask.remove();
    entry.modal.remove();
  }

  function openModal(opts) {
    const root = $('#modal-root');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const modal = document.createElement('div');
    modal.className = 'modal' + (opts.size === 'sm' ? ' modal-sm' : '');
    let foot = '';
    if (opts.foot !== undefined) foot = '<div class="modal-foot">' + opts.foot + '</div>';
    modal.innerHTML =
      '<div class="modal-head"><div class="modal-title">' + (opts.title || '') + '</div>'
      + '<button class="icon-btn" data-modal-close title="关闭">'
      + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
      + '</button></div>'
      + '<div class="modal-body">' + (opts.body || '') + '</div>' + foot;
    root.appendChild(mask);
    root.appendChild(modal);
    const entry = { mask: mask, modal: modal };
    modalStack.push(entry);
    // 关闭自己：从栈中移除并移除 DOM，不影响底下的其它弹窗
    const close = function () {
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      mask.remove();
      modal.remove();
    };
    mask.addEventListener('click', function (e) { if (e.target === mask && opts.closable !== false) close(); });
    // 绑定所有关闭按钮（头部 ✕ 与底部「关闭」等多个都生效），均只关闭本层
    $$('[data-modal-close]', modal).forEach(function (btn) {
      btn.addEventListener('click', close);
    });
    return { modal: modal, close: close };
  }

  function confirmModal(opts) {
    return new Promise(function (resolve) {
      const m = openModal({
        title: opts.title || '确认操作',
        size: 'sm',
        // pre-line：调用方传多行文案（如"删除对话时顺带说明缓存也会删"）时能正常换行，
        // 而不是把 \n 渲染成一个空格
        body: '<p style="font-size:13.5px;color:var(--text-secondary);line-height:1.7;white-space:pre-line">' + MD.escapeHtml(opts.message || '') + '</p>',
        foot: '<button class="btn btn-default" data-no>取消</button>'
          + '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-yes>' + (opts.okText || '确定') + '</button>'
      });
      m.modal.querySelector('[data-no]').addEventListener('click', function () { m.close(); resolve(false); });
      m.modal.querySelector('[data-yes]').addEventListener('click', function () { m.close(); resolve(true); });
    });
  }

  function promptModal(opts) {
    return new Promise(function (resolve) {
      const m = openModal({
        title: opts.title || '请输入',
        size: 'sm',
        body: '<div class="form-group"><label class="form-label">' + MD.escapeHtml(opts.label || '') + '</label>'
          + '<input class="form-input" data-prompt-input type="text" value="' + MD.escapeHtml(opts.value || '') + '" placeholder="' + MD.escapeHtml(opts.placeholder || '') + '"></div>',
        foot: '<button class="btn btn-default" data-no>取消</button><button class="btn btn-primary" data-yes>确定</button>'
      });
      const input = m.modal.querySelector('[data-prompt-input]');
      setTimeout(function () { input.focus(); input.select(); }, 50);
      const submit = function () { m.close(); resolve(input.value); };
      m.modal.querySelector('[data-yes]').addEventListener('click', submit);
      m.modal.querySelector('[data-no]').addEventListener('click', function () { m.close(); resolve(null); });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
  }

  let activeMenu = null;
  function closeMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }
  function openMenu(anchor, items, opts) {
    closeMenu();
    opts = opts || {};
    const pop = document.createElement('div');
    pop.className = 'menu-pop' + (opts.cls ? ' ' + opts.cls : '');
    let html = '';
    items.forEach(function (it) {
      if (it === '-') { html += '<div class="menu-sep"></div>'; return; }
      if (it.label === '__note__') { html += '<div class="menu-note">' + it.note + '</div>'; return; }
      if (it.html) { html += it.html; return; }
      html += '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-menu-idx="' + items.indexOf(it) + '">'
        + (it.icon ? icon(it.icon, 15) : '')
        + '<span>' + MD.escapeHtml(it.label) + '</span>' + (it.suffix || '') + '</button>';
    });
    pop.innerHTML = html;
    const root = $('#menu-root');
    root.appendChild(pop);
    activeMenu = pop;
    const rect = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 10);
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 10) top = Math.max(10, rect.top - h - 6);
    pop.style.position = 'fixed';
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    // 菜单必须压在所有弹窗（含遮罩）之上，防止被 modal 挡住
    pop.style.zIndex = '1100';
    $$('[data-menu-idx]', pop).forEach(function (btn) {
      btn.addEventListener('click', function () {
        const it = items[+btn.getAttribute('data-menu-idx')];
        closeMenu();
        if (it.onClick) it.onClick();
      });
    });
    setTimeout(function () {
      const handler = function (e) {
        if (!pop.contains(e.target)) { closeMenu(); document.removeEventListener('click', handler); }
      };
      document.addEventListener('click', handler);
    }, 0);
    return pop;
  }

  /* ---------------- 主题 ---------------- */

  function currentIsDark() {
    const t = state.config ? state.config.theme : 'auto';
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme() {
    const dark = currentIsDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#hljs-light').disabled = dark;
    $('#hljs-dark').disabled = !dark;
    $('#icon-theme-light').style.display = dark ? 'none' : '';
    $('#icon-theme-dark').style.display = dark ? '' : 'none';
  }

  const THEME_NAMES = { light: '浅色', dark: '深色', auto: '跟随系统' };

  async function cycleTheme() {
    const order = ['light', 'dark', 'auto'];
    const cur = state.config.theme || 'auto';
    state.config.theme = order[(order.indexOf(cur) + 1) % order.length];
    applyTheme();
    await saveConfig();
    toast('主题：' + THEME_NAMES[state.config.theme]);
  }

  /* ---------------- 侧边栏 ---------------- */

  /** 单个对话条目（文件夹分组与"未分类"共用同一份渲染，避免两处样式漂移） */
  function convItemHtml(c) {
    const active = state.conv && state.conv.id === c.id;
    // 正在生成：本地流 或 服务端报告的后台生成（并发/后台会话在列表里也能看出来）
    const streaming = isStreaming(c.id) || !!c.active;
    const pinIcon = c.pinned ? '<span class="conv-item-pin">' + icon('pin', 12) + '</span>' : '';
    const runDot = streaming ? '<span class="conv-run-dot" title="正在生成"></span>' : '';
    const meta = c.problemMeta || null;
    const ratingChip = meta && meta.rating
      ? '<span class="conv-rating ' + ratingColorClass(meta.rating) + '">' + meta.rating + '</span>'
      : (meta ? '<span class="conv-rating cf-gray">?</span>' : '');
    const knowledge = meta && meta.knowledge && meta.knowledge.length
      ? '<span class="conv-knowledge">' + meta.knowledge.slice(0, 2).map(function (k) { return MD.escapeHtml(k); }).join(' · ') + '</span>'
      : '';
    const picked = selHas(c.id);
    const box = state.sel.on
      ? '<span class="conv-check' + (picked ? ' on' : '') + '">' + (picked ? icon('check', 12) : '') + '</span>'
      : '';
    return '<div class="conv-item' + (active ? ' active' : '') + (streaming ? ' streaming' : '')
      + (state.sel.on ? ' selecting' : '') + (picked ? ' picked' : '') + '" data-id="' + c.id + '">'
      + '<div class="conv-item-top">' + box + pinIcon + '<span class="conv-item-title">' + MD.escapeHtml(c.title) + '</span>' + runDot + ratingChip + '</div>'
      + '<div class="conv-item-bottom"><span class="conv-item-preview">'
      + MD.escapeHtml((meta && meta.summary) || c.preview || (c.messageCount ? '…' : '（空对话）')) + '</span>'
      + '<span>' + MD.timeAgo(c.updatedAt) + '</span></div>'
      + (knowledge ? '<div class="conv-item-knowledge">' + knowledge + '</div>' : '')
      + '<div class="conv-item-actions">'
      + '<button class="conv-item-action" data-act="folder" data-id="' + c.id + '" title="移动到文件夹">'
      + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>'
      + '<button class="conv-item-action" data-act="pin" data-id="' + c.id + '" title="' + (c.pinned ? '取消置顶' : '置顶') + '">' + icon('pin', 13) + '</button>'
      + (c.archived
        ? '<button class="conv-item-action" data-act="restore" data-id="' + c.id + '" title="恢复对话">' + icon('restore', 13) + '</button>'
        : '<button class="conv-item-action" data-act="archive" data-id="' + c.id + '" title="归档">' + icon('archive', 13) + '</button>')
      + '<button class="conv-item-action danger" data-act="delete" data-id="' + c.id + '" title="删除">' + icon('trash', 13) + '</button>'
      + '</div></div>';
  }

  function renderList() {
    const listEl = $('#conv-list');
    const archivedCount = state.convs.filter(function (c) { return c.archived; }).length;
    const badge = $('#archive-count');
    badge.hidden = archivedCount === 0;
    badge.textContent = archivedCount;

    // 批量操作条
    const bulk = $('#sb-bulk');
    const bulkCount = $('#sb-bulk-count');
    if (bulk) bulk.hidden = !state.sel.on;
    if (bulkCount) bulkCount.textContent = '已选 ' + state.sel.ids.length + ' 项';
    const msBtn = $('#btn-multiselect');
    if (msBtn) msBtn.classList.toggle('active', state.sel.on);

    let convs = state.convs.filter(function (c) { return c.archived === (state.tab === 'archive'); });
    if (state.query) {
      const q = state.query.toLowerCase();
      convs = convs.filter(function (c) {
        return (c.title + ' ' + c.preview).toLowerCase().indexOf(q) >= 0;
      });
    }

    if (!convs.length) {
      listEl.innerHTML = '<div class="sb-empty">'
        + (state.query ? '没有匹配的对话' : (state.tab === 'archive' ? '归档里还没有对话<br>在对话列表中把会话归档后，会出现在这里' : '还没有对话<br>点击上方「新建对话」开始'))
        + '</div>';
      return;
    }

    /**
     * 分组规则（对话页）：
     *   ① 置顶（跨文件夹，永远排最前）
     *   ② 每个文件夹一块（没有的就跳过，但空文件夹也要显示 —— 否则"刚建好却看不见"）
     *   ③ 未分类：沿用按时间分组（今天 / 昨天 / 7 天内 / …）
     * 归档页不分组（文件夹只管"在用的对话"）。
     */
    const folderOf = function (c) { return c.folder || ''; };
    const pinned = convs.filter(function (c) { return c.pinned; });
    const rest = convs.filter(function (c) { return !c.pinned; });
    let html = '';

    if (pinned.length) {
      html += '<div class="conv-group-label">置顶</div>';
      pinned.forEach(function (c) { html += convItemHtml(c); });
    }

    if (state.tab === 'active') {
      state.folders.forEach(function (f) {
        const items = rest.filter(function (c) { return folderOf(c) === f.id; });
        const open = !state.collapsed[f.id];
        html += '<div class="conv-folder' + (open ? '' : ' collapsed') + '" data-folder="' + f.id + '">'
          + '<button class="conv-folder-head" data-folder-toggle="' + f.id + '">'
          + '<span class="conv-folder-arrow">' + (open ? '▾' : '▸') + '</span>'
          + '<span class="conv-folder-name">' + MD.escapeHtml(f.name) + '</span>'
          + '<span class="conv-folder-count">' + items.length + '</span>'
          + '<span class="conv-folder-menu" data-folder-menu="' + f.id + '" title="文件夹操作">⋯</span>'
          + '</button>'
          + (open ? items.map(convItemHtml).join('') : '')
          + '</div>';
      });
    }

    const unfiled = rest.filter(function (c) { return !folderOf(c) || (state.tab !== 'active'); });
    const groups = [];
    unfiled.forEach(function (c) {
      const key = MD.groupLabel(c.updatedAt);
      let g = groups.find(function (x) { return x.key === key; });
      if (!g) { g = { key: key, items: [] }; groups.push(g); }
      g.items.push(c);
    });
    const order = ['今天', '昨天', '7 天内'];
    groups.sort(function (a, b) {
      const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.key.localeCompare(b.key, 'zh-CN');
    });
    if (state.tab === 'active' && groups.length) html += '<div class="conv-group-label">未分类</div>';
    groups.forEach(function (g) {
      if (state.tab !== 'active') html += '<div class="conv-group-label">' + MD.escapeHtml(g.key) + '</div>';
      g.items.forEach(function (c) { html += convItemHtml(c); });
    });

    listEl.innerHTML = html;
  }

  /**
   * 「移动到文件夹」菜单：列出现有文件夹 + 新建 + 移出文件夹。
   * @param {Element} anchor 贴着哪个元素弹出
   * @param {string[]} ids 要移动的对话（单条或多选）
   */
  function openFolderMenu(anchor, ids) {
    const items = [];
    items.push({ label: '未分类（移出文件夹）', icon: 'trash', onClick: function () { doBatchMove(ids, ''); } });
    if (state.folders.length) items.push('-');
    state.folders.forEach(function (f) {
      items.push({ label: f.name, icon: 'archive', onClick: function () { doBatchMove(ids, f.id); } });
    });
    items.push('-');
    items.push({
      label: '＋ 新建文件夹…', icon: 'check',
      onClick: async function () {
        const name = await promptModal({ title: '新建文件夹', label: '文件夹名', placeholder: '例如：线段树 / 我的弱项' });
        if (!name || !name.trim()) return;
        try {
          const r = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
          await refreshList();
          await doBatchMove(ids, r.folder.id);
        } catch (e) { toast(e.message || '新建失败', 'error'); }
      }
    });
    openMenu(anchor, items);
  }

  async function doBatchMove(ids, folder) {
    await batchOp('move', ids, { folder: folder });
  }

  /**
   * 批量操作。**逐条串行**在服务端做，这里只负责汇总结果并如实汇报
   * （部分失败也要说清楚是哪几条，不能只报"操作完成"）。
   */
  async function batchOp(action, ids, extra) {
    if (!ids.length) { toast('还没有选中对话', 'error'); return; }
    try {
      const r = await api('/api/conversations/batch', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ ids: ids, action: action }, extra || {}))
      });
      const names = { archive: '归档', unarchive: '恢复', delete: '删除', move: '移动', pin: '置顶', unpin: '取消置顶' };
      const what = names[action] || action;
      if (r.failed && r.failed.length) {
        toast('已' + what + ' ' + r.done + ' 个，' + r.failed.length + ' 个失败：' + (r.failed[0].reason || ''), 'error', 4200);
      } else {
        toast('已' + what + ' ' + r.done + ' 个对话', 'success');
      }
      // 当前会话被归档/删除时，界面要跟着走，不能停在一个已经不在列表里的会话上
      if (state.conv && ids.indexOf(state.conv.id) >= 0 && (action === 'delete' || action === 'archive')) closeCurrent();
      // 一批操作做完就退出多选：留着"已选 0 项"的批量条只会让人以为还能再点一次
      state.sel.on = false;
      selClear();
      await refreshList();
    } catch (e) {
      toast(e.message || '批量操作失败', 'error');
    }
  }

  /** 批量删除前的确认：把条数和"不可恢复"讲清楚 */
  function confirmBatchDelete(ids) {
    const preview = state.convs.filter(function (c) { return ids.indexOf(c.id) >= 0; })
      .slice(0, 5).map(function (c) { return '「' + c.title + '」'; }).join('、');
    confirmModal({
      title: '删除 ' + ids.length + ' 个对话',
      message: '将从本地永久删除：' + preview + (ids.length > 5 ? ' 等 ' + ids.length + ' 个对话' : '') + '。不可恢复。',
      okText: '删除', danger: true
    }).then(function (ok) { if (ok) batchOp('delete', ids); });
  }

  function listItemAction(act, id) {
    const c = state.convs.find(function (x) { return x.id === id; });
    if (!c) return;
    if (act === 'folder') {
      // 单条移动：按钮就在条目上，菜单贴着它弹
      const btn = document.querySelector('.conv-item[data-id="' + id + '"] [data-act="folder"]');
      openFolderMenu(btn || $('#conv-list'), [id]);
    } else if (act === 'pin') {
      patchConv(id, { pinned: !c.pinned });
    } else if (act === 'archive' || act === 'restore') {
      const archiving = act === 'archive';
      if (archiving && state.conv && state.conv.id === id) {
        // 归档当前会话：提示后跳回欢迎页
        patchConv(id, { archived: true }).then(function () {
          toast('已归档「' + c.title + '」', 'success');
          closeCurrent();
          refreshList();
        });
        return;
      }
      patchConv(id, { archived: archiving }).then(function () {
        toast(archiving ? '已归档' : '已恢复', 'success');
        refreshList();
      });
    } else if (act === 'delete') {
      /**
       * 删除对话：默认**把这道题的验证缓存也一起删**。
       *
       * 用户的原话："我删除肯定是全删啊"——缓存（按题号共享的工作区）不跟着删，
       * 下次问同一题还会命中旧结论，既不符删除语义，也让人没法测"重新对拍"。
       * 但缓存可能是几个对话共用的，所以这里说清楚，并把选择权交出去。
       */
      const hasWs = !!(c.cfProblem && (c.problemMeta || c.cfProblem.title));
      confirmModal({
        title: '删除对话',
        message: '确定删除「' + c.title + '」吗？对话文件将从本地永久删除，不可恢复。'
          + (hasWs ? '\n\n这道题的验证缓存（题解/暴力解/对拍结论）也会一起删掉：下次问同一题会从零重新对拍。' : ''),
        okText: '删除',
        danger: true
      }).then(async function (ok) {
        if (!ok) return;
        if (isStreaming(id)) stopStreaming(id, true);
        const r = await api('/api/conversations/' + id, { method: 'DELETE', body: JSON.stringify({ forceWorkspace: true }) });
        if (state.conv && state.conv.id === id) closeCurrent();
        await refreshList();
        // 缓存被别的对话共用时服务端会保留它 —— 如实说明，别让用户以为删干净了
        if (r && r.workspaceKept) {
          toast('对话已删除；这道题的验证缓存被另外 ' + ((r.sharedWith || []).length)
            + ' 个对话共用，已保留（需要清掉请在题目面板点「重新对拍」）', 'info', 7000);
        } else {
          toast(r && r.workspaceCleared ? '已删除（含本题验证缓存，下次问同题会重新对拍）' : '已删除', 'success');
        }
      });
    }
  }

  function closeCurrent() {
    state.conv = null;
    state.edit = null;
    localStorage.removeItem('lastConvId');
    renderHeader();
    renderMessages();
    renderProblemPanel();
    updateComposer();
  }

  async function patchConv(id, patch) {
    const conv = await api('/api/conversations/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    if (state.conv && state.conv.id === id) {
      state.conv = conv;
      renderHeader();
      updateComposer();
    }
    return conv;
  }

  /* ---------------- 会话打开 ---------------- */

  async function openConversation(id) {
    const conv = await api('/api/conversations/' + id);
    state.conv = conv;
    state.variants = {};
    state.edit = null;
    clearEditChip();
    localStorage.setItem('lastConvId', id);
    // 只有服务端确认**没有**在生成时，才把遗留的 streaming 状态当异常残留清理；
    // 正在后台生成/并发生成的会话绝不能在这里被改成"已停止"（历史 bug：点开就显示已暂停）
    if (!conv.active && !isStreaming(id)) {
      let dirty = false;
      conv.messages.forEach(function (m) {
        if (m.status === 'streaming') { m.status = 'stopped'; m.error = ''; dirty = true; }
      });
      if (dirty) {
        api('/api/conversations/' + id + '/messages', {
          method: 'POST',
          body: JSON.stringify({ messages: conv.messages })
        }).catch(function () { /* 非关键 */ });
      }
    }
    await refreshWorkspace();
    renderHeader();
    renderMessages();
    renderProblemPanel();
    updateComposer();
    scrollBottom(true);
    focusInput();
    refreshList();
    // 后台正在跑（可能是在别的会话里启动的、或页面刷新过）：轮询直到结束，界面不再显示成"已停止"
    if (conv.active && !isStreaming(id)) watchBackgroundRun(id);
    else stopWatching(id);
  }

  /* ---------------- 后台生成的观察（并发/后台会话） ---------------- */

  function stopWatching(convId) {
    const w = state.watchers && state.watchers[convId];
    if (w) { clearInterval(w); delete state.watchers[convId]; }
  }

  /**
   * 停止 / 异常结束后，等**服务端**把 active 标记清掉再收尾。
   * 前端 abort 的瞬间服务端还在收尾（落盘 + 释放活跃登记），立刻拉一次可能仍看到 active=true，
   * 界面就会一直挂着"正在生成中 · 转圈"。这里以服务端为准轮询几次，直到它确认不在生成。
   */
  function settleActiveFlags(convId) {
    state.settle = state.settle || {};
    if (state.settle[convId]) return;
    let tries = 0;
    state.settle[convId] = setInterval(async function () {
      tries++;
      let active = [];
      try { active = ((await api('/api/generations')) || {}).active || []; } catch (e) { /* ignore */ }
      const still = active.indexOf(convId) >= 0;
      if (!still || tries >= 8) {
        clearInterval(state.settle[convId]);
        state.settle[convId] = null;
        if (state.conv && state.conv.id === convId) {
          try { await resyncConversation(); } catch (e) { /* ignore */ }
          renderMessages();
          renderHeader();
          renderProblemPanel();
        }
        refreshList().catch(function () { /* ignore */ });
        updateComposer();
      }
    }, 800);
  }

  function watchBackgroundRun(convId) {
    stopWatching(convId);
    state.watchers = state.watchers || {};
    let misses = 0;
    state.watchers[convId] = setInterval(async function () {
      if (!state.conv || state.conv.id !== convId) { stopWatching(convId); return; }
      try {
        const conv = await api('/api/conversations/' + convId);
        if (state.conv && state.conv.id === convId) {
          state.conv = conv;
          renderMessages();
          updateComposer();
        }
        await refreshWorkspace();
        renderProblemPanel();
        if (!conv.active) { stopWatching(convId); refreshList(); toast('后台生成已完成', 'success', 2000); }
      } catch (e) {
        if (++misses > 20) stopWatching(convId);
      }
    }, 2500);
  }

  async function createConversation() {
    const conv = await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) });
    await refreshList();
    await openConversation(conv.id);
  }

  /* ---------------- 头部 ---------------- */

  function renderHeader() {
    const titleEl = $('#header-title');
    const modelEl = $('#header-model');
    const ratingEl = $('#header-rating');
    const progressEl = $('#header-progress');
    const menuBtn = $('#btn-conv-menu');
    const conv = state.conv;
    if (state.view !== 'coach') {
      titleEl.textContent = VIEW_TITLES[state.view] || 'CF Coach';
      return;
    }
    if (!conv) {
      titleEl.textContent = 'CF Coach';
      modelEl.hidden = true;
      ratingEl.hidden = true;
      progressEl.hidden = true;
      menuBtn.hidden = true;
      return;
    }
    titleEl.textContent = conv.title + (conv.archived ? '（已归档）' : '');
    const pname = providerName(conv.providerId);
    modelEl.hidden = !conv.model;
    modelEl.textContent = conv.model ? (pname ? pname + ' · ' : '') + conv.model : '';
    // 难度色标
    const meta = conv.problemMeta || {};
    ratingEl.hidden = !meta.rating;
    if (meta.rating) {
      ratingEl.className = 'rating-badge ' + ratingColorClass(meta.rating);
      ratingEl.textContent = meta.rating;
      ratingEl.dataset.tip = '预估/官方难度 ' + meta.rating + ' · ' + ratingTierName(meta.rating);
    }
    // 进行中状态
    const streaming = isStreaming(conv.id);
    progressEl.hidden = !streaming;
    if (streaming) progressEl.textContent = '⚙ 教练解题验证中…';
    menuBtn.hidden = false;
  }

  function ratingTierName(rating) {
    if (!rating) return '未评级';
    if (rating < 1200) return 'Newbie 新秀';
    if (rating < 1400) return 'Pupil';
    if (rating < 1600) return 'Specialist';
    if (rating < 1900) return 'Expert';
    if (rating < 2100) return 'Candidate Master';
    if (rating < 2300) return 'Master';
    if (rating < 2400) return 'International Master';
    if (rating < 2600) return 'Grandmaster';
    if (rating < 3000) return 'International Grandmaster';
    return 'Legendary Grandmaster';
  }

  function openConvMenu(anchor) {
    const conv = state.conv;
    if (!conv) return;
    openMenu(anchor, [
      { label: '重命名', icon: 'edit', onClick: renameConv },
      { label: conv.pinned ? '取消置顶' : '置顶对话', icon: 'pin', onClick: async function () {
        await patchConv(conv.id, { pinned: !conv.pinned });
        refreshList();
      } },
      { label: conv.archived ? '取消归档' : '归档对话', icon: conv.archived ? 'restore' : 'archive', onClick: async function () {
        await patchConv(conv.id, { archived: !conv.archived });
        toast(conv.archived ? '已取消归档' : '已归档', 'success');
        if (conv.archived === false) { /* 归档后当前会话只读 */ }
        refreshList();
        renderHeader();
      } },
      '-',
      { label: '这道题的设置…', icon: 'edit', onClick: function () { openConvSettings(); } },
      { label: '导出为 Markdown', icon: 'download', onClick: function () { window.open('/api/export/' + conv.id + '.md', '_blank'); } },
      { label: '清空消息', icon: 'trash', onClick: clearMessages },
      '-',
      { label: '删除对话', icon: 'trash', danger: true, onClick: function () {
        confirmModal({ title: '删除对话', message: '确定删除「' + conv.title + '」吗？对话文件将从本地永久删除。', okText: '删除', danger: true })
          .then(async function (ok) {
            if (!ok) return;
            if (isStreaming(conv.id)) stopStreaming(conv.id, true);
            await api('/api/conversations/' + conv.id, { method: 'DELETE' });
            closeCurrent();
            await refreshList();
            toast('已删除', 'success');
          });
      } }
    ]);
  }

  async function renameConv() {
    const name = await promptModal({ title: '重命名对话', label: '对话名称', value: state.conv.title, placeholder: '输入新名称' });
    if (name == null) return;
    await patchConv(state.conv.id, { title: name });
    refreshList();
  }

  async function clearMessages() {
    const ok = await confirmModal({ title: '清空消息', message: '确定清空当前对话的所有消息吗？此操作不可恢复。', okText: '清空', danger: true });
    if (!ok) return;
    const conv = await api('/api/conversations/' + state.conv.id + '/clear', { method: 'POST', body: '{}' });
    state.conv = conv;
    state.variants = {};
    renderMessages();
    refreshList();
    toast('已清空消息', 'success');
  }

  /* ---------------- 消息渲染 ---------------- */

  function getDisplay(m) {
    const alts = m.alternates || [];
    const idx = state.variants[m.id];
    if (idx == null || idx >= alts.length) {
      return { content: m.content, reasoning: m.reasoning, usage: m.usage };
    }
    const a = alts[idx];
    return { content: a.content, reasoning: a.reasoning, usage: a.usage };
  }

  function getVariantIdx(m) {
    const alts = m.alternates || [];
    const idx = state.variants[m.id];
    if (idx == null) return alts.length;
    return Math.max(0, Math.min(idx, alts.length));
  }

  function reasoningHtml(m, disp, streaming) {
    if (!disp.reasoning && !streaming) return '';
    return '<details class="reasoning-box"' + (streaming ? ' open' : '') + '>'
      + '<summary class="reasoning-summary">'
      + (streaming ? '<span class="reasoning-dot"></span>' : '<span>🧠</span>')
      + '<span class="reasoning-title">' + (streaming && !disp.reasoning ? '思考中…' : '思考过程') + '</span>'
      + '</summary>'
      + '<div class="reasoning-content">' + MD.escapeHtml(disp.reasoning || '') + '</div>'
      + '</details>';
  }

  function variantNavHtml(m) {
    const alts = m.alternates || [];
    if (!alts.length) return '';
    const idx = getVariantIdx(m);
    return '<span class="variant-nav">'
      + '<button data-act="vprev" data-id="' + m.id + '"' + (idx <= 0 ? ' disabled' : '') + ' title="上一版">' + icon('chevL', 13) + '</button>'
      + '<span class="variant-count" title="重新生成的历史版本">' + (idx + 1) + '/' + (alts.length + 1) + '</span>'
      + '<button data-act="vnext" data-id="' + m.id + '"' + (idx >= alts.length ? ' disabled' : '') + ' title="下一版">' + icon('chevR', 13) + '</button>'
      + '</span>';
  }

  function toolbarHtml(m, idx, msgs) {
    const isLast = idx === msgs.length - 1;
    const tools = [];
    if (m.role === 'user') {
      tools.push('<button class="msg-tool" data-act="edit" data-id="' + m.id + '">' + icon('edit', 12) + ' 编辑并重发</button>');
      tools.push('<button class="msg-tool" data-act="copy" data-id="' + m.id + '">' + icon('copy', 12) + ' 复制</button>');
      tools.push('<button class="msg-tool danger" data-act="delete" data-id="' + m.id + '">' + icon('trash', 12) + ' 删除此条及之后</button>');
    } else {
      if (isLast) {
        tools.push('<button class="msg-tool" data-act="regen" data-id="' + m.id + '">' + icon('refresh', 12)
          + (m.status === 'error' ? ' 重试' : ' 重新生成') + '</button>');
      }
      if (m.content || m.reasoning) {
        tools.push('<button class="msg-tool" data-act="copy" data-id="' + m.id + '">' + icon('copy', 12) + ' 复制</button>');
      }
      tools.push('<button class="msg-tool danger" data-act="delete" data-id="' + m.id + '">' + icon('trash', 12) + ' 删除</button>');
    }
    return '<div class="msg-toolbar">' + tools.join('') + '</div>';
  }

  /** 工具/阶段 chip 列表：历史消息用 m.tools，正在跑的用本地 stream.chips */
  function toolLogHtml(m, convId) {
    const stream = state.streams[convId];
    const chips = (stream && stream.assistantId === m.id && stream.chips && stream.chips.length)
      ? stream.chips
      : (m.tools || []);
    if (!chips.length) return '<div class="tool-log"></div>';
    return '<div class="tool-log">' + chips.map(function (c) {
      return toolChipHtml(Object.assign({ state: c.state || 'done' }, c));
    }).join('') + '</div>';
  }

  /* ---------------- 图文讲解（sandbox iframe） ---------------- */

  /** 把消息里的 richDoc 挂到 iframe 上（用 srcdoc 属性而不是 HTML 转义，避免双重编码） */
  function bindRichDocs(root) {
    const hosts = (root || document).querySelectorAll('[data-rich-msg]');
    hosts.forEach(function (host) {
      if (host.querySelector('iframe')) return;
      const msgId = host.getAttribute('data-rich-msg');
      const m = (state.conv && state.conv.messages || []).find(function (x) { return x.id === msgId; });
      if (!m || !m.richDoc) return;
      const iframe = document.createElement('iframe');
      iframe.className = 'rich-frame';
      iframe.setAttribute('sandbox', 'allow-scripts');   // 允许脚本，但无同源权限、无顶层导航
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute('loading', 'lazy');
      iframe.srcdoc = m.richDoc;
      host.innerHTML = '';
      host.appendChild(iframe);
      host.classList.remove('rich-loading');
    });
  }

  // 子文档报告自身高度 → 宿主调整 iframe 高度（避免内部滚动条，读起来像正文的一部分）
  window.addEventListener('message', function (ev) {
    const d = ev.data;
    if (!d || d.__richdoc !== true || typeof d.height !== 'number') return;
    const frames = document.querySelectorAll('iframe.rich-frame');
    frames.forEach(function (f) {
      if (f.contentWindow === ev.source) {
        const h = Math.max(200, Math.min(20000, Math.round(d.height) + 8));
        if (Math.abs((parseInt(f.style.height, 10) || 0) - h) > 4) f.style.height = h + 'px';
      }
    });
  });

  function msgHtml(m, idx, msgs) {
    const streaming = m.status === 'streaming' && isStreaming(state.conv ? state.conv.id : '');
    if (m.role === 'user') {
      const text = contentText(m.content);
      const imgs = contentImages(m.content);
      let bubble = '<div class="msg-bubble">' + MD.escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
      if (imgs.length) {
        bubble += '<div class="msg-images">' + imgs.map(function (u) {
          return '<img src="' + u.replace(/"/g, '&quot;') + '" alt="图片" data-img-viewer>';
        }).join('') + '</div>';
      }
      return '<div class="msg msg-user" data-msg-id="' + m.id + '">'
        + '<div class="msg-avatar">🧑</div>'
        + '<div class="msg-body">' + bubble
        + '<div class="msg-extra"><span>' + MD.formatTime(m.createdAt) + '</span></div>'
        + toolbarHtml(m, idx, msgs)
        + '</div></div>';
    }
    // assistant
    const disp = getDisplay(m);
    const coach = state.conv && state.conv.mode === 'coach';
    let bubble = '';
    // 图文讲解：整份文档渲染在 sandbox iframe 里（脚本被限制、无同源权限）
    if (m.richDoc) {
      bubble += '<div class="rich-host" data-rich-msg="' + m.id + '"><div class="rich-loading">图文讲解加载中…</div></div>';
    }
    if (disp.content) {
      bubble += '<div class="msg-bubble md">' + MD.renderMarkdown(disp.content, { allowHtml: false }) + (streaming ? '<span class="streaming-cursor"></span>' : '') + '</div>';
    } else if (streaming && !m.richDoc) {
      bubble = '<div class="msg-bubble md"><span class="msg-status-note">' + (coach ? '教练解题中…' : '正在生成…') + '</span><span class="streaming-cursor"></span></div>';
    }
    const reason = reasoningHtml(m, disp, streaming);
    let statusNote = '';
    // 区分三种"没有在本地流式接收"的情况：后台生成中 / 用户手动停止 / 异常中断
    const bgRunning = !streaming && m.status === 'streaming' && state.conv && state.conv.active;
    if (bgRunning) {
      statusNote = '<div class="msg-status-note">⏳ 正在生成中（后台运行，可切到别的会话）</div>';
    } else if (!streaming && m.status === 'stopped') {
      statusNote = '<div class="msg-status-note">⏸ 已停止生成' + (disp.content ? '（已保留当前内容）' : '') + '</div>';
    } else if (!streaming && m.status === 'streaming') {
      statusNote = '<div class="msg-status-note">⚠ 生成已中断（可点重新生成）</div>';
    }
    if (!streaming && m.status === 'error' && !disp.content) statusNote = '<div class="msg-status-note">生成失败</div>';
    const extra = '<div class="msg-extra">'
      + '<span>' + MD.formatTime(m.createdAt) + '</span>'
      + (m.model ? '<span>' + MD.escapeHtml(m.model) + '</span>' : '')
      + '<span>' + MD.formatTokens(Object.assign({}, m, { usage: disp.usage })) + '</span>'
      + (MD.formatCost(Object.assign({}, m, { usage: disp.usage }))
        ? '<span class="msg-cost" title="本轮多 Agent 的总消耗（token 来自服务商返回；费用按单价估算，仅供心里有数）">💸 '
          + MD.escapeHtml(MD.formatCost(Object.assign({}, m, { usage: disp.usage }))) + '</span>'
        : '')
      + variantNavHtml(m)
      + '</div>';
    let errorBox = '';
    if (m.status === 'error' && m.error) {
      errorBox = '<div class="msg-error-box"><span class="msg-error-text">' + MD.escapeHtml(m.error) + '</span>'
        + '<button class="msg-error-retry" data-act="regen" data-id="' + m.id + '">重试</button></div>';
    }
    return '<div class="msg msg-assistant" data-msg-id="' + m.id + '">'
      + '<div class="msg-avatar">🧑‍🏫</div>'
      + '<div class="msg-body">'
      + toolLogHtml(m, state.conv ? state.conv.id : '')
      + reason
      + bubble
      + statusNote
      + errorBox
      + extra
      + (streaming ? '' : toolbarHtml(m, idx, msgs))
      + '</div></div>';
  }

  function renderMessages() {
    const view = $('#chat-view');
    if (!state.conv) { renderWelcome(view); return; }
    const msgs = state.conv.messages;
    let html = '';
    if (state.conv.archived) {
      html += '<div class="msg-status-note" style="text-align:center;padding:6px 0 10px">📦 此对话已归档（只读）。如需继续对话，请点击右上角菜单取消归档。</div>';
    }
    if (!msgs.length) {
      html += '<div class="coach-empty">'
        + '<div class="coach-empty-icon">🏆</div>'
        + '<div class="coach-empty-title">这道题，怎么解？</div>'
        + '<div class="coach-empty-sub">输入 Codeforces 题目编号（如 1800C），或粘贴任意题目描述。<br>教练会先对拍验证解法，再按你的水平逐行讲解。</div>'
        + '<div class="coach-empty-actions">'
        + '<button class="btn btn-primary" data-act-empty-cf>📥 从 Codeforces 取题</button>'
        + '</div></div>';
    } else {
      html += msgs.map(function (m, i) { return msgHtml(m, i, msgs); }).join('');
    }
    view.innerHTML = html;
    bindRichDocs(view);
  }

  function renderWelcome(view) {
    const handle = (state.config && state.config.cfHandle || '').trim();
    view.innerHTML =
      '<div class="welcome">'
      + '<div class="welcome-logo">🏆</div>'
      + '<div class="welcome-title">CF <span class="welcome-title-accent">Coach</span> · 你的本地算法教练</div>'
      + '<div class="welcome-sub">支持 Codeforces 一键取题、暴力对拍验证、按你的 rating 定制讲解深度' + (handle ? '，并记住你的优势与薄弱点' : '') + '。<br>所有数据保存在本机，绝不上传。</div>'
      + '<div class="welcome-actions">'
      + '<button class="btn btn-primary btn-lg" data-act-welcome-start>🏆 问一道题</button>'
      + '<button class="btn btn-default btn-lg" data-act-welcome-profile>📋 学员信息卡</button>'
      + '</div>'
      + '<div class="welcome-features">'
      + ['📥 CF 一键取题', '⚔️ 暴力对拍验证', '🧪 官方样例自测', '👤 rating 自适应', '🧠 学员信息卡'].map(function (f) {
        return '<span class="welcome-feature">' + f + '</span>';
      }).join('')
      + '</div>'
      + '</div>';
  }

  function autoScroll() {
    const sc = $('#chat-scroll');
    const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    if (near) sc.scrollTop = sc.scrollHeight;
    $('#btn-scroll-bottom').hidden = near;
  }

  function scrollBottom(force) {
    const sc = $('#chat-scroll');
    const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    if (force || near) sc.scrollTop = sc.scrollHeight;
    $('#btn-scroll-bottom').hidden = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  }

  /* ---------------- 消息操作 ---------------- */

  function findMsg(id) {
    return state.conv ? state.conv.messages.find(function (m) { return m.id === id; }) : null;
  }

  function chatAction(act, id) {
    const m = findMsg(id);
    if (!m || !state.conv) return;
    const conv = state.conv;

    if (act === 'copy') {
      const disp = m.role === 'assistant' ? getDisplay(m) : { content: m.content };
      const text = contentText(disp.content);
      navigator.clipboard.writeText(text).then(function () {
        toast('已复制', 'success', 1400);
      }).catch(function () {
        toast('复制失败', 'error');
      });
      return;
    }

    if (act === 'edit') {
      if (isStreaming(conv.id)) { toast('正在生成中，请先停止', 'error'); return; }
      startEdit(m);
      return;
    }

    if (act === 'regen') {
      if (isStreaming(conv.id)) { toast('正在生成中，请先停止', 'error'); return; }
      if (conv.archived) { toast('已归档的对话不能生成，请先取消归档', 'error'); return; }
      startRegenerate();
      return;
    }

    if (act === 'delete') {
      if (isStreaming(conv.id)) { toast('正在生成中，请先停止', 'error'); return; }
      if (m.role === 'user') {
        confirmModal({ title: '删除消息', message: '将删除这条用户消息及其之后的所有消息（回滚到此处），确定吗？', okText: '删除', danger: true })
          .then(function (ok) {
            if (!ok) return;
            const idx = conv.messages.indexOf(m);
            conv.messages = conv.messages.slice(0, idx);
            saveMessages(conv);
          });
      } else {
        conv.messages = conv.messages.filter(function (x) { return x.id !== m.id; });
        delete state.variants[m.id];
        saveMessages(conv);
      }
      return;
    }

    if (act === 'vprev' || act === 'vnext') {
      const idx = getVariantIdx(m);
      const next = act === 'vprev' ? idx - 1 : idx + 1;
      const max = (m.alternates || []).length;
      if (next < 0 || next > max) return;
      state.variants[m.id] = next;
      renderMessages();
      return;
    }
  }

  async function saveMessages(conv) {
    const updated = await api('/api/conversations/' + conv.id + '/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: conv.messages })
    });
    state.conv = updated;
    renderMessages();
    refreshList();
  }

  /* ---------------- 编辑重发 ---------------- */

  function startEdit(m) {
    state.edit = { messageId: m.id };
    const input = $('#input');
    const text = contentText(m.content);
    input.value = text;
    $('#edit-chip').hidden = false;
    autosizeInput();
    focusInput();
    toast('编辑后发送，将替换这条消息并重新生成后续内容', 'info');
  }

  function clearEditChip() {
    state.edit = null;
    $('#edit-chip').hidden = true;
  }

  /* ---------------- 流式聊天 ---------------- */

  async function resyncConversation() {
    const conv = await api('/api/conversations/' + state.conv.id);
    state.conv = conv;
    renderHeader();
    renderMessages();
    renderProblemPanel();
    updateComposer();
  }

  function startStream(payload) {
    const convId = payload.conversationId;
    const ctrl = new AbortController();
    const stream = { ctrl: ctrl, assistantId: null, queued: true, buffer: '', reasoning: '', terminal: false, chips: [] };
    state.streams[convId] = stream;
    state.agentRuns[convId] = [];       // 新一轮：清空 Agent 工作台
    stopWatching(convId);               // 本地已经在接收流了，不用轮询
    updateComposer();
    renderList();
    renderHeader();

    const finish = function () {
      delete state.streams[convId];
      // 流异常结束（既没收到 done/error/stopped，也不是用户手动停止）：
      // 本地标记为已停止，避免界面永远转圈
      if (!stream.terminal && !ctrl.signal.aborted) {
        markLocalStopped(convId, stream);
      }
      // 把本地还挂着"进行中"的步骤 chip 收尾：否则那枚转圈图标会一直转下去
      (stream.chips || []).forEach(function (c) {
        if (c.state === 'running') { c.state = 'done'; c.ok = false; c.summary = c.summary || '已中断'; }
      });
      closeAgentRuns(convId);
      if (state.conv && state.conv.id === convId) {
        scheduleAgentPaint(convId);
        renderMessages();          // 让 chip 的中断状态立刻可见
        // **无论是正常结束、异常结束还是用户手动停止**，都回服务端拉一次真实状态：
        // 会话的 active 标记（列表转圈 / "正在生成中"字样都由它决定）只有服务端说了算
        resyncConversation().then(function () {
          if (state.conv && state.conv.id === convId) { renderMessages(); renderHeader(); renderProblemPanel(); }
        }).catch(function () { /* ignore */ });
        refreshList().catch(function () { /* ignore */ });
        refreshWorkspace().then(function () { renderProblemPanel(); });
      }
      updateComposer();
      renderList();
      renderHeader();
      // 手动停止 / 异常结束：服务端稍后才释放"正在生成"登记，等它清掉再收尾（否则界面一直转圈）
      if (ctrl.signal.aborted || !stream.terminal) settleActiveFlags(convId);
    };

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    }).then(async function (r) {
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { msg = (await r.json()).error || msg; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleStreamEvent(chunk, stream, payload);
        }
      }
    }).catch(function (e) {
      if (ctrl.signal.aborted) {
        markLocalStopped(convId, stream);
      } else {
        markLocalError(convId, stream, e.message || String(e));
        toast(e.message || '请求失败', 'error');
      }
    }).finally(finish);
  }

  function handleStreamEvent(chunk, stream, payload) {
    let data = null;
    chunk.split('\n').forEach(function (line) {
      if (line.indexOf('data:') === 0) {
        try { data = JSON.parse(line.slice(5).trim()); } catch (e) { /* ignore */ }
      }
    });
    if (!data) return;
    const convId = payload.conversationId;

    if (data.type === 'meta') {
      stream.queued = false;
      stream.assistantId = data.assistantMessageId;
      if (state.conv && state.conv.id === convId) {
        resyncConversation();
      }
      return;
    }
    if (data.type === 'delta') {
      stream.buffer += data.text;
      if (state.conv && state.conv.id === convId) scheduleStreamPaint(convId);
      return;
    }
    // Agent 工作台：每个子 Agent 的实时思考与输出
    if (data.type === 'agentStart') {
      // 讲解重跑（结构校验后的定向修复）：清空流式缓冲，
      // 否则界面上会先显示草稿、再拼接修复版（定稿虽是修复版，过程中会闪错）
      if (data.reset && data.role === 'explainer') {
        const st = state.streams[convId];
        if (st) {
          st.buffer = '';
          st.reasoning = '';
          st._reasonPainted = 0;
          if (state.conv && state.conv.id === convId && st.assistantId) {
            const el = document.querySelector('[data-msg-id="' + st.assistantId + '"] .reasoning-content');
            if (el) el.textContent = '';
          }
          scheduleStreamPaint(convId);
        }
      }
      const list = state.agentRuns[convId] = state.agentRuns[convId] || [];
      // 题解 / 暴力 / 生成器是**并发**跑的：只能按角色关掉"同一个角色的上一次"，
      // 绝不能把"所有 open 的都关掉"——那会让同时开跑的三个 Agent 只剩一个在跑
      AgentRuns.start(list, data);
      scheduleAgentPaint(convId);
      ensureAgentTicker(convId);
      return;
    }
    if (data.type === 'agentDelta' || data.type === 'agentReasoning') {
      const list = state.agentRuns[convId] = state.agentRuns[convId] || [];
      AgentRuns.append(list, data);
      scheduleAgentPaint(convId);
      return;
    }
    if (data.type === 'agentEnd') {
      const list = state.agentRuns[convId] = state.agentRuns[convId] || [];
      AgentRuns.end(list, data);
      scheduleAgentPaint(convId);
      return;
    }
    if (data.type === 'reasoningDelta') {
      stream.reasoning += data.text;
      if (state.conv && state.conv.id === convId) scheduleStreamPaint(convId);
      return;
    }
    if (data.type === 'richDoc') {
      // 图文文档就绪：把文档挂到消息上（内容随 done 一起落盘）
      if (stream.assistantId && state.conv && state.conv.id === convId) {
        const m = state.conv.messages.find(function (x) { return x.id === stream.assistantId; });
        if (m && data.html) m.richDoc = data.html;
        /**
         * **立刻整条重画**，不要等 done。
         *
         * 真实反馈："到后面好像卡住了，没有报告出来而是大量文字，然后我暂停生成了之后报告又突然弹出来了。"
         * 原因就是这个事件只改了数据、没有触发渲染：文档早就到了，界面上却什么都没有，
         * 直到用户点停止（done 触发整屏重画）文档才冒出来 —— 看起来像卡住了。
         * 注意必须用 renderMessages（整条消息重建）而不是 paintStream（只换气泡里的文字）：
         * 文档的宿主节点 `.rich-host` 是渲染消息时创建的，只更新文字不会把它加进去。
         */
        renderMessages();
      }
      return;
    }
    if (data.type === 'done') {
      stream.terminal = true;
      closeAgentRuns(convId);
      if (state.conv && state.conv.id === convId) scheduleAgentPaint(convId);
      if (state.conv && state.conv.id === convId && data.message) {
        const idx = state.conv.messages.findIndex(function (m) { return m.id === data.message.id; });
        if (idx >= 0) {
          state.conv.messages[idx] = data.message;
          state.variants[data.message.id] = (data.message.alternates || []).length;
        }
        renderHeader();
        renderMessages();
        renderProblemPanel();
        scrollBottom(true);
        // 讲解结束后题目分类可能异步更新，稍后再刷新面板
        setTimeout(function () {
          if (state.conv && state.conv.id === convId) {
            api('/api/conversations/' + convId).then(function (c) {
              if (state.conv && state.conv.id === convId) {
                state.conv.problemMeta = c.problemMeta;
                state.conv.cfProblemSamples = c.cfProblemSamples;
                renderProblemPanel();
                renderHeader();
                refreshList();
              }
            }).catch(function () { /* ignore */ });
          }
        }, 6000);
      }
      return;
    }
    if (data.type === 'error') {
      stream.terminal = true;
      closeAgentRuns(convId);
      if (state.conv && state.conv.id === convId) {
        const m = state.conv.messages.find(function (x) { return x.id === stream.assistantId; });
        if (m) {
          m.status = 'error';
          m.error = data.message;
          m.content = m.content || data.content || '';
        }
        renderMessages();
        scheduleAgentPaint(convId);
      }
      toast(data.message || '生成失败', 'error');
      return;
    }
    if (data.type === 'stopped') {
      stream.terminal = true;
      closeAgentRuns(convId);
      if (state.conv && state.conv.id === convId) {
        if (data.message) {
          const idx = state.conv.messages.findIndex(function (m) { return m.id === data.message.id; });
          if (idx >= 0) state.conv.messages[idx] = data.message;
        }
        renderMessages();
        scheduleAgentPaint(convId);
        refreshWorkspace().then(function () { renderProblemPanel(); });
      }
      return;
    }
    // 算法教练：工具调用 / 结果（后台会话也累积到 stream.chips，切回去就能看到）
    if (data.type === 'tool') {
      if (stream.assistantId) {
        (data.calls || []).forEach(function (call) {
          let label = '';
          try { label = (JSON.parse(call.args || '{}').label) || ''; } catch (e) { /* ignore */ }
          appendToolChip(convId, stream.assistantId, { id: call.id, name: call.name, label: label, state: 'running' });
        });
      }
      return;
    }
    if (data.type === 'toolResult') {
      if (stream.assistantId) {
        (data.results || []).forEach(function (r) {
          updateToolChip(convId, stream.assistantId, { id: r.id, name: r.name, ok: r.ok, summary: r.summary });
        });
        if (state.conv && state.conv.id === convId) scrollBottom(false);
        // 工作区文件/验证状态可能刚变化：刷新右侧面板
        refreshWorkspace().then(function () {
          if (state.conv && state.conv.id === convId) renderProblemPanel();
        });
      }
      return;
    }
  }

  const TOOL_NAMES = {
    // 多 Agent 编排（当前架构）
    harness_overview: '编排计划',
    harness_contract: '抽取 I/O 契约',
    harness_router: '追问路由判断',
    harness_idea: '做法可行性评估',
    harness_reuse: '复用同题缓存产物',
    harness_health: '代码体检（编译/UB）',
    agent_solution: '题解 Agent（隔离）',
    agent_brute: '暴力 Agent（隔离·标尺）',
    agent_gen: '数据生成 Agent（仅输入契约）',
    harness_userhealth: '你的代码体检',
    harness_samples: '官方样例校准',
    harness_stress: '批量对拍',
    harness_minimize: '最小化反例',
    harness_usercode: '你的代码 vs 题解',
    harness_cleanup: '清理临时区',
    agent_explainer: '讲解 Agent',
    // 取题
    cf_fetch_problem: '获取 CF 题面',
    cf_get_user: '查询用户水平',
    // 历史工具名（兼容旧记录）
    write_file: '写入工作区',
    read_file: '读取工作区',
    list_files: '查看工作区',
    run_samples: '运行官方样例',
    stress_verify: '暴力对拍验证',
    clear_scratch: '清理工作区'
  };

  /** agent 角色中文名（决策轨迹用） */
  const AGENT_ROLES = {
    solution: '题解 Agent',
    brute: '暴力 Agent',
    gen: '数据生成 Agent',
    explainer: '讲解 Agent',
    plan: '讲解提纲 Agent',
    normalize: '题面整理 Agent',
    witness: '手算锚点 Agent',
    router: '路由判断器',
    idea: '做法评估 Agent',
    adjudicate: '错因仲裁 Agent'
  };

  function toolChipHtml(chip) {
    const base = TOOL_NAMES[chip.name] || chip.name;
    const label = chip.label ? (base + ' · ' + chip.label) : base;
    let iconHtml;
    if (chip.state === 'running') iconHtml = '<span class="tool-chip-spin"></span>';
    else iconHtml = chip.ok ? '<span class="tool-chip-icon ok">✓</span>' : '<span class="tool-chip-icon bad">✕</span>';
    const summary = chip.summary ? '<span class="tool-chip-summary">' + MD.escapeHtml(chip.summary) + '</span>' : '';
    return '<div class="tool-chip ' + chip.state + '" data-tool-id="' + MD.escapeHtml(chip.id || '') + '">'
      + iconHtml + '<span class="tool-chip-name">' + MD.escapeHtml(label) + '</span>' + summary + '</div>';
  }

  function appendToolChip(convId, assistantId, chip) {
    const stream = state.streams[convId];
    if (stream && stream.assistantId === assistantId) {
      stream.chips = stream.chips || [];
      stream.chips.push(Object.assign({ state: 'running' }, chip));
    }
    paintToolLog(convId, assistantId);
  }

  function updateToolChip(convId, assistantId, chip) {
    const stream = state.streams[convId];
    if (stream && stream.assistantId === assistantId) {
      stream.chips = stream.chips || [];
      const t = stream.chips.find(function (x) { return x.id === chip.id; });
      if (t) Object.assign(t, chip, { state: 'done' });
      else stream.chips.push(Object.assign({ state: 'done' }, chip));
    }
    paintToolLog(convId, assistantId);
  }

  /** 把 chip 列表画进消息的 .tool-log（每次整体重画，重渲染不会丢） */
  function paintToolLog(convId, assistantId) {
    // 只在"当前正看着这个会话"时动 DOM；后台会话的 chip 留在 stream.chips 里，切回来会在 renderMessages 里画出来
    if (!state.conv || state.conv.id !== convId) return;
    const msgEl = document.querySelector('[data-msg-id="' + assistantId + '"]');
    if (!msgEl) return;
    const log = msgEl.querySelector('.tool-log');
    if (!log) return;
    const stream = state.streams[convId];
    const chips = (stream && stream.assistantId === assistantId && stream.chips) ? stream.chips : [];
    log.innerHTML = chips.map(function (c) {
      return toolChipHtml(Object.assign({ state: c.state || 'done' }, c));
    }).join('');
    scrollBottom(false);
  }

  /* ---------------- Agent 工作台（实时看到每个子 Agent 在干什么） ---------------- */

  function closeAgentRuns(convId, role) {
    const list = (state.agentRuns || {})[convId] || [];
    // 用统一的收尾（会补上真实耗时）：否则中途停止时那些没等到 agentEnd 的运行会显示成"0s 完成"
    AgentRuns.closeAll(list, role);
  }

  const agentPaintState = {};
  /**
   * 在工作台里按**角色**找对应的那次运行（实现见 public/js/agentruns.js，那里有单测）。
   * 为什么不能按"最后一个 open 的"来找：题解 / 暴力 / 生成器是并发跑的，
   * 谁先结束不确定 —— 按下标匹配会把 A 的结束/增量算到 B 头上。
   */
  function findAgentRun(list, role, label) {
    return AgentRuns.find(list, role, label);
  }

  function scheduleAgentPaint(convId) {
    if (agentPaintState[convId]) return;
    agentPaintState[convId] = requestAnimationFrame(function () {
      agentPaintState[convId] = null;
      if (state.conv && state.conv.id === convId) renderAgentWorkbench();
    });
  }

  /**
   * 有 Agent 在跑时，每秒重画一次工作台：让"进行中 Ns"和流式内容动起来。
   * （之前只在事件到达时重画，长思考期间看起来像卡死了 —— 学员反馈"思考过程不可见"）
   */
  const agentTick = {};
  function ensureAgentTicker(convId) {
    const list = (state.agentRuns || {})[convId] || [];
    const running = list.some(function (r) { return r.open; });
    if (running && !agentTick[convId]) {
      agentTick[convId] = setInterval(function () {
        const l = (state.agentRuns || {})[convId] || [];
        if (!l.some(function (r) { return r.open; })) {
          clearInterval(agentTick[convId]);
          agentTick[convId] = null;
          return;
        }
        if (state.conv && state.conv.id === convId) renderAgentWorkbench();
      }, 1000);
    }
  }

  function renderAgentWorkbench() {
    const box = document.querySelector('[data-agent-workbench]');
    if (!box) return;
    const convId = state.conv ? state.conv.id : '';
    const list = (state.agentRuns || {})[convId] || [];
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const running = list.some(function (r) { return r.open; });
    let html = '<div class="pp-card"><div class="pp-sec-title">🧠 Agent 工作台'
      + (running ? '<span class="pp-ws-status warn">实时</span>' : '<span class="pp-ws-status ok">已完成</span>')
      + '</div><div class="form-hint" style="margin:-2px 0 6px">各子 Agent 的实时思考与产出（点标题展开）</div>';
    list.slice().reverse().forEach(function (r, i) {
      const roleName = AGENT_ROLES[r.role] || r.role;
      const secs = ((r.ms || (r.open ? Date.now() - r.at : 0)) / 1000).toFixed(0);
      const body = r.text || '';
      const think = r.reasoning || '';
      html += '<details class="pp-agent"' + (i === 0 ? ' open' : '') + '>'
        + '<summary><b>' + MD.escapeHtml(r.label || roleName) + '</b>'
        + '<span class="pp-agent-meta">' + secs + 's · ' + (r.open ? '进行中' : (r.interrupted ? '已中断' : (r.ok === false ? '失败' : '完成'))) + '</span></summary>'
        // 思考过程：实时显示（只收不显示等于没给学员看）
        + (think ? '<div class="pp-agent-think"><div class="pp-agent-think-title">💭 思考中</div><pre>'
          + MD.escapeHtml(think.slice(-4000)) + '</pre></div>' : '')
        + (body ? '<div class="pp-agent-out"><pre>' + MD.escapeHtml(body.slice(-6000)) + '</pre></div>'
          : (r.open ? '<div class="pp-agent-out"><pre>（等待输出…）</pre></div>' : ''))
        + '</details>';
    });
    html += '</div>';
    box.innerHTML = html;
    const details = box.querySelectorAll('details.pp-agent');
    if (details.length) {
      // 自动展开最新一个（正在跑的那个）
      details.forEach(function (d, i) { d.open = (i === 0); });
    }
  }

  const paintQueued = {};
  function scheduleStreamPaint(convId) {
    const stream = state.streams[convId];
    if (!stream || stream.raf) return;
    stream.raf = requestAnimationFrame(function () {
      stream.raf = null;
      paintStream(convId);
    });
  }

  function paintStream(convId) {
    const stream = state.streams[convId];
    if (!stream || !stream.assistantId) return;
    const msgEl = document.querySelector('[data-msg-id="' + stream.assistantId + '"]');
    if (!msgEl) return;
    const bubble = msgEl.querySelector('.msg-bubble');
    if (bubble) {
      bubble.innerHTML = MD.renderMarkdown(stream.buffer || '', { allowHtml: false }) + '<span class="streaming-cursor"></span>';
    }
    // 思考过程：**增量追加**而不是整体重写。
    // 整体重写会把用户的滚动位置/选中文本一起重置（"思考中滑杆拖不动"就是这个原因）。
    const reason = msgEl.querySelector('.reasoning-content');
    if (reason) {
      const full = stream.reasoning || '';
      const painted = stream._reasonPainted || 0;
      if (full.length < painted) {          // 重新开始（重生成）：整体替换
        reason.textContent = full;
        stream._reasonPainted = full.length;
      } else if (full.length > painted) {
        const box = reason.closest('.reasoning-box') || reason;
        const atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 24;
        reason.appendChild(document.createTextNode(full.slice(painted)));
        stream._reasonPainted = full.length;
        // 只有用户本来就在底部时才跟随；用户往上翻时绝不抢滚动位置
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
    }
    const summary = msgEl.querySelector('.reasoning-title');
    if (summary && stream.reasoning) summary.textContent = '思考过程';
    autoScroll();
  }

  function markLocalStopped(convId, stream) {
    // 步骤 chip 也要一起收尾（服务端可能来不及回传"已中断"，本地先兜住，避免一直转圈）
    (stream.chips || []).forEach(function (c) {
      if (c.state === 'running') { c.state = 'done'; c.ok = false; c.summary = c.summary || '已中断'; }
    });
    if (state.conv && state.conv.id === convId) {
      const m = stream.assistantId ? state.conv.messages.find(function (x) { return x.id === stream.assistantId; }) : null;
      if (m) {
        if (stream.buffer) m.content = stream.buffer;
        if (stream.reasoning) m.reasoning = stream.reasoning;
        m.status = 'stopped';
      }
      renderMessages();
    }
  }

  function markLocalError(convId, stream, message) {
    if (state.conv && state.conv.id === convId) {
      const m = stream.assistantId ? state.conv.messages.find(function (x) { return x.id === stream.assistantId; }) : null;
      if (m) {
        if (stream.buffer) m.content = stream.buffer;
        if (stream.reasoning) m.reasoning = stream.reasoning;
        m.status = 'error';
        m.error = message;
      }
      renderMessages();
    }
  }

  function stopStreaming(convId, silent) {
    const stream = state.streams[convId];
    // 先显式通知服务端停止：浏览器 abort fetch 时服务端不一定收到"连接关闭"，
    // 只靠本地中断会留下"服务端还在生成"的登记 → 界面一直转圈 / 显示"正在生成中"
    api('/api/chat/stop', { method: 'POST', body: JSON.stringify({ conversationId: convId }) })
      .catch(function () { /* 服务端没在生成或请求失败都不影响本地收尾 */ })
      .then(function () { settleActiveFlags(convId); });
    if (!stream) { settleActiveFlags(convId); return; }
    try { stream.ctrl.abort(); } catch (e) { /* ignore */ }
    if (!silent) toast('已停止生成');
  }

  /* ---------------- 发送 / 重新生成 ---------------- */

  function sendCurrentMessage() {
    const conv = state.conv;
    if (!conv) return;
    if (isStreaming(conv.id)) { stopStreaming(conv.id); return; }
    if (conv.archived) { toast('已归档的对话为只读，请先取消归档', 'error'); return; }

    const input = $('#input');
    const text = input.value;
    if (!text.trim()) return;
    if (!state.config.providers.length) {
      toast('请先添加模型服务', 'error');
      openSettings('providers');
      return;
    }
    if (!conv.model) {
      toast('请先选择模型：点击输入框下方的模型名', 'error');
      openModelMenu($('#btn-model-select'));
      return;
    }

    const payload = {
      conversationId: conv.id,
      mode: state.edit ? 'edit' : 'send',
      userContent: text,
      baseUserMessageId: state.edit ? state.edit.messageId : undefined
    };

    // 清空输入
    input.value = '';
    clearEditChip();
    autosizeInput();

    startStream(payload);
    scrollBottom(true);
  }

  function startRegenerate() {
    const conv = state.conv;
    if (!conv || !conv.messages.length) return;
    if (isStreaming(conv.id)) return;
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    startStream({ conversationId: conv.id, mode: 'regenerate' });
  }

  /* ---------------- 输入框 ---------------- */

  /** 浏览器是否支持 field-sizing（支持就完全不需要 JS 量高度） */
  const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content');

  /**
   * 输入框自适应高度（**老内核兜底**）。
   *
   * 现代 Chromium 有 `field-sizing: content`，#input 的高度由浏览器跟着内容算，
   * 与"哪个事件有没有触发"无关；只有不支持时才走这里量 scrollHeight。
   * 量的时候上限**从 CSS 读**，不在这里再写死一个数字 —— 两边各写一份就会出现
   * "改了 CSS 不改这里，框子卡在旧上限"。
   */
  function autosizeInput() {
    const input = $('#input');
    if (!input) return;
    if (FIELD_SIZING) { input.style.height = ''; return; }   // 交给 CSS，别用内联高度顶掉它
    input.style.height = 'auto';
    const cs = getComputedStyle(input);
    const cap = parseFloat(cs.maxHeight);
    // 全局 box-sizing: border-box → 设的高度包含内边距与边框，所以要把它们加回 scrollHeight，
    // 否则内容总差那么几像素、textarea 会凭空多出一条滚动条（看起来像"还没显示完"）。
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const bd = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    input.style.height = Math.min(input.scrollHeight + pad + bd, cap > 0 ? cap : 400) + 'px';
  }

  /**
   * 下一次绘制后再量一次。
   * 有些路径（拖入文本、部分输入法）事件触发时新值还没进布局，同步量会得到旧高度。
   */
  function scheduleAutosize() {
    autosizeInput();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { autosizeInput(); });
  }

  function focusInput() {
    const input = $('#input');
    if (input.disabled) return;
    input.focus();
  }

  const LANG_NAMES = { cpp: 'C++23', python: 'Python 3' };
  const INTENT_NAMES = {
    auto: '自动判断',
    full: '完整讲解',
    hint: '思路提示',
    explain: '题干解读',
    debug: '代码评估'
  };
  /** 每种提问意图一个专属图标（菜单 / 工具栏都用它，别再全长一样） */
  const INTENT_ICONS = {
    auto: 'compass',
    full: 'book',
    hint: 'bulb',
    explain: 'search',
    debug: 'bug'
  };
  const INTENT_EMOJI = { auto: '🤖', full: '🎯', hint: '💡', explain: '📖', debug: '🐞' };
  function intentIcon(intent, size) { return icon(INTENT_ICONS[intent] || 'compass', size); }
  function langName(lang) { return LANG_NAMES[lang] || 'C++23'; }
  function intentName(intent) { return INTENT_NAMES[intent] || '自动判断'; }
  function intentHintText(intent) {
    const texts = {
      auto: '默认：教练自己看你这句在要什么（完整讲解 / 只给思路 / 解读题意 / 评估代码），并按对应技能去做——'
        + '和你不用手点技能是一回事。想固定行为时再手动指定。',
      full: '标准流程：题面拆解 → 思路 → 复杂度分析 → 验证过的完整代码 → 逐行讲解。',
      hint: '只给方向与关键观察（L0–L2，含目标复杂度）；验证链路照样全量跑，你随时说"给答案"就能升级到完整代码。',
      explain: '只解释题意、样例推导与数据范围，不讲做法，不跑代码链路。',
      debug: '两种用法都走这条最重的链路：① 贴你的代码问为什么 WA/TLE → 先体检（编译/UB）再与暴力解、正解三方对拍，用最小反例定位到具体那一行；'
        + '② 只提一个做法问行不行（如"用 Floyd 能写吗"）→ 先做可行性评估，可行就用已验证的暴力解当标尺实测。两种都会对比复杂度。'
    };
    return texts[intent] || texts.auto;
  }

  function updateComposer() {
    const conv = state.conv;
    const stream = conv ? state.streams[conv.id] : null;
    const sendBtn = $('#btn-send');
    const input = $('#input');
    const sendIcon = $('#icon-send');
    const stopIcon = $('#icon-stop');
    const modelLabel = $('#model-select-label');

    if (conv) {
      modelLabel.textContent = conv.model || '未选择模型';
    } else {
      modelLabel.textContent = '选择模型';
    }

    // 纯教练模式：讲解语言 / 提问意图 / CF 取题按钮常驻
    const lang = conv ? (conv.lang || (state.config && state.config.defaultCoachLang) || 'cpp') : ((state.config && state.config.defaultCoachLang) || 'cpp');
    const langLabel = $('#lang-select-label');
    if (langLabel) langLabel.textContent = langName(lang);
    const intent = conv ? (INTENT_NAMES[conv.intent] ? conv.intent : 'auto') : 'auto';
    const intentLabel = $('#intent-select-label');
    if (intentLabel) intentLabel.textContent = intentName(intent);
    const intentIconEl = $('#intent-select-icon');
    if (intentIconEl) intentIconEl.textContent = INTENT_EMOJI[intent] || '🎯';
    const cfImport = $('#btn-cf-import');
    if (cfImport) cfImport.hidden = !conv;
    updateCoachLevelHint();

    if (stream) {
      sendBtn.classList.add('stop');
      sendIcon.style.display = 'none';
      stopIcon.style.display = '';
      sendBtn.disabled = false;
      sendBtn.title = '停止生成';
      input.disabled = true;
      input.placeholder = '教练正在解题验证中…';
      return;
    }
    sendBtn.classList.remove('stop');
    sendIcon.style.display = '';
    stopIcon.style.display = 'none';
    sendBtn.title = '发送';
    if (!conv) {
      input.disabled = true;
      input.placeholder = '点「问一道题」开始…';
      sendBtn.disabled = true;
      return;
    }
    if (conv.archived) {
      input.disabled = true;
      input.placeholder = '此对话已归档（只读）';
      sendBtn.disabled = true;
      return;
    }
    input.disabled = false;
    input.placeholder = '输入 Codeforces 题目编号（如 1800C），或直接粘贴题面…';
    const hasContent = input.value.trim().length > 0;
    sendBtn.disabled = !hasContent;
  }

  /* ---------------- 算法教练：模式切换 / CF 取题 ---------------- */

  function updateCoachLevelHint() {
    const hint = $('#coach-level-hint');
    if (!hint) return;
    const handle = (state.config && state.config.cfHandle || '').trim();
    if (handle && state.conv) {
      hint.hidden = false;
      hint.textContent = '👤 ' + handle + '（按你的 CF 水平讲解）';
    } else {
      hint.hidden = true;
    }
  }

  /** 讲解语言选择（C++ / Python），保存到当前会话 */
  function openLangMenu(anchor) {
    const conv = state.conv;
    if (!conv) {
      // 没打开题目时自动新建，保证下拉按钮始终有响应
      toast('已为你新建一道题', 'info', 1500);
      createConversation().then(function () { openLangMenu(anchor); }).catch(function (e) { toast(e.message, 'error'); });
      return;
    }
    const current = conv.lang || (state.config && state.config.defaultCoachLang) || 'cpp';
    openMenu(anchor, [
      { label: '__note__', note: '选择讲解语言（代码与逐行讲解均使用该语言）' },
      { label: 'C++23', icon: current === 'cpp' ? 'check' : 'model', onClick: function () { applyLang('cpp'); } },
      { label: 'Python 3', icon: current === 'python' ? 'check' : 'model', onClick: function () { applyLang('python'); } }
    ]);
  }

  function applyLang(lang) {
    const conv = state.conv;
    if (!conv) return;
    patchConv(conv.id, { lang: lang }).then(function () {
      updateComposer();
      toast('讲解语言：' + langName(lang), 'success', 1600);
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  /** 提问意图选择（完整讲解 / 思路提示 / 题干解读 / 代码评估） */
  function openIntentMenu(anchor) {
    const conv = state.conv;
    if (!conv) {
      toast('已为你新建一道题', 'info', 1500);
      createConversation().then(function () { openIntentMenu(anchor); }).catch(function (e) { toast(e.message, 'error'); });
      return;
    }
    const current = INTENT_NAMES[conv.intent] ? conv.intent : 'auto';
    const items = [{ label: '__note__', note: '默认「自动判断」——教练看你这句话要什么，自己选做法' }];
    Object.keys(INTENT_NAMES).forEach(function (key) {
      items.push({
        label: INTENT_NAMES[key] + (key === 'auto' ? '（推荐）' : '') + (current === key ? ' ✓' : ''),
        icon: INTENT_ICONS[key],
        onClick: function () { applyIntent(key); }
      });
      if (key === 'auto') items.push('-');   // 把"自动"和四个固定选项分开，表明它是默认档
    });
    openMenu(anchor, items);
  }

  function applyIntent(intent) {
    const conv = state.conv;
    if (!conv) return;
    patchConv(conv.id, { intent: intent }).then(function () {
      updateComposer();
      toast('提问意图：' + intentName(intent), 'success', 1600);
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  /* ---------------- 页面路由（教练 / 题目库 / 我的 / 设置） ---------------- */

  const VIEW_TITLES = {
    library: '📚 题目库', profile: '👤 我的', settings: '⚙️ 设置',
    'conv-settings': '🗂 这道题的设置', 'provider-edit': '🔌 模型服务'
  };
  const PAGES = ['library', 'profile', 'settings', 'conv-settings', 'provider-edit'];

  function switchView(view) {
    if (view === 'coach' && state.view && state.view !== 'coach' && state.view !== 'conv-settings') {
      /* 记录来源页，便于返回 */
    }
    if (view !== 'coach' && state.view !== view) state.prevView = state.view;
    state.view = view;
    const wb = $('.workbench');
    if (wb) wb.hidden = (view !== 'coach');
    const scrollBtn = $('#btn-scroll-bottom');
    if (scrollBtn) scrollBtn.hidden = (view !== 'coach');
    PAGES.forEach(function (key) {
      const el = $('#page-' + key);
      if (el) el.hidden = (key !== view);
    });
    $$('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.id === 'btn-' + view);
    });
    const titleEl = $('#header-title');
    if (titleEl) titleEl.textContent = (view === 'coach') ? ((state.conv && state.conv.title) || 'CF Coach') : (VIEW_TITLES[view] || 'CF Coach');
    const chips = document.querySelector('.header-chips');
    if (chips) chips.hidden = (view !== 'coach');
    if (view === 'library') renderLibraryPage();
    else if (view === 'profile') renderProfilePage();
    else if (view === 'settings') renderSettingsPage();
    else if (view === 'conv-settings') renderConvSettingsPage();
    else if (view === 'provider-edit') renderProviderEditPage();
    else renderProblemPanel();
  }

  /** 返回上一页（子页面 → 设置页 / 教练视图） */
  function goBack() {
    const prev = state.prevView && state.prevView !== state.view ? state.prevView : 'coach';
    switchView(prev);
  }

  /* ---------------- 题目面板（右侧工作台） ---------------- */

  /** 验证工作区卡片：题解 / 暴力 / 生成器 + 对拍状态（数据来自 /api/workspace） */
  function workspaceCardHtml() {
    const ws = state.workspace;
    if (!ws) {
      return '<div class="pp-card" data-pp-ws><div class="pp-sec-title">🧪 验证工作区</div>'
        + '<div class="pp-ws-empty">还没有代码。教练会先写题解 + 暴力解 + 生成器，跑通对拍后再讲解。</div></div>';
    }
    const files = ws.files || [];
    const v = ws.verification;
    const statusMap = {
      ok: ['ok', '✓ 对拍通过'],
      mismatch: ['bad', '✕ 发现反例'],
      'brute-failed': ['warn', '⚠ 暴力解未过样例'],
      error: ['bad', '✕ 运行出错'],
      'multi-answer': ['warn', '⚠ 多解题·不可判'],
      'degraded-brute': ['warn', '⚠ 降级：交付暴力解']
    };
    const st = v ? (statusMap[v.status] || ['warn', v.status || '未知']) : null;
    // P0：对拍被截断 / 题解没过样例 / 交付前最大规模计时没过时不许显示成"✓ 对拍通过"——部分验证必须看得见。
    if (v && v.status === 'ok' && (v.scopeComplete === false || v.claimVerified === false)) st[1] = '◐ 部分验证';
    let html = '<div class="pp-card" data-pp-ws><div class="pp-sec-title">🧪 验证工作区'
      + (st ? '<span class="pp-ws-status ' + st[0] + '">' + MD.escapeHtml(st[1]) + '</span>' : '')
      + '</div>';
    if (!files.length) {
      html += '<div class="pp-ws-empty">缓冲区为空。</div>';
    } else {
      files.forEach(function (f) {
        html += '<div class="pp-ws-file">'
          + '<span class="pp-ws-name">' + MD.escapeHtml(f.name) + '</span>'
          + '<span class="pp-ws-size">' + Math.round((f.size || 0) / 102.4) / 10 + 'KB</span>'
          + '<button class="pp-ws-view" data-ws-view="' + MD.escapeHtml(f.name) + '">查看</button>'
          + '</div>';
      });
    }
    if (v) {
      html += '<div class="pp-kv"><span>验证时间</span><b>' + MD.timeAgo(v.at) + '</b></div>';
      if (v.iterations) html += '<div class="pp-kv"><span>对拍组数</span><b>' + v.iterations + '</b></div>';
      if (v.tiers && v.tiers.length) html += '<div class="pp-kv"><span>规模档</span><b>' + v.tiers.join(' / ') + '</b></div>';
      html += '<div class="pp-kv"><span>暴力解标尺</span><b>' + (v.bruteFrozen ? '已冻结' : '未校准') + '</b></div>';
      if (v.scopeNote) {
        html += '<div class="pp-kv"><span>覆盖范围</span><b>' + MD.escapeHtml(String(v.scopeNote).slice(0, 220)) + '</b></div>';
      }
      if (v.solRollback) {
        html += '<div class="pp-ws-hint">⚠ 交付的是模型**第一版**题解：验证链中途改过它但没收敛，修改版已丢弃。</div>';
      }
      if (v.status === 'mismatch' || v.status === 'brute-failed') {
        html += '<div class="pp-ws-hint">教练正在根据反例修代码，修完会重新对拍。</div>';
      }
      if (v.status === 'unverified') {
        html += '<div class="pp-ws-hint">未能完全验证通过：讲解会如实说明。</div>';
      }
      if (v.status === 'multi-answer') {
        html += '<div class="pp-ws-hint">本题答案不唯一：题解与暴力解给出不同答案**不代表**谁错（本地没有 checker，判不了）。</div>';
      }
      if (v.status === 'degraded-brute') {
        html += '<div class="pp-ws-hint">题解被长度上限截断 → 交付的是暴力解（官方样例通过，未做随机对拍）。</div>';
      }
    } else if (files.length) {
      html += '<div class="pp-ws-hint">尚未对拍验证。</div>';
    }
    // 迭代轨迹（讲解"为什么这么写"的依据）
    const traj = ws.trajectory || [];
    if (traj.length) {
      html += '<div class="pp-sec-title" style="margin-top:10px">迭代轨迹</div>';
      traj.slice(-4).forEach(function (t) {
        html += '<div class="pp-ws-traj"><span class="pp-ws-traj-kind">' + MD.escapeHtml(t.kind || '') + '</span> '
          + MD.escapeHtml(String(t.note || '').slice(0, 90)) + '</div>';
      });
    }
    // 最小反例（教学素材）
    const mc = ws.minimalCase;
    if (mc && mc.input) {
      html += '<div class="pp-sec-title" style="margin-top:10px">最小反例'
        + (mc.from === 'user-vs-brute' ? '（你的代码）' : '') + '</div>'
        + '<pre class="pp-io">' + MD.escapeHtml(String(mc.input).slice(0, 400)) + '</pre>';
      if (mc.expected != null) html += '<div class="pp-io-label">正确输出</div><pre class="pp-io">' + MD.escapeHtml(String(mc.expected).slice(0, 200)) + '</pre>';
      if (mc.actual != null) html += '<div class="pp-io-label">错误输出</div><pre class="pp-io">' + MD.escapeHtml(String(mc.actual).slice(0, 200)) + '</pre>';
    }
    // 本轮花费（token 来自服务商 usage；费用按单价估算）
    const wsConv = state.conv;
    const lastMsg = wsConv && (wsConv.messages || []).slice().reverse()
      .find(function (m) { return m.role === 'assistant' && m.usage; });
    if (lastMsg && lastMsg.usage) {
      const u = lastMsg.usage;
      html += '<div class="pp-sec-title" style="margin-top:10px">本轮花费'
        + (u.estimated ? '（含估算）' : '') + '</div>'
        + '<div class="pp-kv"><span>模型调用</span><b>' + (u.calls || 1) + ' 次</b></div>'
        + '<div class="pp-kv"><span>输入 / 输出</span><b>' + MD.fmtCount(u.promptTokens) + ' / ' + MD.fmtCount(u.completionTokens) + ' tok</b></div>'
        + (u.cacheHitTokens != null
          ? '<div class="pp-kv"><span>其中缓存命中</span><b>' + MD.fmtCount(u.cacheHitTokens) + ' tok（按缓存价计）</b></div>'
          : '')
        + '<div class="pp-kv"><span>费用</span><b>' + (u.cost
          ? '≈ ¥' + (u.cost.amount >= 0.01 ? u.cost.amount.toFixed(2) : u.cost.amount.toFixed(4))
            + (u.cost.priceSource === 'builtin' ? '（参考价）' : '（自定义单价）')
            + (u.cost.cacheUnknown ? ' ⚠️ 未含缓存折扣' : '')
          : '未配置单价') + '</b></div>'
        + '<div class="form-hint" style="margin:-2px 0 6px">服务商返回缓存命中 token 时按缓存价计；'
        + '没返回时只能按全价输入估，**实际账单通常比这里低**（以官方账单为准）。</div>';
      const byRole = u.byRole || {};
      const rows = Object.keys(byRole).map(function (r) {
        return { role: r, g: byRole[r] };
      }).sort(function (a, b) { return (b.g.promptTokens + b.g.completionTokens) - (a.g.promptTokens + a.g.completionTokens); });
      if (rows.length) {
        html += '<details class="pp-trace"><summary>按 Agent 拆分</summary><div class="pp-trace-body">';
        rows.forEach(function (x) {
          html += '<div class="pp-trace-row"><span class="pp-trace-idx">·</span>'
            + '<span class="pp-trace-role">' + MD.escapeHtml(AGENT_ROLES[x.role] || x.role) + '</span>'
            + '<span class="pp-trace-meta">' + x.g.calls + ' 次 · ' + MD.fmtCount(x.g.promptTokens) + ' / '
            + MD.fmtCount(x.g.completionTokens) + ' tok' + (x.g.estimated ? '(估)' : '') + '</span></div>';
        });
        html += '</div></details>';
      }
    }
    // 决策轨迹（可折叠时间线）：一次讲解背后十几次模型调用，展开就能看到"为什么这么讲"
    const trace = ws.trace || [];
    if (trace.length) {
      const totalMs = trace.reduce(function (s, t) { return s + (t.ms || 0); }, 0);
      html += '<details class="pp-trace"><summary>🔍 决策轨迹 · ' + trace.length + ' 次调用 · '
        + (totalMs / 1000).toFixed(1) + 's</summary><div class="pp-trace-body">';
      trace.forEach(function (t, i) {
        const roleName = AGENT_ROLES[t.role] || t.role;
        html += '<div class="pp-trace-row">'
          + '<span class="pp-trace-idx">' + (i + 1) + '</span>'
          + '<span class="pp-trace-role">' + MD.escapeHtml(roleName) + '</span>'
          + (t.label ? '<span class="pp-trace-label">' + MD.escapeHtml(t.label) + '</span>' : '')
          + '<span class="pp-trace-meta">' + (t.ms || 0) + 'ms · 入' + (t.inChars || 0) + ' 出' + (t.outChars || 0)
          + (t.tokens ? ' · ' + MD.fmtCount(t.tokens.in) + '/' + MD.fmtCount(t.tokens.out) + ' tok'
            + (t.tokens.estimated ? '(估)' : '') : '') + '</span>'
          + '<span class="pp-trace-ok ' + (t.ok ? 'ok' : 'bad') + '">' + (t.ok ? '✓' : '✕') + '</span>'
          + '</div>';
        if (t.model) html += '<div class="pp-trace-model">' + MD.escapeHtml(t.model) + '</div>';
      });
      html += '</div></details>';
    }

    html += '<div class="pp-actions">'
      + '<button class="pp-btn" data-ws-clear>清空工作区</button>'
      + (ws.dir ? '<button class="pp-btn" data-ws-open>打开文件夹</button>' : '')
      + '</div>';
    html += '</div>';
    return html;
  }

  async function refreshWorkspace() {
    const conv = state.conv;
    if (!conv) { state.workspace = null; return; }
    try {
      state.workspace = await api('/api/workspace?convId=' + encodeURIComponent(conv.id));
    } catch (e) {
      state.workspace = null;
    }
  }

  function openWorkspaceFile(name) {
    api('/api/workspace/file?convId=' + encodeURIComponent(state.conv.id) + '&name=' + encodeURIComponent(name))
      .then(function (r) {
        openModal({
          title: name,
          size: 'lg',
          body: '<pre class="pp-code-view">' + MD.escapeHtml(r.content || '') + '</pre>',
          foot: '<button class="btn btn-default" data-modal-close>关闭</button> <button class="btn btn-primary" data-copy-code>复制代码</button>'
        });
        const root = document.querySelector('#modal-root');
        const copyBtn = root && root.querySelector('[data-copy-code]');
        if (copyBtn) {
          copyBtn.addEventListener('click', function () {
            navigator.clipboard.writeText(r.content || '').then(function () { toast('已复制', 'success', 1200); },
              function () { toast('复制失败', 'error'); });
          });
        }
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function renderProblemPanel() {
    const body = $('#pp-body');
    if (!body) return;
    const conv = state.conv;
    if (!conv) {
      body.innerHTML = '<div class="pp-empty">还没有打开题目<br><span>点「问一道题」开始</span></div>';
      return;
    }
    const meta = conv.problemMeta || {};
    const problem = conv.cfProblem;
    let html = '';
    // 题目卡
    html += '<div class="pp-card">';
    html += '<div class="pp-card-head">'
      + (meta.rating ? ratingBadgeHtml(meta.rating) : '<span class="rating-badge cf-gray">?</span>')
      + '<span class="pp-card-title">' + MD.escapeHtml(problem ? (problem.contestId + problem.index + '. ' + problem.title) : (meta.title || conv.title)) + '</span>'
      + '</div>';
    if (meta.summary) html += '<div class="pp-summary">' + MD.escapeHtml(meta.summary) + '</div>';
    if (meta.knowledge && meta.knowledge.length) {
      html += '<div class="pp-chips">' + meta.knowledge.map(function (k) { return '<span class="tag-chip hot">' + MD.escapeHtml(k) + '</span>'; }).join('') + '</div>';
    }
    if (meta.tags && meta.tags.length) {
      html += '<div class="pp-chips">' + meta.tags.slice(0, 6).map(function (t) { return '<span class="lib-tag">' + MD.escapeHtml(t) + '</span>'; }).join('') + '</div>';
    }
    html += '<div class="pp-actions">'
      + '<button class="pp-btn" data-pp-settings>这道题的设置</button>'
      + '<button class="pp-btn" data-pp-classify>' + (meta.knowledge && meta.knowledge.length ? '重新分类' : '立即分类') + '</button>'
      + (problem ? '<button class="pp-btn" data-pp-purge title="清掉本题的验证缓存（题解/暴力解/对拍结论），下次从零重新对拍">🔄 重新对拍</button>' : '')
      + (problem ? '<button class="pp-btn" data-pp-open title="用系统浏览器打开，便于复制题面">🌐</button>' : '')
      + '</div>';
    html += '</div>';

    // 验证工作区（对拍 harness 缓冲区）
    html += workspaceCardHtml();

    // 样例
    const samples = (conv.cfProblemSamples || []).filter(function (s) { return s.input != null; });
    if (samples.length) {
      html += '<div class="pp-card"><div class="pp-sec-title">官方样例 · ' + samples.length + ' 组</div>';
      samples.slice(0, 4).forEach(function (s, i) {
        html += '<details class="pp-sample"><summary>样例 ' + (i + 1) + '</summary>'
          + '<div class="pp-io-label">输入</div><pre class="pp-io">' + MD.escapeHtml(s.input) + '</pre>'
          + (s.output != null ? '<div class="pp-io-label">输出</div><pre class="pp-io">' + MD.escapeHtml(s.output) + '</pre>' : '')
          + '</details>';
      });
      html += '</div>';
    }

    // 课堂信息
    const msgs = conv.messages || [];
    const userMsgs = msgs.filter(function (m) { return m.role === 'user'; }).length;
    const assistant = msgs.filter(function (m) { return m.role === 'assistant'; });
    const lastUsage = assistant.length ? assistant[assistant.length - 1].usage : null;
    const lastAssistant = assistant.length ? assistant[assistant.length - 1] : null;
    html += '<div class="pp-card"><div class="pp-sec-title">本次记录</div>'
      + '<div class="pp-kv"><span>提问轮次</span><b>' + userMsgs + '</b></div>'
      + '<div class="pp-kv"><span>讲解语言</span><b>' + langName(conv.lang || (state.config && state.config.defaultCoachLang) || 'cpp') + '</b></div>'
      + '<div class="pp-kv"><span>提问意图</span><b>' + intentName(conv.intent) + '</b></div>'
      + '<div class="pp-kv"><span>讲解形式</span><b>' + (lastAssistant && lastAssistant.richDoc ? '图文文档' : '文字') + '</b></div>'
      + '<div class="pp-kv"><span>题目来源</span><b>' + (meta.source === 'cf' ? ('CF ' + MD.escapeHtml(String(meta.contest || ''))) : (meta.rating ? '手动题目' : '未分类')) + '</b></div>'
      + (meta.classifiedAt ? '<div class="pp-kv"><span>分类时间</span><b>' + MD.timeAgo(meta.classifiedAt) + '</b></div>' : '')
      + (lastUsage ? '<div class="pp-kv"><span>上次 token</span><b>' + ((lastUsage.promptTokens || 0) + (lastUsage.completionTokens || 0)) + '</b></div>' : '')
      + '</div>';
    body.innerHTML = html;
    renderAgentWorkbench();   // Agent 工作台独立于题目面板内容，跟随重渲染一起刷新

    body.querySelector('[data-pp-settings]').addEventListener('click', openConvSettings);
    $$('[data-ws-view]', body).forEach(function (btn) {
      btn.addEventListener('click', function () { openWorkspaceFile(btn.getAttribute('data-ws-view')); });
    });
    const wsClear = body.querySelector('[data-ws-clear]');
    if (wsClear) wsClear.addEventListener('click', async function () {
      const ok = await confirmModal({ title: '清空工作区', message: '将删除本题缓冲区的全部代码（题解、暴力、生成器、反例）。题目与对话记录不受影响。', okText: '清空', danger: true });
      if (!ok) return;
      try {
        await api('/api/workspace/clear', { method: 'POST', body: JSON.stringify({ convId: state.conv.id, keepAll: true }) });
        toast('工作区已清空', 'success');
        await refreshWorkspace();
        renderProblemPanel();
      } catch (e) { toast(e.message, 'error'); }
    });
    const wsOpen = body.querySelector('[data-ws-open]');
    if (wsOpen) wsOpen.addEventListener('click', function () {
      const dir = (state.workspace && state.workspace.dir) || '';
      if (!dir) return;
      if (window.chatbox && window.chatbox.openPath) window.chatbox.openPath(dir);
      else toast('工作区目录：' + dir, 'info', 4000);
    });
    const openBtn = body.querySelector('[data-pp-open]');
    if (openBtn) openBtn.addEventListener('click', function () {
      const url = 'https://codeforces.com/contest/' + problem.contestId + '/problem/' + problem.index;
      if (window.chatbox && window.chatbox.openExternal) window.chatbox.openExternal(url);
      else window.open(url, '_blank');
    });
    /**
     * 重新对拍：清掉本题的验证缓存（题解/暴力解/对拍结论与最小反例），下次从零跑一遍。
     * 想验证"完整验证链还正常吗"时点它 —— 不用再靠"删对话"这种副作用。
     */
    const purgeBtn = body.querySelector('[data-pp-purge]');
    if (purgeBtn) purgeBtn.addEventListener('click', async function () {
      const ok = await confirmModal({
        title: '重新对拍',
        message: '清掉这道题的验证缓存（已验证的题解/暴力解/数据生成器/对拍结论）？\n\n'
          + '清掉后，下次问这道题会**从零重新走一遍完整验证链**（会花几分钟）。对话记录不受影响。',
        okText: '清掉并重跑',
        danger: true
      });
      if (!ok) return;
      try {
        const r = await api('/api/workspace/purge', { method: 'POST', body: JSON.stringify({ convId: state.conv.id }) });
        toast(r && r.removed ? '已清掉本题缓存：下次问这道题会重新对拍' : '本题还没有缓存可清', 'success', 4000);
        state.workspace = null;
        renderProblemPanel();
      } catch (e) { toast('清理失败：' + e.message, 'error'); }
    });
    body.querySelector('[data-pp-classify]').addEventListener('click', async function () {
      const btn = body.querySelector('[data-pp-classify]');
      btn.disabled = true;
      btn.textContent = '分类中…';
      try {
        const r = await api('/api/conversations/' + conv.id + '/classify', { method: 'POST', body: '{}' });
        conv.problemMeta = r.problemMeta;
        renderProblemPanel();
        refreshList();
        toast('题目已分类', 'success');
      } catch (e) {
        toast('分类失败：' + e.message, 'error');
        btn.disabled = false;
      }
    });
  }

  function parseCfRef(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    // 支持 URL：/problemset/problem/1800/C 或 /contest/1800/problem/C
    const m1 = s.match(/problemset\/problem\/(\d+)\/([A-Za-z][0-9]?)/);
    if (m1) return { contestId: m1[1], index: m1[2].toUpperCase() };
    const m2 = s.match(/contest\/(\d+)\/problem\/([A-Za-z][0-9]?)/);
    if (m2) return { contestId: m2[1], index: m2[2].toUpperCase() };
    // 支持 "1800C"、"1800 C"、"1800-C"、"C 1800"
    const m3 = s.match(/^(\d{2,5})\s*[- ]?\s*([A-Za-z][0-9]?)$/);
    if (m3) return { contestId: m3[1], index: m3[2].toUpperCase() };
    const m4 = s.match(/^([A-Za-z][0-9]?)\s*[- ]?\s*(\d{2,5})$/);
    if (m4) return { contestId: m4[2], index: m4[1].toUpperCase() };
    return null;
  }

  function formatStatementForInput(p) {
    const parts = [];
    parts.push('【Codeforces ' + p.contestId + p.index + '】' + p.title);
    if (p.rating) parts.push('难度：' + p.rating + ' 分' + (p.tags && p.tags.length ? ' · 标签：' + p.tags.join(', ') : ''));
    if (p.timeLimit || p.memoryLimit) parts.push('时限：' + p.timeLimit + ' · 内存：' + p.memoryLimit);
    parts.push('');
    parts.push(p.statement);
    if (p.samples && p.samples.length) {
      parts.push('');
      parts.push('样例：');
      p.samples.forEach(function (s, i) {
        if (s.input == null) return;
        parts.push('输入 ' + (i + 1) + '：\n' + s.input.trimEnd());
        if (s.output != null) parts.push('输出 ' + (i + 1) + '：\n' + s.output.trimEnd());
      });
    }
    return parts.join('\n');
  }

  async function openCfImport() {
    const conv = state.conv;
    if (!conv) {
      toast('请先新建或选择一个对话', 'error');
      return;
    }
    const ref = await promptModal({
      title: '从 Codeforces 获取题面',
      label: '题目编号或链接（如 1800C、1800 C、https://codeforces.com/problemset/problem/1800/C）',
      placeholder: '1800C'
    });
    if (ref == null) return;
    const parsed = parseCfRef(ref);
    if (!parsed) {
      toast('无法识别题目编号，示例：1800C 或题目链接', 'error');
      return;
    }
    toast('正在从 Codeforces 获取题面…', 'info', 2000);
    try {
      const p = await api('/api/cf/problem?contestId=' + encodeURIComponent(parsed.contestId) + '&index=' + encodeURIComponent(parsed.index));
      await patchConv(conv.id, {
        mode: 'coach',
        cfProblem: { contestId: p.contestId, index: p.index, title: p.title },
        problemMeta: {
          rating: p.rating || null, tags: p.tags || [], contest: String(p.contestId),
          source: 'cf', title: p.title, knowledge: (conv.problemMeta && conv.problemMeta.knowledge) || []
        }
      });
      const input = $('#input');
      input.value = formatStatementForInput(p);
      if (p.warnings && p.warnings.length) {
        // 题面可能被截断/缺样例：明确提示，避免拿着半道题让模型硬讲
        input.value = '（⚠ 题面抓取可能不完整：' + p.warnings.join('；') + '　—— 可核对后手动补全）\n' + input.value;
        toast('题面可能不完整：' + p.warnings.join('；'), 'error', 9000);
      }
      autosizeInput();
      updateComposer();
      renderHeader();
      renderProblemPanel();
      focusInput();
      if (!(p.warnings && p.warnings.length)) {
        toast('已获取「' + p.title + '」，题面已填入输入框，直接发送即可（我会自动对拍验证后讲解）', 'success', 3200);
      }
    } catch (e) {
      /**
       * 抓取失败时**说准原因**。
       *
       * 真实事故：用户查 2269D（而 2269 只有 A/B 两题），界面上一律显示
       * "题面被 Codeforces 反爬拦截" —— 于是他以为是 CF 封了应用，去折腾代理和登录，
       * 而真正的原因是题号不存在。这里按服务端给的原因分类：
       *   · 题号/比赛不存在 → 直接说清楚，并给出该比赛的正确题号（不让他粘贴题面白忙）
       *   · 反爬拦截 → 才走"粘贴题面"这条路
       */
      const msg = String((e && e.message) || '');
      const notFound = /没有题号|公开题表里没有|不存在|不可见/.test(msg);
      const antiBot = /反爬|拦截|Cloudflare|挑战/.test(msg) && !notFound;
      const pageUrl = 'https://codeforces.com/contest/' + parsed.contestId + '/problem/' + parsed.index;
      let metaKnown = false;
      try {
        const m = await api('/api/cf/meta?contestId=' + encodeURIComponent(parsed.contestId) + '&index=' + encodeURIComponent(parsed.index));
        // 元数据兜底也查不到题目（服务端明说 notFound）时，不要伪造"题目已登记"
        metaKnown = !!(m && !m.notFound && (m.rating || (m.tags && m.tags.length) || /^[A-Z]\d?\.\s/.test(String(m.title || ''))));
        if (metaKnown) {
          await patchConv(conv.id, {
            mode: 'coach',
            cfProblem: { contestId: m.contestId, index: m.index, title: m.title },
            problemMeta: {
              rating: m.rating || null, tags: m.tags || [], contest: String(m.contestId),
              source: 'cf', title: m.title, knowledge: []
            }
          });
          renderHeader();
          renderProblemPanel();
        }
      } catch (e2) { /* 元数据只是增强 */ }

      /**
       * 取不到题面时**开一个明确的对话框**，把原因和出路摆出来。
       *
       * 为什么不再"偷偷往输入框塞一句模板"：那样用户看到的是**一个没变化的空对话框**，
       * 既看不到题面、也看不到原因（原因只在一闪而过的 toast 里）——真实反馈就是
       * "扒题面之后对话框还是原样，导致我无法看到粘贴的题面信息"。
       * 现在：说清是哪一类失败，并让用户自己选择"去浏览器看"还是"我自己粘贴题面"。
       */
      const dlg = openModal({
        title: notFound ? '没有这道题' : (antiBot ? '题面被反爬拦截' : '题面没能取到'),
        size: 'sm',
        body: '<p style="font-size:13.5px;color:var(--text-secondary);line-height:1.7;margin:0 0 10px">'
            + MD.escapeHtml(msg || '未知原因') + '</p>'
          + (metaKnown ? '<p style="font-size:12.5px;color:var(--text-tertiary);margin:0">题目难度与标签已登记，仍然可用。</p>' : ''),
        foot: '<button class="btn btn-default" data-cf-open>在浏览器打开这道题</button>'
          + '<button class="btn btn-primary" data-cf-paste>我自己粘贴题面</button>'
      });
      dlg.modal.querySelector('[data-cf-open]').addEventListener('click', function () {
        dlg.close();
        if (window.chatbox && window.chatbox.openExternal) window.chatbox.openExternal(pageUrl);
        else window.open(pageUrl, '_blank');
      });
      dlg.modal.querySelector('[data-cf-paste]').addEventListener('click', function () {
        dlg.close();
        const input = $('#input');
        input.value = '【Codeforces ' + parsed.contestId + parsed.index + '】\n'
          + '（题面没取到，下面粘贴题面正文 ↓）\n\n';
        autosizeInput();
        updateComposer();
        focusInput();
      });
    }
  }

  /* ---------------- 模型选择菜单 ---------------- */

  function openModelMenu(anchor) {
    const providers = state.config.providers || [];
    if (!providers.length) {
      // 未配置任何模型服务：引导去设置添加
      openSettings('providers');
      toast('请先添加模型服务', 'info');
      return;
    }
    if (!state.conv) {
      // 还没打开会话：自动新建一个，再继续选择模型
      toast('已为你新建对话', 'info', 1500);
      createConversation().then(function () {
        openModelMenu(anchor);
      }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    const conv = state.conv;
    const items = [];
    items.push({ label: '__note__', note: '选择模型（保存到当前会话）' });
    providers.forEach(function (p) {
      const models = (p.models && p.models.length) ? p.models : [];
      items.push({
        html: '<div class="model-menu-group">' + MD.escapeHtml(p.name) + '</div>'
      });
      if (!models.length) {
        items.push({
          html: '<button class="model-menu-item" data-empty-provider="' + p.id + '">'
            + '<span style="color:var(--text-tertiary);font-size:12px">未配置模型列表 → 去设置</span></button>'
        });
      }
      models.forEach(function (mname) {
        const selected = conv.providerId === p.id && conv.model === mname;
        items.push({
          html: '<button class="model-menu-item' + (selected ? ' selected' : '') + '" data-model-pick="' + p.id + '|' + mname.replace(/"/g, '&quot;') + '">'
            + icon('model', 14)
            + '<span>' + MD.escapeHtml(mname) + '</span>'
            + (selected ? '<span class="check">' + icon('check', 14) + '</span>' : '')
            + '</button>'
        });
      });
    });
    items.push('-');
    items.push({ label: '手动输入模型名…', icon: 'edit', onClick: function () { openCustomModelPrompt(conv); } });
    items.push({
      label: '刷新模型列表（从服务商拉取）',
      icon: 'refresh',
      onClick: function () { refreshProviderModels(conv); }
    });
    items.push({ label: '模型服务设置…', icon: 'menu', onClick: function () { openSettings('providers'); } });
    const pop = openMenu(anchor, items, { cls: 'model-menu' });
    $$('[data-model-pick]', pop).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const parts = btn.getAttribute('data-model-pick').split('|');
        const pid = parts[0], mname = parts.slice(1).join('|');
        await patchConv(conv.id, { providerId: pid, model: mname });
        renderHeader();
        refreshList();
        toast('模型已切换：' + providerName(pid) + ' · ' + mname, 'success', 1600);
      });
    });
    $$('[data-empty-provider]', pop).forEach(function (btn) {
      btn.addEventListener('click', function () {
        closeMenu();
        openSettings('providers');
      });
    });
  }

  /** 手动输入模型名：服务商列表里没有的名字（新别名/版本号）可以直接用 */
  async function openCustomModelPrompt(conv) {
    const cur = conv.model || '';
    const name = await promptModal({
      title: '手动输入模型名',
      label: '模型名（服务商 API 支持的名称，可在「刷新模型列表」里查看）',
      placeholder: 'deepseek-flash',
      value: cur
    });
    if (name == null) return;
    const mname = String(name).trim();
    if (!mname) return;
    await patchConv(conv.id, { model: mname });
    renderHeader();
    refreshList();
    toast('模型已设置为 ' + mname + '（若服务商不支持该名称，发送时会返回错误提示）', 'success', 2600);
  }

  /** 从服务商拉取实时模型列表并写回配置（解决「列表是旧的」问题） */
  async function refreshProviderModels(conv) {
    const pid = conv.providerId || (state.config.defaultProviderId || '');
    const p = providerById(pid);
    if (!p) { openSettings('providers'); return; }
    toast('正在从 ' + p.name + ' 拉取模型列表…', 'info', 1800);
    try {
      const r = await api('/api/providers/' + p.id + '/models');
      const models = (r && r.models) || [];
      if (!models.length) { toast('服务商没有返回任何模型', 'error'); return; }
      const merged = Array.from(new Set([].concat(p.models || [], models)));
      const cfg = Object.assign({}, state.config, {
        providers: state.config.providers.map(function (x) {
          return x.id === p.id ? Object.assign({}, x, { models: merged }) : x;
        })
      });
      await api('/api/config', { method: 'POST', body: JSON.stringify(cfg) });
      state.config = await api('/api/config');
      toast('模型列表已更新：' + models.length + ' 个（新增 ' + Math.max(0, merged.length - (p.models || []).length) + ' 个）', 'success', 2600);
      openModelMenu($('#btn-model-select'));
    } catch (e) {
      toast('拉取失败：' + e.message, 'error', 4000);
    }
  }

  /* ---------------- 会话设置弹窗 ---------------- */

  /** 这道题的设置 —— 独立整页（不再是弹窗） */
  function renderConvSettingsPage() {
    const root = $('#page-conv-settings');
    if (!root) return;
    const box = root.querySelector('[data-conv-settings-page]');
    const conv = state.conv;
    if (!conv) {
      box.innerHTML = pageHead('🗂 这道题的设置', '还没有打开题目') + '<div class="profile-empty">请先点「问一道题」。</div>';
      return;
    }
    const cfg = state.config;
    const providers = cfg.providers || [];
    const pOptions = providers.map(function (x) {
      return '<option value="' + x.id + '"' + (conv.providerId === x.id ? ' selected' : '') + '>'
        + MD.escapeHtml(x.name) + '</option>';
    }).join('');
    const models = (providerById(conv.providerId) && providerById(conv.providerId).models || []);
    const intent = INTENT_NAMES[conv.intent] ? conv.intent : 'full';

    box.innerHTML = '<div class="page-head">'
      + '<div><div class="page-title">🗂 这道题的设置</div>'
      + '<div class="page-sub">' + MD.escapeHtml(conv.title) + ' · 模型 / 讲解语言 / 提问意图</div></div>'
      + '<button class="btn btn-default" data-page-back>← 返回</button>'
      + '</div>'
      + '<div class="settings-grid">'
      + '<div class="form-group"><label class="form-label">模型服务</label>'
      + '<select class="form-select" data-cs-provider>' + pOptions + '</select>'
      + (providers.length ? '' : '<div class="form-hint">还没有模型服务，请先到「设置 → 模型服务」添加</div>') + '</div>'
      + '<div class="form-group"><label class="form-label">模型</label>'
      + '<input class="form-input" data-cs-model list="cs-models" value="' + MD.escapeHtml(conv.model || '') + '" placeholder="模型名，如 deepseek-chat">'
      + '<datalist id="cs-models">' + models.map(function (x) { return '<option value="' + MD.escapeHtml(x) + '">'; }).join('') + '</datalist>'
      + '<div class="form-hint">留空则使用全局默认模型</div></div>'
      + '<div class="form-group"><label class="form-label">讲解语言（代码与逐行讲解的语言）</label>'
      + '<select class="form-select" data-cs-lang>'
      + '<option value="cpp"' + ((conv.lang || cfg.defaultCoachLang || 'cpp') === 'cpp' ? ' selected' : '') + '>C++23</option>'
      + '<option value="python"' + ((conv.lang || cfg.defaultCoachLang || 'cpp') === 'python' ? ' selected' : '') + '>Python 3</option>'
      + '</select></div>'
      + '<div class="form-group span-all"><label class="form-label">提问意图（教练据此控制输出详略）</label>'
      + '<div class="radio-line intent-pills">'
      + Object.keys(INTENT_NAMES).map(function (k) {
        return '<button class="radio-pill intent-pill' + (intent === k ? ' active' : '') + '" data-cs-intent-pick="' + k + '">'
          + intentIcon(k, 13) + ' ' + INTENT_NAMES[k] + '</button>';
      }).join('')
      + '</div><div class="form-hint" data-cs-intent-hint>' + MD.escapeHtml(intentHintText(intent)) + '</div></div>'
      + '<div class="form-group span-all"><label class="form-label">讲解形式</label>'
      + '<div class="form-hint">完整讲解 / 代码评估 → **图文文档**（HTML + SVG 图解 + 交互演示，'
      + '在下方以互动文档呈现）；思路提示 / 题干解读 → 轻量文字。这是自动的，不需要开关。</div></div>'
      + '</div>'
      + '<div style="text-align:right;padding:10px 0"><button class="btn btn-primary" data-cs-save>保存设置</button></div>';

    box.querySelector('[data-page-back]').addEventListener('click', goBack);
    let intentChoice = intent;
    $$('[data-cs-intent-pick]', box).forEach(function (btn) {
      btn.addEventListener('click', function () {
        intentChoice = btn.getAttribute('data-cs-intent-pick');
        $$('[data-cs-intent-pick]', box).forEach(function (b) { b.classList.toggle('active', b === btn); });
        const hint = box.querySelector('[data-cs-intent-hint]');
        if (hint) hint.textContent = intentHintText(intentChoice);
      });
    });
    box.querySelector('[data-cs-provider]').addEventListener('change', function () {
      const mods = (providerById(this.value) && providerById(this.value).models || []);
      box.querySelector('#cs-models').innerHTML = mods.map(function (x) {
        return '<option value="' + MD.escapeHtml(x) + '">';
      }).join('');
    });
    box.querySelector('[data-cs-save]').addEventListener('click', async function () {
      try {
        await patchConv(conv.id, {
          providerId: box.querySelector('[data-cs-provider]').value || '',
          model: box.querySelector('[data-cs-model]').value.trim(),
          lang: box.querySelector('[data-cs-lang]').value,
          intent: intentChoice
        });
        updateComposer();
        refreshList();
        renderProblemPanel();
        toast('设置已保存', 'success');
        switchView('coach');
      } catch (e) {
        toast('保存失败：' + e.message, 'error');
      }
    });
  }

  function openConvSettings() { switchView('conv-settings'); }

  /** 统一的页面标题块 */
  function pageHead(title, sub, withBack) {
    return '<div class="page-head"><div><div class="page-title">' + title + '</div>'
      + '<div class="page-sub">' + (sub || '') + '</div></div>'
      + (withBack === false ? '' : '<button class="btn btn-default" data-page-back>← 返回</button>') + '</div>';
  }

  /* ---------------- 学员信息卡 ---------------- */

  function ratingColorClass(rating) {
    if (!rating || rating < 1200) return 'cf-gray';
    if (rating < 1400) return 'cf-green';
    if (rating < 1600) return 'cf-cyan';
    if (rating < 1900) return 'cf-blue';
    if (rating < 2100) return 'cf-violet';
    if (rating < 2400) return 'cf-orange';
    return 'cf-red';
  }

  function tagChipsHtml(tags) {
    if (!tags || !tags.length) return '<span class="form-hint">暂无数据</span>';
    const max = Math.max.apply(null, tags.map(function (t) { return t.count; })) || 1;
    return tags.slice(0, 10).map(function (t) {
      const level = t.count / max >= 0.6 ? ' hot' : '';
      return '<span class="tag-chip' + level + '">' + MD.escapeHtml(t.tag) + '<em>' + t.count + '</em></span>';
    }).join('');
  }

  function profileCardHtml(p) {
    const card = p.card;
    const stats = p.stats;
    const handle = (card && card.cfHandle) || (stats && stats.handle) || '';
    const rating = (card && card.rating) || (p.user && p.user.rating) || 0;
    const rc = ratingColorClass(rating);
    let html = '';
    if (!card && !stats) {
      html += '<div class="profile-empty">还没有学员信息卡。<br>在「设置 → 通用」填写 Codeforces 用户名后，教练会在每次讲解后自动生成；也可以点下方「立即生成」。</div>';
    } else {
      html += '<div class="profile-head">'
        + '<div class="profile-handle">' + MD.escapeHtml(handle || '—') + '</div>'
        + '<div class="profile-rating ' + rc + '">' + (rating || '?') + '</div>'
        + '<div class="profile-rank">' + MD.escapeHtml((card && card.rank) || (p.user && p.user.rank) || '') + '</div>'
        + '</div>';
      html += '<div class="profile-stats">'
        + '<div class="profile-stat"><div class="profile-stat-num">' + ((stats && stats.solvedCount) || (card && card.solvedCount) || 0) + '</div><div class="profile-stat-label">AC 题目（近千次提交）</div></div>'
        + '<div class="profile-stat"><div class="profile-stat-num">' + ((stats && stats.avgSolvedRating) || (card && card.avgSolvedRating) || 0) + '</div><div class="profile-stat-label">平均题目难度</div></div>'
        + '<div class="profile-stat"><div class="profile-stat-num">' + (card && card.updatedAt ? MD.timeAgo(card.updatedAt) : '—') + '</div><div class="profile-stat-label">上次更新</div></div>'
        + '</div>';
      html += '<div class="profile-section"><div class="profile-section-title">高频标签</div><div class="profile-tags">' + tagChipsHtml((stats && stats.topTags) || (card && card.topTags)) + '</div></div>';
      const list = function (items, cls) {
        return (items && items.length)
          ? '<div class="profile-list ' + cls + '">' + items.map(function (x) { return '<span class="profile-pill">' + MD.escapeHtml(x) + '</span>'; }).join('') + '</div>'
          : '<div class="form-hint">暂无</div>';
      };
      html += '<div class="profile-section"><div class="profile-section-title">💪 优势</div>' + list(card && card.strengths, 'good') + '</div>';
      html += '<div class="profile-section"><div class="profile-section-title">🎯 薄弱点</div>' + list(card && card.weaknesses, 'bad') + '</div>';
      html += '<div class="profile-section"><div class="profile-section-title">🧭 讲解重点</div>' + list(card && card.focus, 'focus') + '</div>';
      if (card && card.profileText) {
        html += '<div class="profile-section"><div class="profile-section-title">综合画像</div><div class="profile-text">' + MD.escapeHtml(card.profileText) + '</div></div>';
      }
    }
    return html;
  }

  /** 信息卡编辑：在「我的」页面内就地编辑（不再弹窗） */
  function profileEditFormHtml(card) {
    return '<div class="settings-grid">'
      + '<div class="form-group span-all"><label class="form-label">综合画像</label>'
      + '<textarea class="form-textarea" data-pe-text rows="3" placeholder="2-4 句学习画像">' + MD.escapeHtml(card.profileText || '') + '</textarea></div>'
      + '<div class="form-group"><label class="form-label">优势（每行一条）</label>'
      + '<textarea class="form-textarea" data-pe-strengths rows="4">' + MD.escapeHtml((card.strengths || []).join('\n')) + '</textarea></div>'
      + '<div class="form-group"><label class="form-label">薄弱点（每行一条）</label>'
      + '<textarea class="form-textarea" data-pe-weaknesses rows="4">' + MD.escapeHtml((card.weaknesses || []).join('\n')) + '</textarea></div>'
      + '<div class="form-group"><label class="form-label">讲解重点建议（每行一条）</label>'
      + '<textarea class="form-textarea" data-pe-focus rows="4">' + MD.escapeHtml((card.focus || []).join('\n')) + '</textarea></div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;padding:12px 0">'
      + '<button class="btn btn-default" data-prof-cancel>取消</button>'
      + '<button class="btn btn-primary" data-pe-save>保存信息卡</button>'
      + '</div>';
  }

  /* ---------------- 页面：题目库 / 我的 / 设置（独立页面） ---------------- */

  function ratingBadgeHtml(rating, extra) {
    if (rating == null) return '<span class="rating-badge cf-gray">?</span>';
    return '<span class="rating-badge ' + ratingColorClass(rating) + '">' + rating + (extra || '') + '</span>';
  }

  function libFilteredConvs() {
    const f = state.libFilter;
    return state.convs.filter(function (c) {
      if (c.archived) return false;
      const m = c.problemMeta;
      if (!m) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        const hay = ((m.title || '') + ' ' + c.title + ' ' + (m.summary || '') + ' ' + (m.knowledge || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (f.knowledge && !(m.knowledge || []).includes(f.knowledge)) return false;
      if (f.contest && String(m.contest || '') !== f.contest) return false;
      if (f.rating) {
        const parts = f.rating.split('-').map(Number);
        const r = m.rating || 0;
        if (r < parts[0] || r >= parts[1]) return false;
      }
      return true;
    }).sort(function (a, b) { return (b.problemMeta && b.problemMeta.classifiedAt || b.updatedAt) - (a.problemMeta && a.problemMeta.classifiedAt || a.updatedAt); });
  }

  function renderLibraryPage() {
    const root = $('#page-library');
    if (!root) return;
    // 汇总可选项
    const knowledge = new Set();
    const contests = new Map();
    state.convs.forEach(function (c) {
      const m = c.problemMeta;
      if (!m) return;
      (m.knowledge || []).forEach(function (k) { knowledge.add(k); });
      if (m.contest) {
        const key = String(m.contest);
        contests.set(key, (contests.get(key) || 0) + 1);
      }
    });
    const kSel = root.querySelector('[data-lib-knowledge]');
    const curK = state.libFilter.knowledge;
    kSel.innerHTML = '<option value="">全部知识点</option>' + [...knowledge].sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); })
      .map(function (k) { return '<option value="' + MD.escapeHtml(k) + '"' + (curK === k ? ' selected' : '') + '>' + MD.escapeHtml(k) + '</option>'; }).join('');
    const cSel = root.querySelector('[data-lib-contest]');
    const curC = state.libFilter.contest;
    cSel.innerHTML = '<option value="">全部比赛</option>' + [...contests.keys()].sort(function (a, b) { return a.localeCompare(b); })
      .map(function (k) { return '<option value="' + k + '"' + (curC === k ? ' selected' : '') + '>CF ' + k + '（' + contests.get(k) + ' 题）</option>'; }).join('');

    const list = libFilteredConvs();
    const listEl = root.querySelector('[data-lib-list]');
    if (!list.length) {
      listEl.innerHTML = '<div class="profile-empty">还没有已分类的题目。<br>问过题目后，教练会自动标注难度、知识点与一句话摘要。</div>';
      return;
    }
    listEl.innerHTML = '<div class="lib-grid">' + list.map(function (c) {
      const m = c.problemMeta;
      return '<div class="lib-card" data-lib-open="' + c.id + '">'
        + ratingBadgeHtml(m.rating)
        + '<div class="lib-card-main">'
        + '<div class="lib-card-title">' + MD.escapeHtml(m.title || c.title) + '</div>'
        + '<div class="lib-card-summary">' + MD.escapeHtml(m.summary || c.preview || '') + '</div>'
        + '<div class="lib-card-tags">'
        + (m.knowledge || []).map(function (k) { return '<span class="tag-chip">' + MD.escapeHtml(k) + '</span>'; }).join('')
        + (m.tags || []).slice(0, 4).map(function (t) { return '<span class="lib-tag">' + MD.escapeHtml(t) + '</span>'; }).join('')
        + (m.source === 'cf' ? '<span class="lib-tag cf">CF ' + m.contest + '</span>' : '<span class="lib-tag">手动题目</span>')
        + '</div></div>'
        + '<div class="lib-card-time">' + MD.timeAgo(c.updatedAt) + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  function ratingChartSvg(history, width, height) {
    if (!history || history.length < 2) return '<div class="form-hint" style="padding:20px 0">暂无 rating 变化记录</div>';
    width = width || 720; height = height || 220;
    const pad = { l: 46, r: 14, t: 16, b: 26 };
    const vals = history.map(function (h) { return h.newRating; });
    const min = Math.min.apply(null, vals) - 60;
    const max = Math.max.apply(null, vals) + 60;
    const x = function (i) { return pad.l + (width - pad.l - pad.r) * (i / (history.length - 1)); };
    const y = function (v) { return pad.t + (height - pad.t - pad.b) * (1 - (v - min) / (max - min)); };
    const pts = history.map(function (h, i) { return x(i).toFixed(1) + ',' + y(h.newRating).toFixed(1); }).join(' ');
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const v = min + (max - min) * (g / 4);
      const gy = y(v);
      grid += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (width - pad.r) + '" y2="' + gy + '" class="chart-grid"/>'
        + '<text x="' + (pad.l - 8) + '" y="' + (gy + 4) + '" class="chart-label">' + Math.round(v) + '</text>';
    }
    const dots = history.map(function (h, i) {
      const delta = h.newRating - h.oldRating;
      const when = h.ratingUpdatedAt ? new Date(h.ratingUpdatedAt).toLocaleDateString('zh-CN') : '';
      const tip = (h.contestName || ('Contest ' + h.contestId)) + ' · ' + when + ' · '
        + h.oldRating + ' → ' + h.newRating + '（' + (delta >= 0 ? '+' : '') + delta + '）· 排名 ' + h.rank;
      return '<circle cx="' + x(i) + '" cy="' + y(h.newRating) + '" r="4" class="chart-dot ' + ratingColorClass(h.newRating)
        + '" data-tip="' + MD.escapeHtml(tip) + '"></circle>';
    }).join('');
    return '<svg class="rating-chart" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">'
      + grid
      + '<polyline points="' + pts + '" class="chart-line"/>'
      + dots
      + '</svg>';
  }

  async function renderProfilePage(opts) {
    const root = $('#page-profile');
    const box = root.querySelector('[data-profile-page]');
    const force = !!(opts && opts.force);
    let p = state.profileData;
    if (!p || force) {
      if (!p) box.innerHTML = '<div class="form-hint" style="padding:20px 0">加载中…</div>';
      try {
        p = await api('/api/profile');
        state.profileData = p;
      } catch (e) {
        box.innerHTML = '<div class="profile-empty">加载失败：' + MD.escapeHtml(e.message) + '</div>';
        return;
      }
    }
    renderProfileBody(box, p);
    // 服务端只返回本地 + 缓存数据（秒开），远端 CF 数据在这里异步补齐
    if (p && p.pending && state.view === 'profile') hydrateProfile();
  }

  /** 后台补齐 CF 远端数据（rating 曲线 / AC 统计 / 账号信息），失败只降级提示、绝不阻塞页面 */
  async function hydrateProfile() {
    const cur0 = state.profileData;
    if (!cur0 || !cur0.handle || state.profileHydrating) return;
    state.profileHydrating = true;
    const handle = cur0.handle;
    const enc = encodeURIComponent(handle);
    const got = await Promise.all([
      api('/api/cf/user?handle=' + enc).catch(function () { return null; }),
      api('/api/cf/stats?handle=' + enc).catch(function () { return null; }),
      api('/api/cf/rating?handle=' + enc).catch(function () { return null; })
    ]);
    state.profileHydrating = false;
    const cur = state.profileData;
    if (!cur || cur.handle !== handle) return;
    if (got[0]) cur.user = got[0];
    if (got[1]) cur.stats = got[1];
    if (got[2] && got[2].history) cur.ratingHistory = got[2].history;
    cur.pending = false;
    cur.remoteFailed = !got[0];
    if (state.view === 'profile' && !state.profileEditing) {
      renderProfileBody($('#page-profile').querySelector('[data-profile-page]'), cur);
    }
  }

  /** 渲染「我的」页正文（纯渲染 + 事件绑定） */
  function renderProfileBody(box, p) {
    const card = p.card;
    const user = p.user;
    const stats = p.stats;
    const handle = p.handle || (user && user.handle) || (card && card.cfHandle) || '';
    const ratingHistory = p.ratingHistory || [];
    const rc = ratingColorClass((user && user.rating) || (card && card.rating) || 0);
    const accHint = user
      ? ('当前 ' + user.rating + '（' + user.rank + '）· 历史最高 ' + user.maxRating + '（' + user.maxRank + '）')
        + (user.fromCard ? ' · 本地记录' : '')
      : (handle
        ? (p.pending ? '正在获取 Codeforces 数据…'
          : '暂时无法连接 Codeforces（网络受限或无代理），以上为本地记录。可在设置中配置代理后点「立即更新」。')
        : '在设置页填写 Codeforces 用户名');
    let html = '<div class="page-head"><div><div class="page-title">👤 我的</div>'
      + '<div class="page-sub">CF 账号 · rating 曲线 · 训练统计 · 学员信息卡</div></div></div>';
    html += '<div class="profile-grid"><div class="profile-col">';

    // 账号卡
    html += '<div class="acc-card">'
      + '<div class="acc-avatar">' + MD.escapeHtml((handle || '?').slice(0, 1).toUpperCase()) + '</div>'
      + '<div class="acc-main">'
      + '<div class="acc-handle">' + MD.escapeHtml(handle || '未设置 CF 账号') + '</div>'
      + '<div class="acc-meta">' + MD.escapeHtml(accHint) + '</div>'
      + '</div>'
      + (user && user.rating ? '<div class="acc-rating ' + rc + '">' + user.rating + '</div>' : '')
      + '</div>';

    // rating 曲线
    html += '<div class="profile-block-card"><div class="profile-section-title">📈 近期 rating'
      + (ratingHistory.length ? ' <span class="profile-updated">' + ratingHistory.length + ' 场</span>' : '')
      + '</div>' + ratingChartSvg(ratingHistory) + '</div>';

    // 训练统计
    html += '<div class="profile-block-card"><div class="profile-section-title">🏋️ 训练统计</div><div class="profile-stats">'
      + '<div class="profile-stat"><div class="profile-stat-num">' + ((stats && stats.solvedCount) || (card && card.solvedCount) || 0) + '</div><div class="profile-stat-label">AC 题目</div></div>'
      + '<div class="profile-stat"><div class="profile-stat-num">' + ((stats && stats.avgSolvedRating) || (card && card.avgSolvedRating) || 0) + '</div><div class="profile-stat-label">平均难度</div></div>'
      + '<div class="profile-stat"><div class="profile-stat-num">' + ((state.convs || []).filter(function (c) { return c.problemMeta; }).length) + '</div><div class="profile-stat-label">已问题目</div></div>'
      + '</div>'
      + '<div class="profile-section"><div class="profile-section-title">高频标签</div><div class="profile-tags">' + tagChipsHtml((stats && stats.topTags) || (card && card.topTags)) + '</div></div>'
      + '</div>';

    // 信息卡（右列）
    html += '</div><div class="profile-col">';
    html += '<div class="profile-block-card"><div class="profile-section-title">🧠 学员信息卡'
      + (card && card.updatedAt ? ' <span class="profile-updated">更新于 ' + MD.timeAgo(card.updatedAt) + '</span>' : '')
      + '</div>';
    if (card && (card.profileText || card.strengths)) {
      const list = function (items, cls) {
        return (items && items.length)
          ? '<div class="profile-list ' + cls + '">' + items.map(function (x) { return '<span class="profile-pill">' + MD.escapeHtml(x) + '</span>'; }).join('') + '</div>'
          : '<div class="form-hint">暂无</div>';
      };
      html += '<div class="profile-section"><div class="profile-section-title">💪 优势</div>' + list(card.strengths, 'good') + '</div>';
      html += '<div class="profile-section"><div class="profile-section-title">🎯 薄弱点</div>' + list(card.weaknesses, 'bad') + '</div>';
      html += '<div class="profile-section"><div class="profile-section-title">🧭 讲解重点</div>' + list(card.focus, 'focus') + '</div>';
      if (card.profileText) html += '<div class="profile-section"><div class="profile-section-title">综合画像</div><div class="profile-text">' + MD.escapeHtml(card.profileText) + '</div></div>';
    } else {
      html += '<div class="profile-empty">还没有学员信息卡。<br>在设置页填写 Codeforces 用户名后，教练会在每次讲解后自动生成；也可以点下方「立即更新」。</div>';
    }
    html += '</div></div></div>';   // 信息卡卡 + 右列 + 栅格

    html += '<div class="page-actions">'
      + '<button class="btn btn-default" data-prof-edit>' + (state.profileEditing ? '取消编辑' : '手动编辑') + '</button>'
      + '<button class="btn btn-primary" data-prof-refresh>立即更新</button>'
      + '</div>';

    // 页面整体：左列（账号 / 曲线 / 统计） + 右列（信息卡，可就地编辑）
    box.innerHTML = html;

    // 就地编辑模式：信息卡区块替换为表单
    if (state.profileEditing) {
      const cardBlocks = box.querySelectorAll('.profile-block-card');
      const last = cardBlocks[cardBlocks.length - 1];
      if (last) {
        last.innerHTML = '<div class="profile-section-title">✍️ 编辑学员信息卡</div>' + profileEditFormHtml(card || {});
        last.querySelector('[data-prof-cancel]').addEventListener('click', function () {
          state.profileEditing = false;
          renderProfileBody(box, state.profileData || p);
        });
        last.querySelector('[data-pe-save]').addEventListener('click', async function () {
          const lines = function (v) { return v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); };
          try {
            await api('/api/profile', {
              method: 'POST',
              body: JSON.stringify({
                profileText: last.querySelector('[data-pe-text]').value.trim(),
                strengths: lines(last.querySelector('[data-pe-strengths]').value),
                weaknesses: lines(last.querySelector('[data-pe-weaknesses]').value),
                focus: lines(last.querySelector('[data-pe-focus]').value)
              })
            });
            state.profileEditing = false;
            state.profileData = null;
            await renderProfilePage();
            toast('信息卡已保存，下次讲解将生效', 'success');
          } catch (e) {
            toast('保存失败：' + e.message, 'error');
          }
        });
      }
    }

    box.querySelector('[data-prof-edit]').addEventListener('click', function () {
      state.profileEditing = !state.profileEditing;
      renderProfileBody(box, state.profileData || p);
    });
    box.querySelector('[data-prof-refresh]').addEventListener('click', async function () {
      const btn = box.querySelector('[data-prof-refresh]');
      btn.disabled = true;
      btn.textContent = '生成中…';
      try {
        await api('/api/profile/refresh', { method: 'POST', body: '{}' });
        state.profileData = null;
        await renderProfilePage({ force: true });
        toast('学员信息卡已更新', 'success');
      } catch (e) {
        toast('更新失败：' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = '立即更新';
      }
    });
  }

  /* ---------------- 页面：设置（独立页面） ---------------- */

  function renderSettingsPage() {
    const root = $('#page-settings');
    const box = root.querySelector('[data-settings-page]');
    const tab = state.settingsTab || 'general';
    box.innerHTML = '<div class="settings-tabs">'
      + '<button class="settings-tab' + (tab === 'general' ? ' active' : '') + '" data-stab="general">通用</button>'
      + '<button class="settings-tab' + (tab === 'providers' ? ' active' : '') + '" data-stab="providers">模型服务</button>'
      + '<button class="settings-tab' + (tab === 'data' ? ' active' : '') + '" data-stab="data">数据</button>'
      + '</div><div data-settings-body style="max-width:760px"></div>';
    $$('[data-stab]', box).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.settingsTab = btn.getAttribute('data-stab');
        renderSettingsPage();
      });
    });
    const body = box.querySelector('[data-settings-body]');
    if (tab === 'general') body.innerHTML = generalTabHtml();
    else if (tab === 'providers') body.innerHTML = providersTabHtml();
    else body.innerHTML = dataTabHtml();
    wireSettingsBody(box);
  }

  /* ---------------- 题目信息弹窗 ---------------- */

  /* ---------------- 外观自定义 ---------------- */

  const APPEARANCE = {
    bg: { navy: '深蓝夜', black: '纯黑', gray: '深灰', paper: '护眼米色', light: '清爽浅色' },
    bgStyle: { solid: '纯色', gradient: '渐变', grid: '网格' },
    accent: { blue: '蓝', cyan: '青', violet: '紫', green: '绿', orange: '橙', red: '红', gold: '金' },
    density: { compact: '紧凑', comfortable: '标准', large: '宽松' },
    uiFont: { system: '系统默认', serif: '衬线（阅读）', mono: '等宽（极客）' },
    radius: { small: '小', medium: '中', large: '大' },
    chatWidth: { narrow: '窄', normal: '标准', wide: '宽' },
    animations: { on: '开启', off: '减少动效' },
    codeTheme: {
      auto: '跟随明暗', 'github-dark': 'GitHub 深色', github: 'GitHub 浅色',
      'atom-one-dark': 'Atom One Dark', 'atom-one-light': 'Atom One Light',
      monokai: 'Monokai', vs2015: 'VS 2015', nord: 'Nord'
    }
  };

  const RADIUS_PX = { small: { sm: 5, md: 8, lg: 11, xl: 16 }, medium: { sm: 8, md: 12, lg: 16, xl: 22 }, large: { sm: 12, md: 16, lg: 20, xl: 28 } };
  const CHAT_WIDTH = { narrow: '700px', normal: '880px', wide: '1120px' };
  const UI_FONT_FAMILIES = {
    system: '',
    serif: 'Georgia, "Songti SC", "SimSun", "Noto Serif SC", serif',
    mono: '"JetBrains Mono", Consolas, "Courier New", monospace'
  };
  const DEFAULT_APPEARANCE = {
    bg: 'navy', bgStyle: 'gradient', accent: 'blue', density: 'comfortable', uiFont: 'system',
    radius: 'medium', chatWidth: 'normal', animations: 'on', codeTheme: 'auto', codeFontSize: 13,
    bgImage: '', bgOpacity: 45, bgBrightness: 100, bgBlur: 0, glass: 72
  };

  function applyAppearance() {
    const a = Object.assign({}, DEFAULT_APPEARANCE, (state.config && state.config.appearance) || {});
    const root = document.documentElement;
    root.dataset.bg = APPEARANCE.bg[a.bg] ? a.bg : 'navy';
    root.dataset.bgstyle = APPEARANCE.bgStyle[a.bgStyle] ? a.bgStyle : 'gradient';
    root.dataset.accent = APPEARANCE.accent[a.accent] ? a.accent : 'blue';
    root.dataset.density = APPEARANCE.density[a.density] ? a.density : 'comfortable';
    root.dataset.anim = APPEARANCE.animations[a.animations] ? a.animations : 'on';
    const r = RADIUS_PX[a.radius] || RADIUS_PX.medium;
    root.style.setProperty('--radius-sm', r.sm + 'px');
    root.style.setProperty('--radius-md', r.md + 'px');
    root.style.setProperty('--radius-lg', r.lg + 'px');
    root.style.setProperty('--radius-xl', r.xl + 'px');
    root.style.setProperty('--chat-max', CHAT_WIDTH[a.chatWidth] || CHAT_WIDTH.normal);
    const fam = UI_FONT_FAMILIES[a.uiFont];
    if (fam) root.style.setProperty('--font', fam);
    else root.style.removeProperty('--font');
    root.style.setProperty('--code-font-size', (Number(a.codeFontSize) || 13) + 'px');
    applyCodeTheme(a.codeTheme);
    applyBackgroundImage(a);
  }

  /** 自定义背景图：图片 + 透明度 / 亮度 / 模糊 / 玻璃强度 */
  function applyBackgroundImage(a) {
    const layer = $('#bg-layer');
    const root = document.documentElement;
    const has = !!(a && a.bgImage);
    if (layer) {
      layer.style.backgroundImage = has ? 'url("' + String(a.bgImage).replace(/"/g, '%22') + '")' : 'none';
    }
    root.dataset.bgimage = has ? 'on' : 'off';
    root.style.setProperty('--bg-img-opacity', String((Number(a && a.bgOpacity) || 45) / 100));
    root.style.setProperty('--bg-img-brightness', String((Number(a && a.bgBrightness) || 100) / 100));
    root.style.setProperty('--bg-img-blur', (Number(a && a.bgBlur) || 0) + 'px');
    root.style.setProperty('--glass', (Number(a && a.glass) || 72) + '%');
  }

  /** 读取本地图片 → 等比缩放到 1600px 内并压缩，返回 dataURL */
  function readAndCompressImage(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.onload = function () {
          const maxDim = 1600;
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          let quality = 0.85;
          let dataUrl = canvas.toDataURL('image/jpeg', quality);
          // 控制体积（配置以 JSON 存本地，避免过大）
          while (dataUrl.length > 1500000 && quality > 0.45) {
            quality -= 0.12;
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          }
          resolve(dataUrl);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function applyCodeTheme(theme) {
    const light = $('#hljs-light');
    const dark = $('#hljs-dark');
    let custom = $('#hljs-custom');
    if (!custom) {
      custom = document.createElement('link');
      custom.rel = 'stylesheet';
      custom.id = 'hljs-custom';
      custom.disabled = true;
      document.head.appendChild(custom);
    }
    if (!theme || theme === 'auto') {
      custom.disabled = true;
      const isDark = document.documentElement.dataset.theme === 'dark';
      if (light) light.disabled = isDark;
      if (dark) dark.disabled = !isDark;
      return;
    }
    custom.href = '/vendor/hljs/' + theme + '.min.css';
    custom.disabled = false;
    if (light) light.disabled = true;
    if (dark) dark.disabled = true;
  }

  /* ---------------- 悬浮提示（rating 节点等） ---------------- */

  function initTooltips() {
    let tip = null;
    const show = function (target) {
      const text = target.getAttribute('data-tip');
      if (!text) return;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'hover-tip';
        document.body.appendChild(tip);
      }
      tip.textContent = text;
      tip.classList.add('show');
      const r = target.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = r.left + r.width / 2 - tw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
      let top = r.top - th - 8;
      if (top < 8) top = r.bottom + 8;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    };
    const hide = function () { if (tip) tip.classList.remove('show'); };
    document.addEventListener('mouseover', function (e) {
      const t = e.target.closest('[data-tip]');
      if (t) show(t); else hide();
    });
    document.addEventListener('mouseout', function (e) {
      if (e.target.closest('[data-tip]')) hide();
    });
    document.addEventListener('scroll', hide, true);
  }

  /* ---------------- 设置中心 ---------------- */

  const PROVIDER_PRESETS = [
    { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'], includeUsage: true },
    { name: 'Anthropic (Claude)', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'] },
    { name: 'Moonshot (Kimi)', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
    { name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
    { name: '阿里云百炼 (Qwen)', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'] },
    { name: '火山方舟 (豆包)', type: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: [] },
    { name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
    { name: 'xAI (Grok)', type: 'openai', baseUrl: 'https://api.x.ai/v1', models: ['grok-2-latest', 'grok-3'] },
    { name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'] },
    { name: 'Ollama (本地)', type: 'openai', baseUrl: 'http://localhost:11434/v1', models: [] }
  ];

  let editingProvider = null;

  function openSettings(tab) {
    state.settingsTab = tab || 'general';
    switchView('settings');
  }

  function pills(key, group, current, attrName, extraCls) {
    return '<div class="radio-line ' + (extraCls || '') + '">' + Object.keys(group).map(function (x) {
      return '<button class="radio-pill' + (current === x ? ' active' : '') + '" ' + attrName + '="' + x + '">' + group[x] + '</button>';
    }).join('') + '</div>';
  }

  function generalTabHtml() {
    const cfg = state.config;
    const a = Object.assign({}, DEFAULT_APPEARANCE, cfg.appearance || {});
    const codeThemeOpts = Object.keys(APPEARANCE.codeTheme).map(function (k) {
      return '<option value="' + k + '"' + (a.codeTheme === k ? ' selected' : '') + '>' + APPEARANCE.codeTheme[k] + '</option>';
    }).join('');
    return '<div class="settings-grid" style="padding-top:14px">'
      + '<div class="settings-section-title span-all">🖼️ 自定义背景图（可上传本地图片）</div>'
      + '<div class="form-group span-all"><label class="form-label">背景图片</label>'
      + '<div class="bg-image-row">'
      + '<div class="bg-image-preview" data-g-bgimg-preview style="' + (a.bgImage ? 'background-image:url(&quot;' + MD.escapeHtml(a.bgImage) + '&quot;)' : '') + '">' + (a.bgImage ? '' : '未设置') + '</div>'
      + '<div style="flex:1;min-width:220px">'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<button class="btn btn-default" data-g-bgimg-upload>上传图片</button>'
      + '<button class="btn btn-default" data-g-bgimg-clear' + (a.bgImage ? '' : ' disabled') + '>移除图片</button>'
      + '</div>'
      + '<div class="form-hint">支持 JPG / PNG / WebP，自动压缩到 1600px 内并保存在本地配置中（不上传）</div>'
      + '</div></div>'
      + '<div class="bg-slider-row"><label>图片透明度</label><input type="range" data-g-bgopacity min="5" max="100" step="1" value="' + a.bgOpacity + '"><span class="bg-slider-val" data-g-bgopacity-val>' + a.bgOpacity + '%</span></div>'
      + '<div class="bg-slider-row"><label>图片亮度</label><input type="range" data-g-bgbright min="30" max="160" step="1" value="' + a.bgBrightness + '"><span class="bg-slider-val" data-g-bgbright-val>' + a.bgBrightness + '%</span></div>'
      + '<div class="bg-slider-row"><label>图片模糊</label><input type="range" data-g-bgblur min="0" max="24" step="1" value="' + a.bgBlur + '"><span class="bg-slider-val" data-g-bgblur-val>' + a.bgBlur + 'px</span></div>'
      + '<div class="bg-slider-row"><label>面板不透明度</label><input type="range" data-g-glass min="30" max="100" step="1" value="' + a.glass + '"><span class="bg-slider-val" data-g-glass-val>' + a.glass + '%</span></div>'
      + '</div>'

      + '<div class="settings-section-title span-all">🎨 外观</div>'
      + '<div class="form-group"><label class="form-label">外观预设（背景基调）</label>' + pills('bg', APPEARANCE.bg, a.bg, 'data-g-bg') + '</div>'
      + '<div class="form-group"><label class="form-label">背景质感</label>' + pills('bgStyle', APPEARANCE.bgStyle, a.bgStyle, 'data-g-bgstyle') + '</div>'
      + '<div class="form-group"><label class="form-label">主题色</label><div class="radio-line accent-pills">'
      + Object.keys(APPEARANCE.accent).map(function (x) {
        return '<button class="accent-pill accent-' + x + (a.accent === x ? ' active' : '') + '" data-g-accent="' + x + '" title="' + APPEARANCE.accent[x] + '">' + APPEARANCE.accent[x] + '</button>';
      }).join('') + '</div></div>'
      + '<div class="form-group"><label class="form-label">明暗主题</label>' + pills('theme', THEME_NAMES, cfg.theme, 'data-g-theme') + '</div>'
      + '<div class="form-group"><label class="form-label">界面字号</label>' + pills('density', APPEARANCE.density, a.density, 'data-g-density') + '</div>'
      + '<div class="form-group"><label class="form-label">界面字体</label>' + pills('uiFont', APPEARANCE.uiFont, a.uiFont, 'data-g-uifont') + '</div>'
      + '<div class="form-group"><label class="form-label">代码字号：<span data-g-codefont-val>' + a.codeFontSize + 'px</span></label>'
      + '<div class="range-row"><input type="range" data-g-codefont min="11" max="17" step="1" value="' + a.codeFontSize + '"></div></div>'
      + '<div class="form-group"><label class="form-label">圆角大小</label>' + pills('radius', APPEARANCE.radius, a.radius, 'data-g-radius') + '</div>'
      + '<div class="form-group"><label class="form-label">阅读宽度</label>' + pills('chatWidth', APPEARANCE.chatWidth, a.chatWidth, 'data-g-width') + '</div>'
      + '<div class="form-group"><label class="form-label">动效</label>' + pills('animations', APPEARANCE.animations, a.animations, 'data-g-anim') + '</div>'
      + '<div class="form-group"><label class="form-label">代码高亮主题</label>'
      + '<select class="form-select" data-g-codetheme style="max-width:240px">' + codeThemeOpts + '</select></div>'
      + '<div class="form-group"><button class="btn btn-default" data-g-reset-appearance>恢复默认外观</button></div>'

      + '<div class="settings-section-title span-all">🌐 网络与题面抓取</div>'
      + '<div class="form-group span-all"><label class="form-label">HTTP 代理（可选，用于抓取 Codeforces 题面）</label>'
      + '<div class="form-row"><input class="form-input" data-g-cfproxy type="text" value="' + MD.escapeHtml(cfg.cfProxy || '') + '" placeholder="如 http://127.0.0.1:7890（留空则直连）" autocomplete="off">'
      + '<button class="btn btn-default" data-g-cftest style="flex:none;min-width:130px">测试抓取题面</button></div>'
      + '<div class="form-hint">Codeforces 对题面页有反爬：本机网络被拦截时，可填本地代理（Clash/V2Ray 等），或直接把题面粘贴到输入框。'
      + '题目难度与标签走官方 API，不受影响。</div>'
      + '<div class="form-hint">⚠ 本工具抓题面时**只请求桌面版**（自动带 <code>?mobile=false</code>），并会拒绝解析 CF 的移动版页面；'
      + '抓取用的是应用内独立的会话，不会影响你自己浏览器的 Codeforces 登录与偏好。'
      + '若你的浏览器被 CF 切到了移动版，在页面底部点「Desktop version」或打开 <code>https://codeforces.com/?mobile=false</code> 即可切回。</div>'
      + '<div style="margin-top:6px"><button class="btn btn-default" data-g-cfclear>清理本应用的内嵌 CF 抓取会话</button>'
      + '<span class="form-hint" style="margin-left:8px">（只清本应用的 cookie/缓存，不影响浏览器）</span></div>'
      + '<div class="form-hint" data-g-cftest-info></div></div>'

      + '<div class="settings-section-title span-all">🧑‍🏫 教练设置</div>'
      + '<div class="form-group"><label class="form-label">Codeforces 用户名（讲解深度与学员信息卡的数据来源）</label>'
      + '<div class="form-row"><input class="form-input" data-g-cfhandle type="text" value="' + MD.escapeHtml(cfg.cfHandle || '') + '" placeholder="如 tourist" autocomplete="off">'
      + '<button class="btn btn-default" data-g-cfquery style="flex:none;min-width:110px">查询等级</button></div>'
      + '<div class="form-hint" data-g-cfinfo></div></div>'
      + '<div class="form-group"><label class="form-label">默认讲解语言（代码与逐行讲解的语言）</label>'
      + '<div class="radio-line">'
      + '<button class="radio-pill' + ((cfg.defaultCoachLang || 'cpp') !== 'python' ? ' active' : '') + '" data-g-lang="cpp">C++23</button>'
      + '<button class="radio-pill' + ((cfg.defaultCoachLang || 'cpp') === 'python' ? ' active' : '') + '" data-g-lang="python">Python 3</button>'
      + '</div></div>'
      + '<div class="form-group"><label class="form-label">发送快捷键</label>'
      + '<div class="radio-line">'
      + '<button class="radio-pill' + (cfg.sendShortcut !== 'ctrlenter' ? ' active' : '') + '" data-g-shortcut="enter">Enter 发送</button>'
      + '<button class="radio-pill' + (cfg.sendShortcut === 'ctrlenter' ? ' active' : '') + '" data-g-shortcut="ctrlenter">Ctrl+Enter 发送</button>'
      + '</div></div>'
      + '<div class="settings-section-title span-all">🔒 代码沙箱（安全）</div>'
      + '<div class="form-group span-all"><label class="form-label">运行生成的验证代码时限制它的权限</label>'
      + '<div class="radio-line">'
      + '<button class="radio-pill' + (cfg.sandbox !== false ? ' active' : '') + '" data-g-sandbox="on">启用沙箱（推荐）</button>'
      + '<button class="radio-pill' + (cfg.sandbox === false ? ' active' : '') + '" data-g-sandbox="off">关闭（风险自负）</button>'
      + '</div>'
      + '<div class="form-hint">题面抓取自外网，可能被间接提示注入，诱导模型写出越权代码。沙箱会禁止生成代码读写沙箱目录之外的文件、访问网络。'
      + '<br>⚠ 这是**缓解而非隔离**：C++ 通道无法在用户态限制（需要容器/受限账户）；Python/Node 通道也挡不住刻意逃逸的原生调用。</div>'
      + '<div class="form-hint" data-g-sandbox-info></div></div>'
      + '<div class="form-group span-all"><label class="form-label">允许生成代码访问网络</label>'
      + '<div class="radio-line">'
      + '<button class="radio-pill' + (cfg.sandboxAllowNetwork !== true ? ' active' : '') + '" data-g-sandboxnet="off">禁止（推荐）</button>'
      + '<button class="radio-pill' + (cfg.sandboxAllowNetwork === true ? ' active' : '') + '" data-g-sandboxnet="on">允许</button>'
      + '</div><div class="form-hint">极少有题目需要联网；默认禁止。</div></div>'

      + '<div class="span-all" style="text-align:right;padding:6px 0"><button class="btn btn-primary" data-g-save>保存设置</button></div>'
      + '</div>';
  }

  function providersTabHtml() {
    const providers = state.config.providers || [];
    let html = '<div style="padding-top:14px">'
      + '<div class="form-hint" style="margin-bottom:10px">支持任意 OpenAI 兼容接口与 Anthropic 接口。API 密钥仅保存在本机 data/config.json，不会上传。</div>';
    if (!providers.length) {
      html += '<div class="sb-empty" style="padding:26px 0">还没有模型服务，点击下方按钮添加<br>支持 DeepSeek / OpenAI / Claude / Kimi / GLM / Qwen / 豆包 / Ollama 等</div>';
    }
    providers.forEach(function (p) {
      const isDefault = state.config.defaultProviderId === p.id;
      html += '<div class="provider-card' + (isDefault ? ' default' : '') + '">'
        + '<div class="provider-avatar">' + MD.escapeHtml((p.name || '?').slice(0, 1).toUpperCase()) + '</div>'
        + '<div class="provider-info">'
        + '<div class="provider-name">' + MD.escapeHtml(p.name)
        + (isDefault ? '<span class="provider-badge">默认</span>' : '') + '</div>'
        + '<div class="provider-meta">' + (p.type === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容')
        + ' · ' + MD.escapeHtml(p.baseUrl || '')
        + ' · 模型 ' + ((p.models || []).length ? (p.models || []).length + ' 个' : '未配置')
        + (p.apiKey ? ' · 密钥已保存' : ' · <span style="color:var(--danger)">未填密钥</span>') + '</div>'
        + '</div>'
        + '<div class="provider-actions">'
        + '<button class="icon-btn" data-p-set-default="' + p.id + '" title="设为默认服务">' + icon('star', 15) + '</button>'
        + '<button class="icon-btn" data-p-edit="' + p.id + '" title="编辑">' + icon('edit', 14) + '</button>'
        + '<button class="icon-btn" data-p-del="' + p.id + '" title="删除" style="color:var(--danger)">' + icon('trash', 14) + '</button>'
        + '</div></div>';
    });
    html += '<button class="btn btn-default" data-p-add style="width:100%;margin-top:4px">＋ 添加模型服务</button>';
    html += agentModelsHtml(providers);
    html += '</div>';
    return html;
  }

  /** 多 Agent 分工模型（可选）：brute 建议用最强的，gen 可以用最便宜的 */
  function agentModelsHtml(providers) {
    const roles = [
      { key: 'solution', label: '题解 Agent', hint: '给出最终解法，建议用主力模型' },
      { key: 'brute', label: '暴力 Agent', hint: '对拍标尺，错则全错 —— 建议用最强模型' },
      { key: 'gen', label: '数据生成 Agent', hint: '只做机械的格式生成 —— 可以用最便宜的模型' },
      { key: 'explainer', label: '讲解 Agent', hint: '最终讲课输出，建议用表达最好的模型' },
      { key: 'plan', label: '讲解提纲 Agent', hint: '动笔前先定推理链（短输出）—— 可以用便宜模型' },
      { key: 'normalize', label: '题面整理 Agent', hint: '粘贴题面时整理成标准格式（含样例）—— 便宜模型够用' },
      { key: 'witness', label: '手算锚点 Agent', hint: '没有官方样例时造极端小样例并手算答案，建议用强模型' }
    ];
    const cur = state.config.agentModels || {};
    const options = ['<option value="">跟随会话模型（默认）</option>'];
    providers.forEach(function (p) {
      (p.models || []).forEach(function (m) {
        const v = p.id + '::' + m;
        options.push('<option value="' + MD.escapeHtml(v) + '"' + (cur[roles[0].key] === v ? '' : '') + '>'
          + MD.escapeHtml(p.name + ' · ' + m) + '</option>');
      });
    });
    let html = '<div class="form-group" style="margin-top:22px"><label class="form-label">多 Agent 分工模型（可选）</label>'
      + '<div class="form-hint" style="margin-bottom:8px">当前架构把「题解 / 暴力 / 生成器 / 讲解」拆成四个互不可见代码的子 Agent。'
      + '分角色指定模型可以既保正确性又省 token（例如暴力解用强模型、生成器用便宜模型）。</div>';
    roles.forEach(function (r) {
      const opts = options.map(function (o) {
        if (o.indexOf('value=""') >= 0) return o;
        const v = o.match(/value="([^"]+)"/)[1];
        return o.replace('<option value="' + v + '"', '<option value="' + v + '"' + (cur[r.key] === v ? ' selected' : ''));
      }).join('');
      html += '<div class="form-group" style="margin-bottom:10px">'
        + '<label class="form-label" style="font-size:12.5px">' + r.label
        + '<span class="form-hint" style="margin-left:8px;font-weight:400">' + r.hint + '</span></label>'
        + '<select class="form-select" data-agent-model="' + r.key + '">' + opts + '</select></div>';
    });
    html += '<button class="btn btn-default" data-agent-save>保存分角色模型</button></div>';

    /* ---- token 消耗与费用估算 ---- */
    const pricing = Object.assign({}, state.config.pricing || {});
    const priceRows = [];
    Object.keys(pricing).forEach(function (k) {
      const v = pricing[k] || {};
      priceRows.push({ key: k, in: v.in, out: v.out });
    });
    html += '<div class="form-group" style="margin-top:22px"><label class="form-label">单价（每 100 万 token，元）</label>'
      + '<div class="form-hint" style="margin-bottom:8px">讲解结束后会在消息下方显示「这轮花了多少」。'
      + 'token 数直接取自服务商返回的 usage（服务商不返回时按字符估算并标注"约"）；'
      + '费用 = token × 单价，**单价请照你自己的账单填**（内置的只是常见模型的参考价，随时会变）。</div>'
      + '<div class="form-hint" style="margin-bottom:8px">键写 <code>providerId::model</code> 或只写 model；留空则用内置参考价。</div>'
      + '<div data-pricing-rows>'
      + (priceRows.length ? priceRows.map(function (r) {
        return '<div class="form-row" style="display:flex;gap:6px;margin-bottom:6px" data-pricing-row>'
          + '<input class="form-input" data-pricing-key placeholder="deepseek-chat" value="' + MD.escapeHtml(r.key) + '">'
          + '<input class="form-input" type="number" step="0.01" data-pricing-in placeholder="输入价" value="' + (r.in != null ? r.in : '') + '">'
          + '<input class="form-input" type="number" step="0.01" data-pricing-out placeholder="输出价" value="' + (r.out != null ? r.out : '') + '">'
          + '<button class="btn btn-default" data-pricing-del>删</button></div>';
      }).join('') : '<div class="form-hint">（暂无自定义单价，使用内置参考价）</div>')
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:6px">'
      + '<button class="btn btn-default" data-pricing-add>+ 添加一行</button>'
      + '<button class="btn btn-default" data-pricing-save>保存单价</button></div>'
      + '<div class="form-group" style="margin-top:14px"><label class="form-label">单次输出上限（max_tokens）</label>'
      + '<div class="form-hint" style="margin-bottom:6px">留空（或 0）= <b>用服务商默认值</b>（推荐）：推理型模型会把预算先花在"思考"上，'
      + '上限设小了会导致正文被截断甚至为空（此时程序会自动去掉上限重试一次）。'
      + '要压成本就填一个值（例如 16384），服务商不接受时会自动改用它的默认值。</div>'
      + '<input class="form-input" type="number" min="0" placeholder="留空 = 服务商默认" data-max-output value="'
      + (state.config.maxOutputTokens > 0 ? state.config.maxOutputTokens : '') + '">'
      + '<button class="btn btn-default" style="margin-top:6px" data-max-output-save>保存</button></div>'
      + '</div>';
    return html;
  }

  function dataTabHtml() {
    return '<div style="padding-top:14px">'
      + '<div class="form-group"><label class="form-label">数据存储</label>'
      + '<div class="data-stat" data-ds-stats>'
      + '<div class="data-stat-item"><div class="data-stat-num">…</div><div class="data-stat-label">活跃对话</div></div>'
      + '<div class="data-stat-item"><div class="data-stat-num">…</div><div class="data-stat-label">已归档</div></div>'
      + '</div>'
      + '<div class="form-hint">所有对话均以 JSON 文件保存在本机：<code data-ds-dir>…</code><br>'
      + '🔒 隐私承诺：除调用你配置的模型 API 外，本应用不会向任何第三方上传任何数据。</div></div>'
      + '<div class="form-group"><label class="form-label">备份与迁移</label>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      + '<button class="btn btn-default" data-ds-export>导出全部对话 (JSON)</button>'
      + '<button class="btn btn-default" data-ds-import>导入对话 (JSON)</button>'
      + '</div></div>'
      + '<div class="form-group"><label class="form-label">诊断包（出问题时发给开发者）</label>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      + '<button class="btn btn-default" data-ds-diag>导出诊断包 (TXT)</button>'
      + '<button class="btn btn-default" data-ds-diagfile>写到 data/diag/ 目录</button>'
      + '</div>'
      + '<div class="form-hint">诊断包是一份纯文本，含：运行环境、模型配置（<b>key 与 cookie 已自动打码</b>）、'
      + '抓取/诊断日志、题面缓存台账、工作区验证状态、最近几个会话的尾部消息、消融跑分记录。'
      + '完整解题代码与完整题面正文不进包（回答只留前 600 字符、工具结果只留前 300 字符）。默认只带最近 6 个会话，体积按段裁剪。<br>'
      + '从仓库源码跑（开发版）时，命令行也能生成同一份文件：'
      + '<code>node scripts/diag.js --out 诊断包.txt</code></div>'
      + '<div class="form-hint" data-ds-diagpath></div></div>'
      + '<div class="form-group"><label class="form-label">危险操作</label>'
      + '<button class="btn btn-danger" data-ds-clear>清空所有对话</button></div>'
      + '</div>';
  }

  function wireSettingsBody(root) {
    const tab = state.settingsTab || 'general';
    if (tab === 'general') {
      $$('[data-g-theme]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.config.theme = btn.getAttribute('data-g-theme');
          applyTheme();
          $$('[data-g-theme]', root).forEach(function (b) { b.classList.toggle('active', b === btn); });
        });
      });
      $$('[data-g-shortcut]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.config.sendShortcut = btn.getAttribute('data-g-shortcut');
          $$('[data-g-shortcut]', root).forEach(function (b) { b.classList.toggle('active', b === btn); });
        });
      });
      $$('[data-g-lang]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.config.defaultCoachLang = btn.getAttribute('data-g-lang');
          $$('[data-g-lang]', root).forEach(function (b) { b.classList.toggle('active', b === btn); });
        });
      });
      // 代码沙箱：开关 + 各通道实际状态（如实展示 C++ 无法限制）
      $$('[data-g-sandbox]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.config.sandbox = btn.getAttribute('data-g-sandbox') === 'on';
          $$('[data-g-sandbox]', root).forEach(function (b) { b.classList.toggle('active', b === btn); });
        });
      });
      $$('[data-g-sandboxnet]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.config.sandboxAllowNetwork = btn.getAttribute('data-g-sandboxnet') === 'on';
          $$('[data-g-sandboxnet]', root).forEach(function (b) { b.classList.toggle('active', b === btn); });
        });
      });
      const sbInfo = root.querySelector('[data-g-sandbox-info]');      if (sbInfo) {
        api('/api/sandbox').then(function (s) {
          const on = s.enabled !== false;
          sbInfo.innerHTML = '当前状态：' + (on ? '<b style="color:var(--success,#34d399)">已启用</b>' : '<b style="color:var(--danger)">已关闭</b>')
            + ' · Python 守卫 ' + (s.python ? '可用' : '不可用')
            + ' · Node 守卫 ' + (s.js ? '可用' : '不可用')
            + ' · <b style="color:var(--warning,#fbbf24)">C++ 通道无法限制</b>（生成的原生程序可读写本机文件、联网）';
        }).catch(function () { /* ignore */ });
      }
      // 外观自定义（即时预览）：背景 / 质感 / 主题色 / 字号 / 字体 / 圆角 / 宽度 / 动效
      state.config.appearance = Object.assign({}, DEFAULT_APPEARANCE, state.config.appearance || {});
      [['bg', 'data-g-bg'], ['bgStyle', 'data-g-bgstyle'], ['accent', 'data-g-accent'], ['density', 'data-g-density'],
        ['uiFont', 'data-g-uifont'], ['radius', 'data-g-radius'], ['chatWidth', 'data-g-width'], ['animations', 'data-g-anim']
      ].forEach(function (pair) {
        const key = pair[0];
        $$('[' + pair[1] + ']', root).forEach(function (btn) {
          btn.addEventListener('click', function () {
            state.config.appearance[key] = btn.getAttribute(pair[1]);
            applyAppearance();
            $$('[' + pair[1] + ']', root).forEach(function (b) { b.classList.toggle('active', b === btn); });
          });
        });
      });
      const codeFont = root.querySelector('[data-g-codefont]');
      if (codeFont) codeFont.addEventListener('input', function () {
        state.config.appearance.codeFontSize = parseInt(codeFont.value, 10) || 13;
        const label = root.querySelector('[data-g-codefont-val]');
        if (label) label.textContent = state.config.appearance.codeFontSize + 'px';
        applyAppearance();
      });
      const codeThemeSel = root.querySelector('[data-g-codetheme]');
      if (codeThemeSel) codeThemeSel.addEventListener('change', function () {
        state.config.appearance.codeTheme = codeThemeSel.value;
        applyAppearance();
      });
      const resetAppearance = root.querySelector('[data-g-reset-appearance]');
      if (resetAppearance) resetAppearance.addEventListener('click', function () {
        state.config.appearance = Object.assign({}, DEFAULT_APPEARANCE);
        applyAppearance();
        renderSettingsPage();
        toast('已恢复默认外观', 'success');
      });

      // 自定义背景图：上传 / 移除 / 透明度 / 亮度 / 模糊 / 面板不透明度
      const bgUpload = root.querySelector('[data-g-bgimg-upload]');
      if (bgUpload) bgUpload.addEventListener('click', function () {
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = 'image/*';
        fi.addEventListener('change', async function () {
          if (!fi.files.length) return;
          try {
            const dataUrl = await readAndCompressImage(fi.files[0]);
            state.config.appearance.bgImage = dataUrl;
            applyAppearance();
            renderSettingsPage();
            toast('背景图已应用，可继续调整透明度与亮度', 'success');
          } catch (e) {
            toast('图片处理失败：' + e.message, 'error');
          }
        });
        fi.click();
      });
      const bgClear = root.querySelector('[data-g-bgimg-clear]');
      if (bgClear) bgClear.addEventListener('click', function () {
        state.config.appearance.bgImage = '';
        applyAppearance();
        renderSettingsPage();
        toast('已移除背景图', 'success');
      });
      [['data-g-bgopacity', 'bgOpacity', '%'], ['data-g-bgbright', 'bgBrightness', '%'],
        ['data-g-bgblur', 'bgBlur', 'px'], ['data-g-glass', 'glass', '%']
      ].forEach(function (pair) {
        const el = root.querySelector('[' + pair[0] + ']');
        if (!el) return;
        el.addEventListener('input', function () {
          state.config.appearance[pair[1]] = parseInt(el.value, 10) || 0;
          const valEl = root.querySelector('[' + pair[0] + '-val]');
          if (valEl) valEl.textContent = el.value + pair[2];
          applyBackgroundImage(state.config.appearance);
        });
      });
      const saveBtn = root.querySelector('[data-g-save]');
      if (saveBtn) saveBtn.addEventListener('click', async function () {
        state.config.cfHandle = root.querySelector('[data-g-cfhandle]').value.trim();
        state.config.cfProxy = root.querySelector('[data-g-cfproxy]').value.trim();
        await saveConfig();
        renderMessages();
        updateComposer();
        updateCoachLevelHint();
        applyAppearance();
        toast('设置已保存', 'success');
      });
      // 测试题面抓取（走真实 CF 页面，失败时给出可操作建议）
      const cfTestBtn = root.querySelector('[data-g-cftest]');
      if (cfTestBtn) cfTestBtn.addEventListener('click', async function () {
        const infoEl = root.querySelector('[data-g-cftest-info]');
        state.config.cfProxy = root.querySelector('[data-g-cfproxy]').value.trim();
        await saveConfig();
        cfTestBtn.disabled = true;
        cfTestBtn.textContent = '抓取中…';
        infoEl.textContent = '正在尝试抓取示例题目（CF 1800C）…';
        try {
          const p = await api('/api/cf/problem?contestId=1800&index=C');
          infoEl.textContent = '✓ 抓取成功：' + p.title + ' · 题面 ' + (p.statement || '').length + ' 字符 · 样例 '
            + (p.samples || []).filter(function (s) { return s.input != null; }).length + ' 组';
        } catch (e) {
          infoEl.textContent = '✗ 抓取失败：' + e.message;
        }
        cfTestBtn.disabled = false;
        cfTestBtn.textContent = '测试抓取题面';
      });
      const cfClearBtn = root.querySelector('[data-g-cfclear]');
      if (cfClearBtn) cfClearBtn.addEventListener('click', async function () {
        cfClearBtn.disabled = true;
        cfClearBtn.textContent = '清理中…';
        try {
          if (window.chatbox && window.chatbox.clearCfSession) {
            const r = await window.chatbox.clearCfSession();
            toast(r && r.ok ? '已清理本应用的 CF 抓取会话' : ('清理失败：' + ((r && r.error) || '未知错误')), r && r.ok ? 'success' : 'error');
          } else {
            toast('该功能仅在桌面版可用', 'error');
          }
        } catch (e) {
          toast('清理失败：' + e.message, 'error');
        }
        cfClearBtn.disabled = false;
        cfClearBtn.textContent = '清理本应用的内嵌 CF 抓取会话';
      });
      const cfQueryBtn = root.querySelector('[data-g-cfquery]');
      if (cfQueryBtn) cfQueryBtn.addEventListener('click', async function () {
        const handle = root.querySelector('[data-g-cfhandle]').value.trim();
        const infoEl = root.querySelector('[data-g-cfinfo]');
        if (!handle) { toast('请先填写 Codeforces 用户名', 'error'); return; }
        cfQueryBtn.disabled = true;
        try {
          const u = await api('/api/cf/user?handle=' + encodeURIComponent(handle));
          infoEl.textContent = '✓ ' + u.handle + '：rating ' + u.rating + '（' + u.levelText + '）· 历史最高 ' + u.maxRating + '。' + u.levelDesc;
        } catch (e) {
          infoEl.textContent = '查询失败：' + e.message;
        }
        cfQueryBtn.disabled = false;
      });
      return;
    }
    if (tab === 'providers') {
      $$('[data-p-edit]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          const p = providerById(btn.getAttribute('data-p-edit'));
          if (p) openProviderEditor(p);
        });
      });
      $$('[data-p-del]', root).forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const id = btn.getAttribute('data-p-del');
          const p = providerById(id);
          const ok = await confirmModal({ title: '删除模型服务', message: '确定删除「' + (p ? p.name : id) + '」吗？', okText: '删除', danger: true });
          if (!ok) return;
          state.config.providers = state.config.providers.filter(function (x) { return x.id !== id; });
          if (state.config.defaultProviderId === id) state.config.defaultProviderId = '';
          await saveConfig();
          renderSettingsPage();
          toast('已删除', 'success');
        });
      });
      $$('[data-p-set-default]', root).forEach(function (btn) {
        btn.addEventListener('click', async function () {
          state.config.defaultProviderId = btn.getAttribute('data-p-set-default');
          await saveConfig();
          renderSettingsPage();
          toast('已设为默认服务', 'success');
        });
      });
      const addBtn = root.querySelector('[data-p-add]');
      if (addBtn) addBtn.addEventListener('click', function () {
        const items = PROVIDER_PRESETS.map(function (preset) {
          return {
            label: preset.name,
            icon: 'model',
            onClick: function () { openProviderEditor(Object.assign({}, preset, { apiKey: '', extraHeaders: {}, id: uid('p_') }), true); }
          };
        });
        items.push('-');
        items.push({ label: '自定义服务（填写任意 Base URL）', icon: 'menu', onClick: function () {
          openProviderEditor({ id: uid('p_'), name: '', type: 'openai', baseUrl: '', apiKey: '', extraHeaders: {}, models: [] }, true);
        } });
        openMenu(addBtn, items);
      });
      const agentSave = root.querySelector('[data-agent-save]');
      if (agentSave) agentSave.addEventListener('click', async function () {
        const next = {};
        $$('[data-agent-model]', root).forEach(function (sel) {
          if (sel.value) next[sel.getAttribute('data-agent-model')] = sel.value;
        });
        state.config.agentModels = next;
        await saveConfig();
        toast(Object.keys(next).length ? ('已保存 ' + Object.keys(next).length + ' 个分角色模型') : '已恢复为跟随会话模型', 'success');
      });
      /* ---- 单价（费用估算）---- */
      const collectPricing = function () {
        const out = {};
        $$('[data-pricing-row]', root).forEach(function (row) {
          const k = (row.querySelector('[data-pricing-key]').value || '').trim();
          if (!k) return;
          const i = parseFloat(row.querySelector('[data-pricing-in]').value);
          const o = parseFloat(row.querySelector('[data-pricing-out]').value);
          out[k] = { in: isFinite(i) ? i : 0, out: isFinite(o) ? o : 0 };
        });
        return out;
      };
      const pricingAdd = root.querySelector('[data-pricing-add]');
      if (pricingAdd) pricingAdd.addEventListener('click', function () {
        const box = root.querySelector('[data-pricing-rows]');
        if (box.querySelector('.form-hint')) box.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'form-row';
        div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
        div.setAttribute('data-pricing-row', '');
        div.innerHTML = '<input class="form-input" data-pricing-key placeholder="deepseek-chat">'
          + '<input class="form-input" type="number" step="0.01" data-pricing-in placeholder="输入价">'
          + '<input class="form-input" type="number" step="0.01" data-pricing-out placeholder="输出价">'
          + '<button class="btn btn-default" data-pricing-del>删</button>';
        box.appendChild(div);
      });
      root.addEventListener('click', function (e) {
        const del = e.target.closest && e.target.closest('[data-pricing-del]');
        if (!del) return;
        const row = del.closest('[data-pricing-row]');
        if (row) row.remove();
      });
      const pricingSave = root.querySelector('[data-pricing-save]');
      if (pricingSave) pricingSave.addEventListener('click', async function () {
        state.config.pricing = collectPricing();
        await saveConfig();
        toast(Object.keys(state.config.pricing).length
          ? ('已保存 ' + Object.keys(state.config.pricing).length + ' 条单价') : '已清空自定义单价（使用内置参考价）', 'success');
      });
      const maxOutSave = root.querySelector('[data-max-output-save]');
      if (maxOutSave) maxOutSave.addEventListener('click', async function () {
        const v = parseInt(root.querySelector('[data-max-output]').value, 10);
        // 留空 / 0 = 不指定，交给服务商默认（推理型模型设小了会把预算全花在思考上，正文反而拿不到）
        state.config.maxOutputTokens = isFinite(v) && v > 0 ? v : 0;
        await saveConfig();
        toast(state.config.maxOutputTokens > 0
          ? ('单次输出上限已设为 ' + state.config.maxOutputTokens)
          : '单次输出上限已清空（使用服务商默认值）', 'success');
      });
      return;
    }
    if (tab === 'data') {
      fetchInfo().then(function (info) {
        if (!info) return;
        root.querySelector('[data-ds-stats]').innerHTML =
          '<div class="data-stat-item"><div class="data-stat-num">' + info.counts.active + '</div><div class="data-stat-label">活跃对话</div></div>'
          + '<div class="data-stat-item"><div class="data-stat-num">' + info.counts.archive + '</div><div class="data-stat-label">已归档</div></div>';
        root.querySelector('[data-ds-dir]').textContent = info.dataDir;
      });
      root.querySelector('[data-ds-export]').addEventListener('click', function () {
        window.open('/api/export/all.json', '_blank');
        toast('开始导出…', 'info');
      });
      root.querySelector('[data-ds-import]').addEventListener('click', function () {
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = '.json,application/json';
        fi.addEventListener('change', async function () {
          if (!fi.files.length) return;
          const file = fi.files[0];
          const text = await file.text();
          let data;
          try { data = JSON.parse(text); } catch (e) { toast('JSON 解析失败', 'error'); return; }
          try {
            const r = await api('/api/import', { method: 'POST', body: JSON.stringify(data) });
            await refreshList();
            toast('成功导入 ' + r.imported + ' 个对话', 'success');
          } catch (e) {
            toast('导入失败：' + e.message, 'error');
          }
        });
        fi.click();
      });
      root.querySelector('[data-ds-diag]').addEventListener('click', function () {
        window.open('/api/diag/export', '_blank');
        toast('正在生成诊断包…（纯文本，key 与 cookie 已打码）', 'info');
      });
      root.querySelector('[data-ds-diagfile]').addEventListener('click', async function () {
        const btn = this;
        btn.disabled = true;
        try {
          const r = await api('/api/diag/save', { method: 'POST' });
          root.querySelector('[data-ds-diagpath]').textContent =
            '已写出：' + r.file + '（' + Math.round(r.bytes / 1024) + 'KB，段落：' + (r.sections || []).join(' / ') + '）';
          toast('诊断包已写到 data/diag/ 目录', 'success');
        } catch (e) {
          toast('写诊断包失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
        }
      });
      root.querySelector('[data-ds-clear]').addEventListener('click', async function () {
        const ok = await confirmModal({
          title: '清空所有对话',
          message: '将永久删除本机 data 目录下的所有对话文件（含归档），此操作不可恢复。确定继续吗？',
          okText: '全部删除', danger: true
        });
        if (!ok) return;
        Object.keys(state.streams).forEach(function (id) { stopStreaming(id, true); });
        await api('/api/conversations?confirm=1', { method: 'DELETE' });
        closeCurrent();
        await refreshList();
        renderSettingsPage();
        toast('已清空所有对话', 'success');
      });
      return;
    }
  }

  /* ---------------- 模型服务编辑（独立整页） ---------------- */

  function openProviderEditor(provider, isNew) {
    editingProvider = Object.assign({}, provider);
    if (isNew && !editingProvider.id) editingProvider.id = uid('p_');
    switchView('provider-edit');
  }

  function renderProviderEditPage() {
    const root = $('#page-provider-edit');
    if (!root) return;
    const box = root.querySelector('[data-provider-edit-page]');
    const p = editingProvider || { id: uid('p_'), name: '', type: 'openai', baseUrl: '', apiKey: '', extraHeaders: {}, models: [] };
    editingProvider = p;
    const isNew = !state.config.providers.some(function (x) { return x.id === p.id; });

    box.innerHTML = '<div class="page-head">'
      + '<div><div class="page-title">' + (isNew ? '🔌 添加模型服务' : '🔌 编辑模型服务') + '</div>'
      + '<div class="page-sub">支持任意 OpenAI 兼容接口与 Anthropic 接口 · API 密钥仅保存在本机 data/config.json</div></div>'
      + '<button class="btn btn-default" data-page-back>← 返回</button>'
      + '</div>'
      + '<div class="settings-grid">'
      + '<div class="form-group"><label class="form-label">显示名称</label>'
      + '<input class="form-input" data-pe-name value="' + MD.escapeHtml(p.name || '') + '" placeholder="如 DeepSeek"></div>'
      + '<div class="form-group"><label class="form-label">接口类型</label>'
      + '<select class="form-select" data-pe-type>'
      + '<option value="openai"' + (p.type !== 'anthropic' ? ' selected' : '') + '>OpenAI 兼容</option>'
      + '<option value="anthropic"' + (p.type === 'anthropic' ? ' selected' : '') + '>Anthropic</option>'
      + '</select></div>'
      + '<div class="form-group span-all"><label class="form-label">Base URL（API 地址）</label>'
      + '<input class="form-input" data-pe-url value="' + MD.escapeHtml(p.baseUrl || '') + '" placeholder="' + (p.type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com 或 …/v1') + '">'
      + '<div class="form-hint" data-pe-url-hint>' + (p.type === 'anthropic'
        ? '将请求 ' + MD.escapeHtml(p.baseUrl || '…') + '/v1/messages'
        : '将请求 ' + MD.escapeHtml(p.baseUrl || '…') + '/chat/completions') + '</div></div>'
      + '<div class="form-group"><label class="form-label">API 密钥</label>'
      + '<div style="display:flex;gap:8px"><input class="form-input" data-pe-key type="password" value="' + MD.escapeHtml(p.apiKey || '') + '" placeholder="sk-…" autocomplete="off">'
      + '<button class="btn btn-default" data-pe-eyes title="显示/隐藏" style="flex:none">' + icon('eye', 15) + '</button></div>'
      + '<div class="form-hint">本地服务（如 Ollama）可留空</div></div>'
      + '<div class="form-group"><label class="form-label">模型列表（每行或逗号分隔）</label>'
      + '<textarea class="form-textarea" data-pe-models rows="5" placeholder="deepseek-chat&#10;deepseek-reasoner">' + MD.escapeHtml((p.models || []).join('\n')) + '</textarea></div>'
      + '<div class="form-group span-all"><label class="form-label">附加请求头（可选，JSON 格式）</label>'
      + '<textarea class="form-textarea kv-input" data-pe-headers rows="2" placeholder=\'{"X-Custom-Header": "value"}\'>' + MD.escapeHtml(JSON.stringify(p.extraHeaders || {}, null, 2)) + '</textarea></div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;padding:14px 0">'
      + '<button class="btn btn-default" data-pe-test>测试连接</button>'
      + '<button class="btn btn-default" data-pe-fetch>获取模型列表</button>'
      + '<button class="btn btn-primary" data-pe-save>保存服务</button>'
      + '</div>';

    box.querySelector('[data-page-back]').addEventListener('click', function () {
      state.settingsTab = 'providers';
      switchView('settings');
    });

    const typeSel = box.querySelector('[data-pe-type]');
    const urlInput = box.querySelector('[data-pe-url]');
    const urlHint = box.querySelector('[data-pe-url-hint]');
    const refreshHint = function () {
      urlHint.textContent = (typeSel.value === 'anthropic' ? '将请求 ' : '将请求 ')
        + (urlInput.value || '…') + (typeSel.value === 'anthropic' ? '/v1/messages' : '/chat/completions');
    };
    typeSel.addEventListener('change', function () {
      editingProvider.type = typeSel.value;
      urlInput.placeholder = typeSel.value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com 或 …/v1';
      refreshHint();
    });
    urlInput.addEventListener('input', refreshHint);
    box.querySelector('[data-pe-eyes]').addEventListener('click', function () {
      const k = box.querySelector('[data-pe-key]');
      k.type = k.type === 'password' ? 'text' : 'password';
    });

    const collect = function () {
      let headers = {};
      const hv = box.querySelector('[data-pe-headers]').value.trim();
      if (hv) {
        try { headers = JSON.parse(hv); } catch (e) { toast('附加请求头不是合法 JSON', 'error'); return null; }
      }
      const models = box.querySelector('[data-pe-models]').value.split(/[\n,]/)
        .map(function (s) { return s.trim(); }).filter(Boolean);
      editingProvider.name = box.querySelector('[data-pe-name]').value.trim() || '未命名服务';
      editingProvider.type = typeSel.value;
      editingProvider.baseUrl = urlInput.value.trim();
      editingProvider.apiKey = box.querySelector('[data-pe-key]').value.trim();
      editingProvider.extraHeaders = headers;
      editingProvider.models = models;
      if (!editingProvider.baseUrl) { toast('请填写 Base URL', 'error'); return null; }
      return editingProvider;
    };

    box.querySelector('[data-pe-test]').addEventListener('click', async function () {
      const pv = collect();
      if (!pv) return;
      const btn = box.querySelector('[data-pe-test]');
      btn.disabled = true;
      btn.textContent = '测试中…';
      try {
        const r = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: pv }) });
        if (r.ok) toast('连接成功：发现 ' + r.modelCount + ' 个模型', 'success');
        else toast('连接失败：' + r.error, 'error');
      } catch (e) {
        toast('连接失败：' + e.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = '测试连接';
    });

    box.querySelector('[data-pe-fetch]').addEventListener('click', async function () {
      const pv = collect();
      if (!pv) return;
      const btn = box.querySelector('[data-pe-fetch]');
      btn.disabled = true;
      btn.textContent = '获取中…';
      try {
        let models = null;
        if (!isNew && state.config.providers.some(function (x) { return x.id === pv.id; })) {
          const r = await api('/api/providers/' + pv.id + '/models');
          models = r.models;
        } else {
          const r = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: pv }) });
          if (!r.ok) throw new Error(r.error);
          models = r.models || [];
        }
        box.querySelector('[data-pe-models]').value = models.join('\n');
        toast('获取到 ' + models.length + ' 个模型', 'success');
      } catch (e) {
        toast('获取失败：' + e.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = '获取模型列表';
    });

    box.querySelector('[data-pe-save]').addEventListener('click', async function () {
      const pv = collect();
      if (!pv) return;
      const idx = state.config.providers.findIndex(function (x) { return x.id === pv.id; });
      if (idx >= 0) state.config.providers[idx] = pv;
      else state.config.providers.push(pv);
      if (!state.config.defaultProviderId) state.config.defaultProviderId = pv.id;
      await saveConfig();
      state.settingsTab = 'providers';
      switchView('settings');
      renderHeader();
      updateComposer();
      toast('已保存模型服务「' + pv.name + '」', 'success');
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    // 侧边栏
    $('#btn-new-chat').addEventListener('click', function () {
      createConversation().catch(function (e) { toast(e.message, 'error'); });
    });
    $('#btn-collapse').addEventListener('click', function () {
      document.body.classList.add('sidebar-hidden');
      localStorage.setItem('sidebarHidden', '1');
    });
    $('#btn-expand').addEventListener('click', function () {
      document.body.classList.remove('sidebar-hidden');
      localStorage.setItem('sidebarHidden', '0');
    });
    $$('.sb-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.tab = btn.getAttribute('data-tab');
        $$('.sb-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
        renderList();
      });
    });
    const searchInput = $('#input-search');
    searchInput.addEventListener('input', debounce(function () {
      state.query = searchInput.value.trim();
      renderList();
    }, 250));

    $('#conv-list').addEventListener('click', function (e) {
      // 文件夹折叠 / 文件夹菜单
      const fmenu = e.target.closest('[data-folder-menu]');
      if (fmenu) {
        e.stopPropagation();
        const fid = fmenu.getAttribute('data-folder-menu');
        const f = state.folders.find(function (x) { return x.id === fid; });
        if (!f) return;
        openMenu(fmenu, [
          { label: '重命名…', icon: 'edit', onClick: async function () {
            const name = await promptModal({ title: '重命名文件夹', label: '文件夹名', value: f.name });
            if (!name || !name.trim()) return;
            try {
              await api('/api/folders/' + fid, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
              await refreshList();
            } catch (err) { toast(err.message || '重命名失败', 'error'); }
          } },
          { label: '删除文件夹（对话保留为未分类）', icon: 'trash', danger: true, onClick: function () {
            confirmModal({ title: '删除文件夹', message: '删除「' + f.name + '」？里面的对话不会被删除，会回到「未分类」。', okText: '删除', danger: true })
              .then(async function (ok) {
                if (!ok) return;
                await api('/api/folders/' + fid, { method: 'DELETE' });
                await refreshList();
                toast('已删除文件夹', 'success');
              });
          } }
        ]);
        return;
      }
      const ftoggle = e.target.closest('[data-folder-toggle]');
      if (ftoggle) {
        const fid = ftoggle.getAttribute('data-folder-toggle');
        state.collapsed[fid] = !state.collapsed[fid];
        saveCollapsed();
        renderList();
        return;
      }
      const actionBtn = e.target.closest('[data-act]');
      if (actionBtn) {
        e.stopPropagation();
        listItemAction(actionBtn.getAttribute('data-act'), actionBtn.getAttribute('data-id'));
        return;
      }
      const item = e.target.closest('.conv-item');
      if (item) {
        const id = item.getAttribute('data-id');
        // 多选模式下点条目 = 勾选/取消，而不是打开会话（否则一边选一边跳走，很难用）
        if (state.sel.on) { selToggle(id); return; }
        openConversation(id).catch(function (err) { toast(err.message, 'error'); });
      }
    });

    // 多选开关 + 批量操作条
    $('#btn-multiselect').addEventListener('click', function () {
      state.sel.on = !state.sel.on;
      if (!state.sel.on) selClear();
      renderList();
    });
    $('#btn-new-folder').addEventListener('click', async function () {
      const name = await promptModal({ title: '新建文件夹', label: '文件夹名', placeholder: '例如：线段树 / 我的弱项' });
      if (!name || !name.trim()) return;
      try {
        await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
        await refreshList();
        toast('已新建文件夹', 'success');
      } catch (e) { toast(e.message || '新建失败', 'error'); }
    });
    $('#sb-bulk').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-bulk]');
      if (!btn) return;
      const act = btn.getAttribute('data-bulk');
      if (act === 'exit') { selExit(); return; }
      if (act === 'all') {
        // 全选**当前可见**的对话（跟搜索/标签页一致，不会把看不到的也选进来）
        const visible = state.convs.filter(function (c) { return c.archived === (state.tab === 'archive'); })
          .filter(function (c) {
            if (!state.query) return true;
            const q = state.query.toLowerCase();
            return (c.title + ' ' + c.preview).toLowerCase().indexOf(q) >= 0;
          }).map(function (c) { return c.id; });
        const allPicked = visible.length && visible.every(selHas);
        state.sel.ids = allPicked ? [] : visible;
        renderList();
        return;
      }
      if (act === 'move') { openFolderMenu(btn, state.sel.ids); return; }
      if (act === 'delete') { confirmBatchDelete(state.sel.ids); return; }
      if (act === 'archive') { batchOp('archive', state.sel.ids); return; }
    });

    // 主题 / 页面导航（再次点击当前页面按钮 → 返回教练视图）
    $('#btn-theme').addEventListener('click', cycleTheme);
    $('#btn-settings').addEventListener('click', function () {
      if (state.view === 'settings') switchView('coach');
      else { state.settingsTab = state.settingsTab || 'general'; switchView('settings'); }
    });
    $('#btn-library').addEventListener('click', function () {
      switchView(state.view === 'library' ? 'coach' : 'library');
    });
    $('#btn-profile').addEventListener('click', function () {
      switchView(state.view === 'profile' ? 'coach' : 'profile');
    });

    // 题目面板 / 富讲解
    $('#btn-pp-refresh').addEventListener('click', function () {
      const conv = state.conv;
      if (!conv) { renderProblemPanel(); return; }
      api('/api/conversations/' + conv.id).then(function (c) {
        if (state.conv && state.conv.id === conv.id) {
          state.conv = c;
          renderProblemPanel();
          renderHeader();
        }
      }).catch(function (e) { toast(e.message, 'error'); });
    });
    initTooltips();
    MD.bindVizClicks(document);

    // 题目库页面：筛选与打开
    const libPage = $('#page-library');
    if (libPage) {
      const syncFilters = function () {
        state.libFilter.knowledge = libPage.querySelector('[data-lib-knowledge]').value;
        state.libFilter.rating = libPage.querySelector('[data-lib-rating]').value;
        state.libFilter.contest = libPage.querySelector('[data-lib-contest]').value;
        state.libFilter.search = libPage.querySelector('[data-lib-search]').value.trim();
        renderLibraryPage();
      };
      libPage.addEventListener('change', syncFilters);
      libPage.querySelector('[data-lib-search]').addEventListener('input', debounce(syncFilters, 250));
      libPage.addEventListener('click', function (e) {
        const card = e.target.closest('[data-lib-open]');
        if (card) {
          switchView('coach');
          openConversation(card.getAttribute('data-lib-open')).catch(function (err) { toast(err.message, 'error'); });
        }
      });
    }

    // 头部
    $('#btn-conv-menu').addEventListener('click', function (e) { openConvMenu(e.currentTarget); });
    // 最小化到托盘（仅桌面版；web 模式下按钮会被移除，所以必须先判空——
    // 否则 boot() 会在 bindEvents 里抛异常，整个界面停在空聊天页）
    const trayBtn0 = $('#btn-tray');
    if (trayBtn0) {
      trayBtn0.addEventListener('click', function () {
        if (window.chatbox) window.chatbox.hideToTray();
      });
    }

    // 聊天区事件委托
    $('#chat-view').addEventListener('click', function (e) {
      // 欢迎页 / 空会话 CTA
      if (e.target.closest('[data-act-welcome-start]') || e.target.closest('[data-act-empty-cf]')) {
        const ensure = async function () {
          if (!state.conv || state.conv.messages.length) await createConversation();
          openCfImport();
        };
        ensure().catch(function (err) { toast(err.message, 'error'); });
        return;
      }
      if (e.target.closest('[data-act-welcome-profile]')) {
        switchView('profile');
        return;
      }
      const tool = e.target.closest('[data-act]');
      if (tool) {
        chatAction(tool.getAttribute('data-act'), tool.getAttribute('data-id'));
        return;
      }
      const img = e.target.closest('[data-img-viewer]');
      if (img) {
        const viewer = document.createElement('div');
        viewer.className = 'img-viewer';
        viewer.innerHTML = '<img src="' + img.getAttribute('src') + '" alt="">';
        document.body.appendChild(viewer);
        viewer.addEventListener('click', function () { viewer.remove(); });
        return;
      }
      // 代码复制
      const copyBtn = e.target.closest('[data-code-copy]');
      if (copyBtn) {
        const wrap = copyBtn.closest('.code-wrap');
        const code = wrap ? wrap.querySelector('code').textContent : '';
        navigator.clipboard.writeText(code).then(function () {
          copyBtn.textContent = '已复制 ✓';
          setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
        });
        return;
      }
    });

    // 输入框
    const input = $('#input');
    input.addEventListener('input', function () {
      scheduleAutosize();
      updateComposer();
    });
    /**
     * 多绑几个事件是有意的：拖入文本（drop）、鼠标右键粘贴、输入法上屏…
     * 都不保证走 input。真实反馈"粘贴之后框子还是一行"就是这么来的。
     * 加上 field-sizing 兜底后，即便这些事件全都不触发，框子也会跟着内容长。
     */
    ['change', 'paste', 'drop', 'cut'].forEach(function (ev) {
      input.addEventListener(ev, function () { scheduleAutosize(); });
    });
    window.addEventListener('resize', function () { autosizeInput(); });
    input.addEventListener('keydown', function (e) {
      const isEnter = e.key === 'Enter';
      if (!isEnter) return;
      const shortcut = state.config.sendShortcut === 'ctrlenter';
      const shouldSend = shortcut ? (e.ctrlKey || e.metaKey) : !e.shiftKey;
      if (shouldSend) {
        e.preventDefault();
        sendCurrentMessage();
      }
    });
    $('#btn-send').addEventListener('click', sendCurrentMessage);
    $('#btn-lang-select').addEventListener('click', function (e) { openLangMenu(e.currentTarget); });
    $('#btn-cf-import').addEventListener('click', openCfImport);
    $('#btn-intent-select').addEventListener('click', function (e) { openIntentMenu(e.currentTarget); });
    $('#btn-cancel-edit').addEventListener('click', function () {
      clearEditChip();
      toast('已取消编辑', 'info', 1500);
    });

    // 模型选择
    $('#btn-model-select').addEventListener('click', function (e) { openModelMenu(e.currentTarget); });

    // 滚动
    const sc = $('#chat-scroll');
    sc.addEventListener('scroll', function () {
      const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
      $('#btn-scroll-bottom').hidden = near;
    });
    $('#btn-scroll-bottom').addEventListener('click', function () { scrollBottom(true); });

    // 全局按键：Esc 逐层关闭弹窗（先关最上层，回到上一级）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeMenu();
        if (modalStack.length) closeTopModal();
      }
    });

    // 系统主题跟随
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (state.config && state.config.theme === 'auto') applyTheme();
      });
    }
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    try {
      await loadConfig();
      applyTheme();
      applyAppearance();
      if (localStorage.getItem('sidebarHidden') === '1') {
        document.body.classList.add('sidebar-hidden');
      }
      // 托盘按钮仅桌面版显示（Electron preload 提供桥接），web 模式移除；
      // 必须在 bindEvents 之后移除：bindEvents 里绑过这个按钮，先移除会让它拿到 null
      bindEvents();
      if (window.chatbox && window.chatbox.hideToTray) {
        const trayBtn = $('#btn-tray');
        if (trayBtn) trayBtn.hidden = false;
      } else {
        const trayBtn = $('#btn-tray');
        if (trayBtn) trayBtn.remove();
      }
      await refreshList();
      updateComposer();

      if (!state.config.providers.length) {
        toast('尚未配置模型服务：点击左下角「设置」添加（支持任意 OpenAI 兼容 / Anthropic API）', 'info', 6000);
      }

      const lastId = localStorage.getItem('lastConvId');
      const hashId = (location.hash.match(/^#\/c\/([a-zA-Z0-9_\-]+)/) || [])[1];
      const openId = hashId || lastId;
      if (openId) {
        try {
          await openConversation(openId);
          return;
        } catch (e) { /* 会话可能已被删除 */ }
      }
      renderHeader();
      renderMessages();
    } catch (e) {
      toast('初始化失败：' + e.message, 'error');
      console.error(e);
    }
  }

  boot();
})();
