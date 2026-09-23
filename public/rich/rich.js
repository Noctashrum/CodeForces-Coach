/* ==========================================================================
   CF Coach · 图文讲解交互运行时（rich.js）
   无依赖 · 渐进增强：脚本不生效时页面依然完整可读。
   交互：序列点亮 / 柱状生长 / 分步滑块 / 高亮漫游（渐进增强，脚本不生效也能读）。
   运行在 iframe（sandbox="allow-scripts"，无 same-origin）里，
   所以最后会把文档高度 postMessage 给宿主，让 iframe 自适应高度。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 阅读进度条 ---------------- */
  var bar = document.getElementById('progress');
  var wrap = document.querySelector('.wrap');
  function onScroll() {
    if (!bar) return;
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 8 ? (h.scrollTop || document.body.scrollTop) / max : 1;
    bar.style.width = Math.min(100, Math.max(0, p * 100)) + '%';
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------------- 自测题展开 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.quiz .q > .qh'), function (h) {
    h.addEventListener('click', function () { h.parentNode.classList.toggle('open'); });
  });

  /* ---------------- A. 序列点亮 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-anim="sequence"]'), function (box) {
    var toks = Array.prototype.slice.call(box.querySelectorAll('.tok'));
    var btn = box.querySelector('button.ctl');
    var reset = box.querySelector('button.ghost');
    var timer = null;
    function clearAll() {
      if (timer) { clearTimeout(timer); timer = null; }
      toks.forEach(function (t) { t.classList.remove('on'); });
    }
    function play() {
      clearAll();
      var i = 0;
      (function next() {
        if (i >= toks.length) return;
        toks[i].classList.add('on');
        i++;
        timer = setTimeout(next, 420);
      })();
    }
    if (btn) btn.addEventListener('click', play);
    if (reset) reset.addEventListener('click', clearAll);
  });

  /* ---------------- B. 柱状图生长 ---------------- */
  function growBars(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.bar'), function (b) {
      var h = parseFloat(b.getAttribute('data-h') || '0');
      b.style.height = '0%';
      requestAnimationFrame(function () {
        setTimeout(function () { b.style.height = h + '%'; }, 60);
      });
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-anim="bars"]'), function (box) {
    var btn = box.querySelector('button.ctl');
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { growBars(box); io.disconnect(); } });
      }, { threshold: 0.3 });
      io.observe(box);
    } else { growBars(box); }
    if (btn) btn.addEventListener('click', function () { growBars(box); });
  });

  /* ---------------- C. 分步滑块 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.slider-steps'), function (box) {
    var panes = Array.prototype.slice.call(box.querySelectorAll('.pane'));
    if (!panes.length) return;
    var nav = box.querySelector('.slider-nav');
    var idx = 0;
    var dots = [];
    var posEl = nav ? nav.querySelector('.pos') : null;
    if (nav) {
      var prev = document.createElement('button');
      prev.className = 'ctl ghost'; prev.type = 'button'; prev.textContent = '← 上一步';
      var next = document.createElement('button');
      next.className = 'ctl'; next.type = 'button'; next.textContent = '下一步 →';
      var dotWrap = document.createElement('span');
      dotWrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
      panes.forEach(function (_, i) {
        var d = document.createElement('button');
        d.className = 'dot'; d.type = 'button';
        d.setAttribute('aria-label', '第 ' + (i + 1) + ' 步');
        d.addEventListener('click', function () { show(i); });
        dotWrap.appendChild(d);
        dots.push(d);
      });
      nav.insertBefore(prev, nav.firstChild);
      nav.appendChild(dotWrap);
      nav.appendChild(next);
      if (posEl) nav.appendChild(posEl);
      prev.addEventListener('click', function () { show(idx - 1); });
      next.addEventListener('click', function () { show(idx + 1); });
    }
    function show(i) {
      idx = (i + panes.length) % panes.length;
      panes.forEach(function (p, k) { p.classList.toggle('on', k === idx); });
      dots.forEach(function (d, k) { d.classList.toggle('on', k === idx); });
      if (posEl) posEl.textContent = (idx + 1) + ' / ' + panes.length;
    }
    show(0);
  });

  /* ---------------- D. 高亮漫游 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-anim="roam"]'), function (box) {
    var marks = Array.prototype.slice.call(box.querySelectorAll('mark'));
    var note = box.querySelector('.note');
    var btn = box.querySelector('button.ctl');
    if (!marks.length) return;
    var i = 0, auto = null;
    function step() {
      marks.forEach(function (m) { m.classList.remove('on'); });
      var m = marks[i % marks.length];
      m.classList.add('on');
      if (note) note.innerHTML = '<b>第 ' + ((i % marks.length) + 1) + ' 处：</b>' + (m.getAttribute('data-note') || m.textContent);
      i++;
    }
    if (btn) btn.addEventListener('click', step);
    marks.forEach(function (m, k) {
      m.addEventListener('click', function () { i = k; step(); i = k + 1; });
    });
    step();
    box.addEventListener('mouseenter', function () { if (auto) { clearInterval(auto); auto = null; } });
    box.addEventListener('mouseleave', function () { if (!auto) auto = setInterval(step, 3400); });
    auto = setInterval(step, 3400);
  });

  /* ---------------- 术语提示 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.term[data-tip]'), function (el) {
    el.setAttribute('title', el.getAttribute('data-tip'));
  });

  /* ---------------- 高度自适应：把文档高度报给宿主 ---------------- */
  function reportHeight() {
    try {
      var h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      parent.postMessage({ __richdoc: true, height: h }, '*');
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('load', reportHeight);
  if ('ResizeObserver' in window) {
    try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) { /* ignore */ }
  }
  /* 交互组件会改变高度：动画/展开后补报几次 */
  [120, 400, 900, 1800].forEach(function (t) { setTimeout(reportHeight, t); });
  document.addEventListener('click', function () { setTimeout(reportHeight, 120); });
  onScroll();
  reportHeight();
})();
