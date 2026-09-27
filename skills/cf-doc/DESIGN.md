# cf-coach 文档设计系统（HTML 正文片段规范）

`cf_doc` 产出的文档是**一个自包含的 HTML 正文片段**，由应用内置的设计系统提供样式与交互（CSP 沙箱 iframe 渲染，不允许外部资源）。

## 硬性规则（校验器会挡）

1. 只提交**正文片段**：不要 `<!DOCTYPE>` / `<html>` / `<head>`，不要 `<style>` / `<script>` / `<link>` / `<iframe>`。
2. 不允许外部 URL（`src`/`href` 指向站外）、不允许 `javascript:`、不允许内联事件属性（`onclick` 等）。
3. 标签必须正确配对、正确嵌套，且**必须以闭合标签正常收尾**（半份文档等于白写）。
4. 只用下面列出的 class。自造的 class 不会有样式。
5. 公式用 HTML 排版，**不要** MathJax / LaTeX（`$x$`、`\le` 之类不会被渲染）。
6. 交互演示的控件写成 `<button class="ctl" type="button">`，交互行为由内置运行时按 `data-anim` 接管。

## 骨架（推荐，不是强制）

```html
<div class="wrap">
  <div class="hero">
    <span class="kicker">CF 1800C · 贪心 + 堆</span>
    <h1>一句话标题（题目名或核心观察）</h1>
    <p class="subtitle">这题在考什么，一句话。</p>
    <div class="meta"><span>🏷 <b>标签</b>：greedy, heap</span><span>⏱ <b>复杂度</b>：O(n log n)</span></div>
    <div class="oneliner"><b>一句话总结：</b>……</div>
  </div>
  <section class="chapter" id="c1"><h2><span class="num">1</span>标题</h2><p class="lead">本章讲什么</p>……</section>
  <!-- 需要几章写几章 -->
  <div class="footer">验证：官方样例通过 · 随机对拍 N 组一致</div>
</div>
```

**章节数量跟着内容走**：内容需要几节就写几节。不要为了凑数把一句话拆成三章，也不要因为"模板有 5 章"就硬造章节。

## 组件

| 用途 | 写法 |
|---|---|
| 提示框 | `<div class="callout key\|tip\|warn\|danger\|analogy\|quote"><span class="ttl">标题</span>正文</div>` |
| 卡片 / 网格 | `<div class="card"><h4>…</h4><p>…</p></div>`；`<div class="grid g2\|g3\|g4"><div class="mini"><h5><span class="ico">①</span>要点</h5><p>说明</p></div>…</div>` |
| SVG 图解 | `<figure class="diagram"><svg viewBox="0 0 760 240" role="img" aria-label="说明">…</svg><figcaption><b>图 1</b>｜这张图在讲什么</figcaption></figure>` |
| 步骤流程 | `<div class="flow"><div class="step"><span class="n">1</span><h6>输入</h6><p>说明</p></div><div class="arrow">→</div>…</div>` |
| 方案对比 | `<div class="compare"><div class="side a"><h5>✅ 优点</h5><ul><li>…</li></ul></div><div class="side b"><h5>❌ 代价</h5><ul><li>…</li></ul></div></div>` |
| 数据表 | `<div class="table-wrap"><table class="data"><caption>表 1｜…</caption><thead><tr><th>…</th><th class="num">值</th></tr></thead><tbody><tr><td>…</td><td class="num best">…</td></tr></tbody></table></div>` |
| 公式 | `<div class="formula"><div class="fx">f(s) = <span class="var">Σ</span> …</div><div class="legend"><dl><dt>n</dt><dd>含义</dd></dl></div><div class="why"><b>它在说什么：</b>大白话翻译 + 一个具体数字的例子</div></div>` |
| 分步讲解 | `<ol class="steps"><li><h5>第一步</h5><p>说明</p></li>…</ol>` |
| 代码 | `<pre class="code">…</pre>`，注释 `<span class="cm">…</span>`、关键字 `<span class="kw">…</span>`、关键行 `<span class="hi">…</span>`；HTML 特殊字符必须转义 |
| 行内 | `<span class="hl">高亮</span>`、`<span class="term" data-tip="提示">术语</span>`、`<code>代码</code>`、`<a class="inline" href="#c2">见 2 节</a>` |
| 自测题 | `<div class="quiz"><div class="q"><div class="qh"><span class="idx">1</span>问题？</div><div class="qa"><p class="ans">答案</p><p>为什么</p></div></div>…</div>` |
| 术语表 | `<div class="glossary"><dl><dt>术语</dt><dd class="g">解释</dd></dl></div>` |

## SVG 配色与注意点

- 配色：蓝 `#e8f0ff/#2f6fed/#1b4fc0`（输入）、紫 `#f0ebff/#7b5cf0/#5b3fd0`（核心）、绿 `#e3f7f0/#12a075/#0a7a58`（输出/正确）、橙 `#fff5e0/#e08a00/#a86500`（注意）、红 `#ffe9ed/#e0455f/#b8273f`（错误）、青 `#e2f6fb/#0f97b8/#0b6f88`（数据）、中性 `#f3f5fa/#dfe6f2/#3c4a6b`。
- 箭头：先在 `<defs>` 里定义 marker，再 `<line … marker-end="url(#ar1)"/>`；同页多图时 id 用 `ar1`/`ar2`… 不要重复。
- **所有 `<text>` 的 x/y 必须落在 viewBox 范围内**，否则会被裁掉；文字用 `text-anchor="middle"` 居中，字号 11–16。

## 交互演示（想用再用，不是必须）

| 类型 | 写法 |
|---|---|
| A. 序列点亮（模拟扫描/入堆/逐个输出） | `<div class="anim-box" data-anim="sequence"><div class="head"><h5>演示：扫描顺序</h5><span><button class="ctl" type="button">▶ 播放</button><button class="ctl ghost" type="button">重置</button></span></div><div class="tokens"><span class="tok">3</span><span class="tok alt">2</span>…</div></div>` |
| B. 柱状图生长（对比复杂度/不同做法） | `<div class="anim-box" data-anim="bars"><div class="head"><h5>…</h5><button class="ctl" type="button">↻ 重播</button></div><div class="bars"><div class="bar-item"><div class="bar" data-h="93"><span>O(n log n)</span></div><div class="cap">堆</div></div>…</div></div>` |
| C. 分步滑块（多步算法，一屏一步） | `<div class="anim-box slider-steps"><div class="head"><h5>…</h5></div><div class="pane on"><h4>第 1 步</h4><p>…</p></div><div class="pane"><h4>第 2 步</h4><p>…</p></div><div class="slider-nav"><span class="pos"></span></div></div>` |
| D. 高亮漫游（逐句读关键推导） | `<div class="anim-box" data-anim="roam"><div class="head"><h5>逐句看</h5><button class="ctl" type="button">下一处 →</button></div><p>…<mark data-note="这里的意思是……">关键句</mark>…</p><div class="note"></div></div>` |

**只在它真的能帮助理解时才加**。一张没有信息量的 SVG 比没有图更糟——它会让学员以为看懂了。
