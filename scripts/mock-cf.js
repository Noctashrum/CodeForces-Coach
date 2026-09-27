/**
 * mock-cf.js — Codeforces 模拟服务（离线测试用，端口 3998）
 * 提供：题面网页（含 $$$ 公式与样例）、contest.standings 元数据、user.info 用户信息
 * 用法：设置 CF_BASE=http://127.0.0.1:3998 后启动 server.js
 */
'use strict';
const http = require('http');
const PORT = parseInt(process.env.PORT || '3998', 10);

const PROBLEM_HTML = `<!DOCTYPE html>
<html><head><title>Problem - 1800C - Codeforces</title>
<script>MathJax = { tex: { inlineMath: [['$$$','$$$']], displayMath: [['$$$$$','$$$$$']] } };</script>
</head><body>
<div class="problem-statement">
  <div class="header">
    <div class="title">C. Powering the Hero (hard version)</div>
    <div class="time-limit"><div class="property-title">time limit per test</div>2 seconds</div>
    <div class="memory-limit"><div class="property-title">memory limit per test</div>256 megabytes</div>
    <div class="input-file"><div class="property-title">input</div>standard input</div>
    <div class="output-file"><div class="property-title">output</div>standard output</div>
  </div>
  <div><p>There are $$$n$$$ cards in a deck, each card has a power, the power is a non-negative integer. A hero can be enhanced with a card of positive power. You can do operations until the deck is empty:</p>
<p>Choose a hero card with power $$$0$$$ and take the top card with the maximum power from the bonus deck.</p>
<p>What is the maximum possible total power of the heroes?</p></div>
  <div class="input-specification"><div class="section-title">Input</div>
<p>The first line contains one integer $$$t$$$ ($$$1 \\le t \\le 10^4$$$) — the number of test cases.</p>
<p>The second line contains one integer $$$n$$$ ($$$1 \\le n \\le 2 \\cdot 10^5$$$).</p></div>
  <div class="output-specification"><div class="section-title">Output</div>
<p>Print a single integer — the maximum total power.</p></div>
  <div class="sample-tests"><div class="section-title">Example</div>
    <div class="sample-test">
      <div class="input"><div class="title">Input</div><pre>1
5
3 3 3 0 0
</pre></div>
      <div class="output"><div class="title">Output</div><pre>6
</pre></div>
      <div class="input"><div class="title">Input</div><pre>1
3
0 1 2
</pre></div>
      <div class="output"><div class="title">Output</div><pre>0
</pre></div>
    </div>
  </div>
  <div class="note"><div class="section-title">Note</div><p>In the first example, you can take the cards with power $$$3$$$.</p></div>
</div>
</body></html>`;

/**
 * 2264D 的模拟题面：答案是一串长度 n 的 0/1 字符串，官方样例答案是**长字面量**
 * （"010100" 这种）——正是真实事故里被模型硬编码进代码的那份数据。
 */
const PROBLEM_2264D_HTML = `<!DOCTYPE html>
<html><head><title>Problem - 2264D - Codeforces</title></head><body>
<div class="problem-statement">
  <div class="header">
    <div class="title">D. Dark Mode</div>
    <div class="time-limit"><div class="property-title">time limit per test</div>2 seconds</div>
    <div class="memory-limit"><div class="property-title">memory limit per test</div>256 megabytes</div>
  </div>
  <div><p>You are given $$$n$$$. Find a binary string $$$s$$$ of length $$$n$$$ minimizing the number of substrings consisting of equal characters.</p></div>
  <div class="input-specification"><div class="section-title">Input</div>
<p>The first line contains one integer $$$t$$$ ($$$1 \\le t \\le 10^4$$$) — the number of test cases.</p>
<p>Each test case contains one integer $$$n$$$ ($$$1 \\le n \\le 2 \\cdot 10^{5}$$$).</p></div>
  <div class="output-specification"><div class="section-title">Output</div>
<p>For each test case print a binary string of length $$$n$$$.</p></div>
  <div class="sample-tests"><div class="section-title">Example</div>
    <div class="sample-test">
      <div class="input"><div class="title">Input</div><pre>6
1
2
3
4
5
6
</pre></div>
      <div class="output"><div class="title">Output</div><pre>1
11
101
0101
10101
010100
</pre></div>
    </div>
  </div>
</div>
</body></html>`;

const server = http.createServer((req, res) => {  const url = new URL(req.url, 'http://x');
  const sendJson = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    // 题目页的**规范地址**是 /contest/<id>/problem/<idx>（真实 CF 对新旧比赛都成立；
    // /problemset/problem/... 只在题目进了总表之后才有）。两个地址都提供，
    // 夹具才跟真实站点一致 —— 应用现在优先用规范地址。
    if (/^\/contest\/1800\/problem\/C$/.test(url.pathname) || url.pathname === '/problemset/problem/1800/C') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PROBLEM_HTML);
      return;
    }
    // 2264D：答案是一串 0/1（**长字面量**）——复刻真实事故现场的题型，
    // 用来端到端验证"打表（硬编码样例答案）会被机械拦下"这条防线。
    if (/^\/contest\/2264\/problem\/D$/.test(url.pathname) || url.pathname === '/problemset/problem/2264/D') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PROBLEM_2264D_HTML);
      return;
    }
    // 反爬挑战（模拟 Cloudflare 403）
    if (/^\/contest\/999\/problem\/A$/.test(url.pathname) || url.pathname === '/problemset/problem/999/A') {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' });
      res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>');
      return;
    }
    // 被重定向到其它页面（返回别的题目题面）
    if (/^\/contest\/998\/problem\/A$/.test(url.pathname) || url.pathname === '/problemset/problem/998/A') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PROBLEM_HTML.replace('C. Powering the Hero (hard version)', 'A. Another Problem'));
      return;
    }
    // 比赛总表：用来**快速**判断"这个比赛号到底存不存在"（题号写错时不该白等 20 秒）。
    // 7777 故意不存在 → e2e 用它验证"比赛号不存在"能被说清楚。
    if (url.pathname === '/api/contest.list') {
      sendJson({ status: 'OK', result: [{ id: 1800 }, { id: 1799 }, { id: 2264 }, { id: 998 }, { id: 999 }] });
      return;
    }
    // 全量题目总表（元数据主通道：CF 的 contest.standings 对非 gym 已禁止附加参数）
    if (url.pathname === '/api/problemset.problems') {
      sendJson({
        status: 'OK',
        result: {
          problems: [
            { contestId: 1800, index: 'A', name: 'Is It a Cat?', rating: 800, tags: ['implementation', 'strings'] },
            { contestId: 1800, index: 'C', name: 'Powering the Hero (hard version)', rating: 1500, tags: ['data structures', 'greedy', 'sortings'] },
            { contestId: 2264, index: 'D', name: 'D. Dark Mode', rating: 1900, tags: ['constructive algorithms', 'strings'] },
            { contestId: 1799, index: 'C', name: 'Sum on Subarrays', rating: 1500, tags: ['greedy', 'constructive algorithms'] }
          ]
        }
      });
      return;
    }
    // 复刻真实行为：非 gym 比赛的 contest.standings **只接受不含附加参数的匿名请求**；
    // 带 from/count 等参数会被 400 拒掉（匿名、无附加参数的形式是允许的，实测：
    // 真实 CF 的 /api/contest.standings?contestId=1799 能返回该比赛的完整题号表）。
    if (url.pathname === '/api/contest.standings' && url.searchParams.get('contestId') === '1799') {
      const extra = [...url.searchParams.keys()].filter((k) => k !== 'contestId');
      if (extra.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'FAILED', comment: 'contestId: Non-gym contest standings for non-admin users are available only via anonymous GET requests with no extra parameters' }));
        return;
      }
      sendJson({
        status: 'OK',
        result: {
          problems: [{ contestId: 1799, index: 'C', name: 'Sum on Subarrays', rating: 1500, tags: ['greedy', 'constructive algorithms'] }]
        }
      });
      return;
    }
    if (url.pathname === '/api/contest.standings' && url.searchParams.get('contestId') === '1800') {
      sendJson({
        status: 'OK',
        result: {
          problems: [
            { contestId: 1800, index: 'A', name: 'Is It a Cat?', rating: 800, tags: ['implementation', 'strings'] },
            { contestId: 1800, index: 'C', name: 'Powering the Hero (hard version)', rating: 1500, tags: ['data structures', 'greedy', 'sortings'] },
            { contestId: 2264, index: 'D', name: 'D. Dark Mode', rating: 1900, tags: ['constructive algorithms', 'strings'] }
          ]
        }
      });
      return;
    }
    if (url.pathname === '/api/user.info' && url.searchParams.get('handles') === 'tester') {
      sendJson({
        status: 'OK',
        result: [{ handle: 'tester', rating: 1620, rank: 'expert', maxRating: 1685, maxRank: 'expert', contribution: 7 }]
      });
      return;
    }
    if (url.pathname === '/api/user.status' && url.searchParams.get('handle') === 'tester') {
      const problems = [
        { contestId: 1800, index: 'A', name: 'Is It a Cat?', rating: 800, tags: ['implementation', 'strings'] },
        { contestId: 1800, index: 'B', name: 'Count the Number of Pairs', rating: 1000, tags: ['greedy', 'sortings'] },
        { contestId: 1799, index: 'C', name: 'Sum on Subarrays', rating: 1500, tags: ['greedy', 'constructive algorithms'] },
        { contestId: 1798, index: 'D', name: 'Shocking Arrangement', rating: 1600, tags: ['constructive algorithms', 'math'] },
        { contestId: 1797, index: 'C', name: 'Li Hua and Chess', rating: 1500, tags: ['greedy', 'implementation'] }
      ];
      const subs = [];
      let id = 1000;
      problems.forEach((p, i) => {
        // 每题两条提交：一条 WA + 一条 OK
        subs.push({ id: id++, contestId: p.contestId, problem: p, verdict: 'WRONG_ANSWER', programmingLanguage: 'GNU C++17', relativeTimeSeconds: 3600 * (i + 1) });
        subs.push({ id: id++, contestId: p.contestId, problem: p, verdict: 'OK', programmingLanguage: 'GNU C++17', relativeTimeSeconds: 3600 * (i + 1) - 120 });
      });
      sendJson({ status: 'OK', result: subs });
      return;
    }
    if (url.pathname === '/api/user.rating' && url.searchParams.get('handle') === 'tester') {
      const base = Date.now() / 1000 - 6 * 86400;
      const series = [1420, 1480, 1450, 1540, 1580, 1620];
      sendJson({
        status: 'OK',
        result: series.map((newRating, i) => ({
          contestId: 1900 + i,
          contestName: 'Codeforces Round #' + (900 + i) + ' (Div. 2)',
          rank: 3000 - i * 200,
          oldRating: i === 0 ? 1350 : series[i - 1],
          newRating,
          ratingUpdateTimeSeconds: Math.floor(base + i * 86400)
        }))
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock-cf: not found ' + url.pathname }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock-cf] listening on http://127.0.0.1:' + PORT);
});
