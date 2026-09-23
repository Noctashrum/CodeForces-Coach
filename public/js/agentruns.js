/* ============================================================
 * agentruns.js — Agent 工作台的运行记录（纯函数，便于单测）
 *
 * 为什么单独成文件：题解 / 暴力 / 生成器是**并发**跑的，谁先结束不确定。
 * 如果按"最后一个还在跑的条目"来匹配事件，A 的结束会被算到 B 头上——
 * 界面上就表现为"两个 Agent 显示 0 秒完成、其实还在等另一个"，看起来像并行没生效。
 * 所以这里按 **(role, label) 精确匹配**，并且只关掉"同一个角色的上一次"。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentRuns = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 找到该事件对应的运行记录：优先"同角色同标签且仍在跑"，其次"同角色" */
  function find(list, role, label) {
    const arr = list || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === role && arr[i].open && (!label || arr[i].label === label)) return arr[i];
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === role) return arr[i];
    }
    return null;
  }

  /** 新一次调用开始：只关掉**同角色**的上一次（并发时其他角色要继续跑） */
  function start(list, ev, now) {
    const arr = list || [];
    arr.forEach(function (r) { if (r.role === ev.role && r.open) r.open = false; });
    arr.push({
      role: ev.role, label: ev.label || ev.role, text: '', reasoning: '',
      at: now || Date.now(), open: true, model: ev.model || ''
    });
    if (arr.length > 12) arr.shift();
    return arr;
  }

  /** 增量（正文 / 思考）落到对应角色的那条记录上 */
  function append(list, ev) {
    const arr = list || [];
    let run = find(arr, ev.role, ev.label);
    if (!run) {
      run = { role: ev.role, label: ev.label || ev.role, text: '', reasoning: '', at: Date.now(), open: true };
      arr.push(run);
    }
    if (ev.type === 'agentDelta') run.text += ev.text;
    else run.reasoning += ev.text;
    return run;
  }

  /** 结束：按角色收尾（并发下不能按"最后一个 open"） */
  function end(list, ev) {
    const run = find(list || [], ev.role, ev.label);
    if (run) {
      run.open = false;
      run.ms = ev.ms;
      run.ok = ev.ok;
      if (ev.error) run.error = ev.error;
    }
    return run;
  }

  /** 全部收尾（流结束时调用）。补上真实耗时：
   *  没等到 agentEnd 就被收尾的运行（例如用户中途停止）如果不补，界面会显示"0s 完成"，看起来像瞬间跑完。
   *  同时标记 interrupted：用户点停止不是"这个 Agent 失败了"，界面要如实区分。 */
  function closeAll(list, role, now) {
    const ts = now || Date.now();
    (list || []).forEach(function (r) {
      if (role && r.role !== role) return;
      if (r.open) {
        r.open = false;
        if (r.ms == null) r.ms = Math.max(0, ts - r.at);
        if (r.ok == null) r.ok = false;
        r.interrupted = true;
      }
    });
  }

  return { find: find, start: start, append: append, end: end, closeAll: closeAll };
});
