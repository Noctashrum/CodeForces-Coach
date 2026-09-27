/**
 * cfreview.js — 赛后复盘的数据层（零依赖）。
 *
 * 为什么单独一个模块：复盘的数据来源与"取题面"完全不同，混进 cf.js 会让两件事互相牵制。
 *
 * 【两条通道，各自的真相】（已实测确认，见 .probe/codeforces-submission-research.md）
 *  ① **官方 API（`/api/user.status`）不受 Cloudflare 影响**——提交的 id / 题目 / 判定 /
 *     语言 / 用时 / 内存 / 通过测试点数 / 提交时刻，全部从这里拿，精确、免费、无风险。
 *     ⚠ API **不包含源码**（字段就 13 个，没有 source/code），所以：
 *  ② **源码只能从网页取**，而所有 HTML 路径都是 `403 + cf-mitigated: challenge`，
 *     只有真实非无头 Chromium 能过（无头会被识破）。这条通道由 Electron 主进程提供
 *     （`electron/main.js` 里的 `fetchSubmissionSource`），浏览器不可用时如实告知用户"请把代码粘给我"。
 *
 * 另外几条实测得来的坑（都写进代码里了）：
 *  - `relativeTimeSeconds === 2147483647` 表示**练习提交**（不在比赛中），不是"很晚才交"；
 *  - `points` 不在提交对象上，而在嵌套的 `problem` 里；
 *  - 不存在的提交页会 **302 跳回首页**，必须当成"取不到"而不是把首页当数据；
 *  - CF 建议请求间隔 ≥2 秒，我们串行化并留 2.2 秒。
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const CF_BASE = (process.env.CF_BASE || 'https://codeforces.com').replace(/\/+$/, '');
const PRACTICE_RELATIVE = 2147483647;   // INT32_MAX：练习/赛后提交
const API_MIN_GAP_MS = 2200;            // CF 建议 ≤1 请求 / 2 秒
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let lastApiAt = 0;

/** 题解缓存目录（data/ 下；server.js 启动时注入，未注入则不缓存） */
let CACHE_DIR = null;
function setCacheDir(dir) { CACHE_DIR = dir || null; }

function readCacheJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeCacheJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/* ---------------- 基础 ---------------- */

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity' },
      timeout: timeoutMs || 20000
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('Codeforces API 返回 HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Codeforces API 返回了无法解析的内容')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function validateHandle(handle) {
  const h = String(handle || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(h)) throw new Error('Codeforces 用户名格式不正确：' + h);
  return h;
}

/** 串行化 + 限速：CF 明确要求不要频繁请求 */
async function apiGet(pathAndQuery) {
  const wait = API_MIN_GAP_MS - (Date.now() - lastApiAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastApiAt = Date.now();
  const j = await getJson(CF_BASE + '/api/' + pathAndQuery);
  if (j && j.status === 'FAILED') throw new Error('Codeforces API 报错：' + (j.comment || '未知原因'));
  return (j && j.result) || [];
}

/* ---------------- 提交记录 ---------------- */

/** 归一化一条提交（只留复盘用得上的字段，避免把 13 个字段全灌进模型上下文） */
function normalize(s) {
  const pr = s.problem || {};
  return {
    id: s.id,
    contestId: s.contestId,
    index: pr.index || '',
    problemName: pr.name || '',
    rating: pr.rating || null,
    tags: pr.tags || [],
    verdict: s.verdict || 'UNKNOWN',
    passedTestCount: s.passedTestCount != null ? s.passedTestCount : null,
    timeMs: s.timeConsumedMillis != null ? s.timeConsumedMillis : null,
    memoryKb: s.memoryConsumedBytes != null ? Math.round(s.memoryConsumedBytes / 1024) : null,
    lang: s.programmingLanguage || '',
    at: s.creationTimeSeconds ? s.creationTimeSeconds * 1000 : null,
    inContest: s.relativeTimeSeconds !== PRACTICE_RELATIVE,
    participantType: (s.author && s.author.participantType) || '',
    testset: s.testset || ''
  };
}

/**
 * 拉取提交记录。默认一次拉 10000 条（CF 的上限），够覆盖最近几十场比赛，
 * 比"反复小额分页"更省请求（限速规则下请求次数就是成本）。
 */
async function fetchSubmissions(o) {
  const handle = validateHandle(o.handle);
  const count = Math.min(Math.max(parseInt(o.count, 10) || 10000, 1), 10000);
  const from = Math.max(parseInt(o.from, 10) || 1, 1);
  const raw = await apiGet('user.status?handle=' + encodeURIComponent(handle) + '&from=' + from + '&count=' + count);
  let list = raw.map(normalize);
  if (o.contestId) {
    const cid = String(o.contestId);
    list = list.filter((s) => String(s.contestId) === cid);
  }
  if (o.onlyContest) list = list.filter((s) => s.inContest);
  return { handle, total: raw.length, list };
}

/** 逐题汇总（同一题的多次提交合并成一条"这题发生了什么"） */
function summarizeByProblem(list) {
  const map = new Map();
  for (const s of list) {
    const key = s.contestId + ':' + s.index;
    let e = map.get(key);
    if (!e) {
      e = {
        contestId: s.contestId, index: s.index, problemName: s.problemName, rating: s.rating, tags: s.tags,
        attempts: 0, verdicts: [], firstAt: s.at, lastAt: s.at, solved: false,
        lastTimeMs: null, bestTimeMs: null, lastSubmissionId: null, acceptedSubmissionId: null
      };
      map.set(key, e);
    }
    e.attempts++;
    e.verdicts.push(s.verdict);
    if (s.at && (!e.firstAt || s.at < e.firstAt)) e.firstAt = s.at;
    if (s.at && (!e.lastAt || s.at > e.lastAt)) e.lastAt = s.at;
    if (s.verdict === 'OK') {
      e.solved = true;
      if (s.timeMs != null && (e.bestTimeMs == null || s.timeMs < e.bestTimeMs)) e.bestTimeMs = s.timeMs;
    }
  }
  // 按时间升序重排每题内部的提交，用来判断"最后一发"与"第一次 AC"
  for (const e of map.values()) {
    const subs = list.filter((s) => s.contestId === e.contestId && s.index === e.index)
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    e.firstSubmissionId = subs.length ? subs[0].id : null;
    e.lastSubmissionId = subs.length ? subs[subs.length - 1].id : null;
    e.lastVerdict = subs.length ? subs[subs.length - 1].verdict : '';
    e.lastTimeMs = subs.length ? subs[subs.length - 1].timeMs : null;
    e.firstVerdict = subs.length ? subs[0].verdict : '';
    e.langs = [...new Set(subs.map((s) => s.lang).filter(Boolean))];
    // 从第一次提交到第一次 AC 之间的耗时（"卡了多久"的直接指标）
    const ac = subs.find((s) => s.verdict === 'OK');
    e.solvedAfterMs = (ac && ac.at && e.firstAt) ? (ac.at - e.firstAt) : null;
    e.acceptedSubmissionId = ac ? ac.id : null;
    e.solveOrder = subs.length;

    /**
     * 值得看代码的那几发（供复盘装材料用）。
     *
     * 为什么要多份而不是只留最后一发（用户反馈）：一题常常交错着 WA/TLE/AC，
     * 只看最后一发**看不到"错在哪 → 怎么改对的"这个过程**，而那正是复盘最值钱的部分。
     * 选法：第一发（原始思路）→ 最后一发失败（错在哪）→ 第一发 AC（怎么改对的）→ 去重，
     * 每发都带上判定，让模型知道每一份的角色。上限由调用方再收。
     */
    const picks = [];
    const push = (s, role) => {
      if (!s || picks.some((p) => p.id === s.id)) return;
      picks.push({ id: s.id, role, verdict: s.verdict, timeMs: s.timeMs, lang: s.lang, at: s.at });
    };
    push(subs[0], '首次提交');
    const lastFail = [...subs].reverse().find((s) => s.verdict !== 'OK');
    if (lastFail) push(lastFail, '最后一次未通过');
    if (ac) push(ac, '首次通过');
    push(subs[subs.length - 1], '最后一发');
    e.sourcePicks = picks;
  }
  return [...map.values()].sort((a, b) => String(a.index).localeCompare(String(b.index)));
}

/** 按比赛聚合，返回最近几场 + 每场的战绩 */
function groupByContest(list) {
  const byContest = new Map();
  for (const s of list) {
    const cid = s.contestId;
    if (!byContest.has(cid)) byContest.set(cid, []);
    byContest.get(cid).push(s);
  }
  const out = [];
  for (const [cid, subs] of byContest) {
    const problems = summarizeByProblem(subs);
    const solved = problems.filter((p) => p.solved).length;
    const times = subs.map((s) => s.at).filter(Boolean);
    const start = times.length ? Math.min(...times) : null;
    const end = times.length ? Math.max(...times) : null;
    out.push({
      contestId: cid,
      submissions: subs.length,
      problems: problems.length,
      solved,
      startAt: start,
      endAt: end,
      spanMs: (start && end) ? (end - start) : null,
      failed: problems.filter((p) => !p.solved).map((p) => p.index),
      /**
       * 罚时（近似，按 CF 规则）：**只有 AC 了的题才计罚时**——每题 = 该题成功之前
       * 的失败提交次数 × 50 分。未 AC 的题不计入罚时（它的失败提交是白交，不加分也不扣分）。
       *
       * 这里踩过一次坑：早先把"所有失败提交数"算成罚时，于是"死磕一题交了 8 发没过"
       * 会被报成罚时 400，和 CF 记分牌完全对不上，模型据此做的复盘结论也就跑偏了。
       * `failedSubmissions` 单独给"白交了多少发"，它是**过程指标**，不是罚时。
       */
      penaltyApprox: problems.reduce((acc, p) => acc + (p.solved ? Math.max(0, p.attempts - 1) * 50 : 0), 0),
      failedSubmissions: problems.reduce((acc, p) => acc + (p.solved ? Math.max(0, p.attempts - 1) : p.attempts), 0),
      problemList: problems
    });
  }
  return out.sort((a, b) => (b.endAt || 0) - (a.endAt || 0));
}

/* ---------------- 给模型看的文本 ---------------- */

const VERDICT_CN = {
  OK: 'AC 通过', WRONG_ANSWER: 'WA 答案错', TIME_LIMIT_EXCEEDED: 'TLE 超时',
  MEMORY_LIMIT_EXCEEDED: 'MLE 内存超限', RUNTIME_ERROR: 'RE 运行错误',
  COMPILATION_ERROR: 'CE 编译错误', IDLENESS_LIMIT_EXCEEDED: '闲置超时',
  SKIPPED: '跳过', TESTING: '评测中', REJECTED: '被拒', CHALLENGED: '被 hack',
  PARTIAL: '部分分', FAILED: '失败', SECURITY_VIOLATED: '安全违规', CRASHED: '崩溃',
  INPUT_PREPARATION_CRASHED: '输入生成失败'
};
const verdictCn = (v) => VERDICT_CN[v] || v || '未知';

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtDur(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' 分钟';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟';
}

/**
 * 把提交记录渲染成给模型读的文本。
 * 设计取向：**先把"这场比赛的形状"讲清楚**（几题、几发、卡在哪），再给逐题明细，
 * 让模型不必自己从几百条原始记录里找规律。
 */
async function submissionsText(o) {
  const { handle, list } = await fetchSubmissions(o);
  if (!list.length) {
    return '【提交记录为空】handle=' + handle + (o.contestId ? '，contestId=' + o.contestId : '')
      + '：这个人没有提交记录（检查用户名拼写，或换一场比赛）。';
  }
  const contests = groupByContest(list);
  const lines = [];
  lines.push('【Codeforces 提交记录】handle=' + handle + '｜本次分析 ' + list.length + ' 条提交｜覆盖 ' + contests.length + ' 场比赛');
  lines.push('（数据来自官方 API，不含源码；源码需要用 cf_source 单独取。）');
  lines.push('');

  if (o.group !== false) {
    lines.push('## 最近参加过的比赛（新 → 旧，最多 8 场）');
    for (const c of contests.slice(0, 8)) {
      if (c.submissions === 0) continue;
      // 练习提交（不在比赛时间内）会混进同一 contestId，用 inContest 比例标注一下
      const inC = list.filter((s) => s.contestId === c.contestId && s.inContest).length;
      lines.push('- **比赛 ' + c.contestId + '**（' + fmtTime(c.startAt) + ' 起，跨度 ' + fmtDur(c.spanMs) + '）'
        + '：提交 ' + c.submissions + ' 条（其中比赛内 ' + inC + ' 条）｜涉及 ' + c.problems + ' 题｜AC ' + c.solved + ' 题'
        + (c.failed.length ? '｜未过 ' + c.failed.join('/') : '')
        + '｜罚时≈' + c.penaltyApprox + '（只计 AC 题的失败提交×50）'
        + '｜未能 AC 的题白交 ' + c.failedSubmissions + ' 发');
    }
    lines.push('');
  }

  const target = o.contestId ? contests.filter((c) => String(c.contestId) === String(o.contestId)) : [];
  const detailContests = target.length ? target : contests.slice(0, 1);
  for (const c of detailContests) {
    lines.push('## 比赛 ' + c.contestId + ' 逐题明细');
    lines.push('（`提交 id` 可直接传给 cf_source 取源码；AC 的题通常不需要看代码）');
    lines.push('');
    lines.push('| 题 | 难度 | 结果 | 提交 | 判定序列 | 最后一发用时 | 首次提交→AC | 最后一发 id |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const p of c.problemList) {
      const seq = p.verdicts.slice().reverse().map(verdictCn).join(' → ');   // 时间升序
      lines.push('| ' + p.index + ' | ' + (p.rating || '—') + ' | ' + (p.solved ? '✅ AC' : '❌ ' + verdictCn(p.lastVerdict))
        + ' | ' + p.attempts + ' 次 | ' + seq + ' | ' + (p.lastTimeMs != null ? p.lastTimeMs + 'ms' : '—')
        + ' | ' + (p.solved ? fmtDur(p.solvedAfterMs) : '未 AC') + ' | ' + p.lastSubmissionId + ' |');
    }
    const tags = {};
    for (const p of c.problemList) for (const t of (p.tags || [])) tags[t] = (tags[t] || 0) + 1;
    const failedTags = {};
    for (const p of c.problemList.filter((x) => !x.solved)) for (const t of (p.tags || [])) failedTags[t] = (failedTags[t] || 0) + 1;
    lines.push('');
    lines.push('标签分布：' + (Object.entries(tags).map(([t, n]) => t + '×' + n).join('、') || '—'));
    if (Object.keys(failedTags).length) lines.push('未过题目的标签：' + Object.entries(failedTags).map(([t, n]) => t + '×' + n).join('、'));
    lines.push('这场比赛里有提交的题：' + c.problemList.map((p) => p.index + '(' + (p.rating || '?') + ')').join('、'));
  }
  return lines.join('\n');
}

/* ---------------- 源码 ---------------- */

/** 提交页 URL（两种都有效；/contest/ 形式对复盘更自然） */
function submissionUrl(contestId, submissionId) {
  return CF_BASE + '/contest/' + contestId + '/submission/' + submissionId;
}

/**
 * 取一次提交的源码。
 *
 * 顺序：① 先试普通 HTTP（便宜；如果哪天 CF 放开了就直接成功）
 *       ② 失败则走浏览器通道（Electron 注入；这是**唯一**能过 Cloudflare 的路）
 *       ③ 都没有 → 如实返回原因 + 替代做法（让用户把代码粘过来）
 *
 * @param {object} o contestId / submissionId / browserFetch（Electron 注入的函数）/ signal
 */
async function fetchSource(o) {
  const url = submissionUrl(o.contestId, o.submissionId);
  const fromBrowser = typeof o.browserFetch === 'function' ? o.browserFetch : null;

  // ① 普通 HTTP
  try {
    const r = await fetchViaHttp(url, o.signal);
    if (r.ok) return r;
  } catch (e) { /* 继续走浏览器 */ }

  // ② 浏览器通道
  if (fromBrowser) {
    try {
      const r = await fromBrowser({ contestId: String(o.contestId), submissionId: String(o.submissionId), url });
      if (r && r.ok && r.code) {
        return { ok: true, code: r.code, lang: r.lang || '', verdict: r.verdict || '', problem: r.problem || '', url, via: 'browser' };
      }
      const reason = (r && r.reason) || 'unknown';
      // not-found 的**真实原因**（实测确认）：Codeforces 要求登录后才能查看提交源码，
      // 未登录访问提交页会被 302 到首页 —— 所以看起来像"提交不存在"，实际是没登录。
      // 这里把出路写清楚，避免用户对着"提交 id 是否正确"白试。
      return {
        ok: false,
        reason: reason === 'not-allowed'
          ? '应用内浏览器没有登录 Codeforces（提交源码页要求登录）'
          : (reason === 'not-found'
            ? '提交页被重定向回首页（Codeforces 未登录时会这样，看起来像"提交不存在"）'
            : (reason === 'source-unavailable'
              ? '页面打开了，但 Codeforces 没有给出源码（可能是 Source: N/A、比赛进行中源码隐藏、或 gym 题需要权限）'
              : '浏览器通道失败：' + reason)),
        hint: reason === 'not-found' || reason === 'not-allowed'
          ? '最可能的原因是**应用内浏览器没有登录 Codeforces**。请让用户点复盘页的「🔑 登录 Codeforces」登录一次'
            + '（登录态会长期保留，之后抓源码/题解都能用）；也可以直接把代码粘过来（粘贴永远可行）。'
          : '可以让用户把代码直接粘给你（粘贴永远可行）。'
      };
    } catch (e) {
      return { ok: false, reason: '浏览器通道异常：' + ((e && e.message) || String(e)), hint: '让用户把代码粘过来。' };
    }
  }

  // ③ 两条都不通
  return {
    ok: false,
    reason: '源码只能从 Codeforces 网页取，而网页在 Cloudflare 后面（普通 HTTP 一律 403 + challenge）。'
      + '当前不在桌面版里运行，浏览器抓取通道不可用。',
    hint: '让用户把代码直接粘给你；或改用 cf_submissions 只做"记录层面"的复盘（判定/用时/尝试次数）。'
  };
}

/** 普通 HTTP 取提交页并解析源码（顺手为将来 CF 放开留一条快路） */
function fetchViaHttp(url, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity'
      },
      timeout: 15000,
      signal
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 503
          || /Just a moment|cf-mitigated|challenge-platform/i.test(d.slice(0, 3000))) {
          resolve({ ok: false, reason: 'cloudflare' });
          return;
        }
        if (res.statusCode !== 200) { resolve({ ok: false, reason: 'HTTP ' + res.statusCode }); return; }
        const m = d.match(/<pre[^>]*id="program-source-text"[^>]*>([\s\S]*?)<\/pre>/i)
          || d.match(/<pre[^>]*class="[^"]*program-source[^"]*"[^>]*>([\s\S]*?)<\/pre>/i);
        if (!m) { resolve({ ok: false, reason: 'source-unavailable' }); return; }
        const code = decodeEntities(m[1].replace(/<[^>]*>/g, ''));
        resolve({ ok: true, code, lang: (m[0].match(/lang-([a-z0-9+]+)/i) || [])[1] || '', url, via: 'http' });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
  });
}

function decodeEntities(s) {
  return String(s)
    // MathML 里常见数字实体（⋅ ≤ ≥ 之类）。不解码的话公式里会留着 "p&#x22C5;g" 这种原文，
    // 模型读到的就不是公式而是实体码（实测踩到）。
    .replace(/&#x([0-9a-f]{2,6});/gi, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return m; }
    })
    .replace(/&#(\d{2,7});/g, (m, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return m; }
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 比赛元信息（名称 / 是否已结束）——复盘前用它判断"这场比赛结束了吗" */
async function contestInfo(contestId) {
  const list = await apiGet('contest.list?gym=false');
  const hit = (list || []).find((c) => String(c.id) === String(contestId));
  if (!hit) return null;
  return {
    id: hit.id, name: hit.name, phase: hit.phase, type: hit.type,
    startAt: hit.startTimeSeconds ? hit.startTimeSeconds * 1000 : null,
    durationMs: hit.durationSeconds ? hit.durationSeconds * 1000 : null,
    finished: hit.phase === 'FINISHED'
  };
}

/**
 * 把 MathJax 渲染产物换成**可读的行内公式**。
 *
 * 为什么不能直接删：实测 CF 题解里公式是 MathJax 渲染的，数字与符号只存在于
 * `data-mathml` / `aria-label` 里（页面上看到的字形是另外生成的 span）。
 * 直接删掉会得到 "For example, consider . We split it into …" —— 句子读起来通顺、
 * 公式位却全空，模型会照着残缺句子编推导。这比报错危险得多。
 *
 * CF 现在跑的是 **MathJax v2**，结构是：
 *   <span class="MathJax" data-mathml="<math>…<mn>1</mn><mi>a</mi>…</math>">
 *     <nobr aria-hidden="true"><span class="math">…渲染出来的字形…</span></nobr>
 *     <script type="math/tex">1a</script>          ← 这里还有一份 TeX 原文
 *   </span>
 * （较新版本才会用 <mjx-container aria-label="…">，所以两条都要认。）
 */
function replaceMathWithText(html) {
  let s = String(html || '');

  // ① <mjx-container>（MathJax v3+）：aria-label 是给人读的，最优先
  s = s.replace(/<mjx-container[\s\S]*?<\/mjx-container>/gi, (block) => {
    const aria = block.match(/aria-label="([^"]{1,300})"/i);
    if (aria) return ' `' + decodeEntities(aria[1]).trim() + '` ';
    const m = block.match(/data-mathml="([\s\S]*?)"/i);
    if (m) {
      const tex = mathmlToText(decodeEntities(m[1]));
      if (tex) return ' `' + tex + '` ';
    }
    return ' ';
  });

  // ② span.MathJax（v2）：优先取内嵌的 TeX 原文（script[type="math/tex"]），
  //    它比 MathML 更好读（`n^2` 而不是 `n 2`）。
  //
  // ⚠️ 不能用 `<span …class="MathJax"…>[\s\S]*?<\/span>`：MathJax 自己会往里塞好几层 span
  // （nobr > span.math > span…），非贪婪会在**第一个**内层 </span> 就收尾，
  // 于是公式没还原、还留下一堆渲染字形的残渣（实测：句子变成 "consider the number ."）。
  // 正解是"带嵌套计数的平衡匹配"：从头扫，遇到 <span 计数 +1、</span> 计数 -1，归零即结束。
  s = replaceBalancedSpan(s, 'MathJax', (inner) => {
    const tex = inner.match(/<script[^>]*type="math\/tex[^"]*"[^>]*>([\s\S]*?)<\/script>/i);
    if (tex) return ' `' + tex[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() + '` ';
    const m = inner.match(/data-mathml="([\s\S]*?)"/i);
    if (m) {
      const t = mathmlToText(decodeEntities(m[1]));
      if (t) return ' `' + t + '` ';
    }
    return ' ';
  });

  return s;
}

/**
 * 把"带指定 class 的 span"整块（含嵌套 span）替换掉。
 * 递归解析 HTML 是件麻烦事，但 MathJax 的结构很规矩：span 的嵌套就是 span，
 * 所以用计数法就能正确找到配对的 </span>，不需要引入 DOM 解析器。
 *
 * @param {string} html
 * @param {string} className 目标 class token（如 'MathJax'）
 * @param {(inner:string)=>string} replacer 收到"开标签之后、配对闭合标签之前"的内容
 */
function replaceBalancedSpan(html, className, replacer) {
  const src = String(html || '');
  const openRe = new RegExp('<span[^>]*class="[^"]*\\b' + className + '\\b[^"]*"[^>]*>', 'i');
  let out = '';
  let rest = src;
  for (;;) {
    const m = rest.match(openRe);
    if (!m) { out += rest; break; }
    const start = m.index;
    out += rest.slice(0, start);
    let i = start + m[0].length;
    let depth = 1;
    while (i < rest.length && depth > 0) {
      const nextOpen = rest.indexOf('<span', i);
      const nextClose = rest.indexOf('</span>', i);
      if (nextClose < 0) break;                       // 结构异常：剩下的原样保留
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 5; }
      else { depth--; i = nextClose + 7; }
    }
    const inner = rest.slice(start + m[0].length, depth === 0 ? i - 7 : rest.length);
    out += replacer(inner);
    rest = depth === 0 ? rest.slice(i) : '';
  }
  return out;
}

/** 从 MathML 里抽一段能读的公式文本（<mi>n</mi><mo>+</mo><mn>1</mn> → "n+1"） */
function mathmlToText(mathml) {
  const inner = String(mathml || '');
  const tokens = inner.match(/<(mi|mn|mo|mtext)>([\s\S]*?)<\/\1>/gi);
  if (tokens && tokens.length) {
    return tokens.map((t) => t.replace(/<[^>]+>/g, '').trim()).join('').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/* ---------------- 官方题解：纯解析逻辑（不碰 DOM，可单元测试） ---------------- */

/**
 * blog entry 的 HTML → 可读文本。
 * 保留代码块（用 ``` 包起来，方便上层识别"这里有官方实现"），块级标签转换行。
 *
 * 注意这里**不用正则去嵌套解析 HTML**，只做"打平"：真正的 DOM 解析在渲染进程里
 * 用 cloneNode 完成（见 electron/main.js 的探针），这里处理的是已经去过标签的粗料。
 */
function editorialHtmlToText(html) {
  /**
   * 公式在服务端用"反引号包起来"表示行内代码（`s_i`）。
   * 但反引号包住的内容**不会被后面的实体解码覆盖到**：先摘出来 → 做完整条流水线
   * （含 decodeEntities）→ 最后再放回去。
   * 踩过的坑：公式是探针从 data-mathml 里取的，里面带 MathML 数字实体（如 &#x22C5; 表示 ⋅），
   * 结果正文里出现 "p&#x22C5;g" —— 公式还原了、实体却是原文，模型读到的不是公式而是实体码。
   */
  const hole = String.fromCharCode(1);
  const holes = [];
  let s = String(html || '').replace(/`([^`\n]{1,200})`/g, (m, inner) => {
    holes.push(decodeEntities(inner));
    return hole + (holes.length - 1) + hole;
  });
  s = replaceMathWithText(s);
  if (!s) return '';
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<\s*h[1-6][^>]*>/gi, '\n');   // 标题起始也要断行，否则会和上一段黏在一起
  s = s.replace(/<\s*pre[^>]*>/gi, '\n```\n').replace(/<\s*\/\s*pre\s*>/gi, '\n```\n');
  s = s.replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  // 实体解码统一走 decodeEntities（不要在这里再写一份内联替换）：
  // 曾经这两行是独立的一份，加了数字实体支持后只改了 decodeEntities，正文里就一直留着实体码。
  s = decodeEntities(s);
  // 还原被摘出来的公式
  s = s.replace(new RegExp(hole + '(\\d+)' + hole, 'g'), (m, i) => '`' + (holes[Number(i)] || '') + '`');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从一篇"整场比赛的题解"里切出某一题。
 *
 * CF 题解的正文里每道题通常写成 `A. 标题` / `Problem A` / `### A` / `**A**`；
 * 切不出来就**原样返回整篇**并把 sliced 置 false —— 让上层知道这不是精确切片，
 * 界面会显示"未能精确切出本题，以下是整篇"，而不是假装切好了。
 */
function splitEditorialByProblem(text, letter) {
  const full = String(text || '');
  const want = String(letter || '').toUpperCase();
  if (!want) return { content: full, sliced: false };

  /**
   * 标题行判定。
   * 踩过的坑：写 `^[#*\s>]*(?:Problem\s+)?B\s*[.\-:：)）]?\s` 会要求字母后面**必须**跟空白，
   * 于是 `### Problem B`（字母在行尾）匹配不上。现在改成"字母后面必须不是字母数字"，
   * 这样 `B`、`B.`、`B -`、`B:` 都认，而 `ABC` 不会误命中。
   */
  const headingRe = (L) => new RegExp('^[#*\\s>]*(?:Problem|Task)?\\s*' + L + '(?![A-Za-z0-9])', 'i');
  /** 任意一题的标题（用来找"下一题从哪开始"） */
  const anyHeadingRe = /^[#*\s>]*(?:Problem|Task)?\s*[A-Z]\d?(?![A-Za-z0-9])/;

  const lines = full.split('\n');
  const mine = headingRe(want);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 140) continue;
    if (!mine.test(t)) continue;
    // 别把别的题误当本题：行首那一段必须是"可选的 Problem/Task + 本题字母"，
    // 且后面紧跟着的不能是字母数字（已由 lookahead 保证）
    start = i;
    break;
  }
  if (start < 0) return { content: full, sliced: false, heading: null };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 140) continue;
    if (anyHeadingRe.test(t) && !mine.test(t)) { end = i; break; }
  }
  const slice = lines.slice(start, end).join('\n').trim();
  return { content: slice || full, sliced: !!slice, heading: lines[start].trim() };
}

/**
 * 题解内容里是否真的提到了这道题的字母（切错的自检）。
 *
 * ⚠️ 不能用 `\b` 或"字母两侧必须是非字母数字"来判：CF 的题解标题就是 `1567C - Carrying Conundrum`，
 * 字母紧跟在数字后面，用边界判定会得出"没提到 C"的**假警告**（实测踩到）。
 * 现在的规则：字母后面**不能再跟字母数字**（避免 A 命中 ABC），前面不限制。
 */
function editorialMentionsLetter(content, letter) {
  const want = String(letter || '').toUpperCase();
  if (!want) return true;
  const head = String(content || '').slice(0, 600);
  return new RegExp(want + '(?![A-Za-z0-9])', 'i').test(head);
}

/* ---------------- 官方题解（尽力而为：不是每道题都有） ---------------- */

/**
 * 抓一次官方题解。
 *
 * 设计取向：**找不到就是找不到**，绝不猜。CF 上题解链接不是每场都有（老比赛大量缺失），
 * 而且题解页在 Cloudflare 后面，所以这里必然有失败分支，界面必须能如实显示"本题没有官方题解"。
 *
 * @param {object} o contestId / index / browserFetch（Electron 注入）/ force
 * @returns {Promise<object>} { ok, content, url, entryId, sliced, reason, hint, cached }
 */
async function fetchEditorial(o) {
  const contestId = String(o.contestId == null ? '' : o.contestId).trim();
  const index = String(o.index == null ? '' : o.index).trim().toUpperCase();
  // 允许直接给 blog entry 号：题解是"整场比赛一篇"，同一篇里切出各题，
  // 所以拿到 entry 号后可以跳过"翻题目页找 Tutorial 链接"那一步（那一步要过一次反爬挑战，
  // 是整条链里最慢也最容易失败的一环）。
  const entryId = String(o.entryId == null ? '' : o.entryId).trim();
  if (entryId) {
    if (!/^\d{1,12}$/.test(entryId)) return { ok: false, reason: '参数不合法：entryId 必须是数字' };
  } else if (!/^\d{1,12}$/.test(contestId) || !/^[A-Z]\d?$/.test(index)) {
    return { ok: false, reason: '参数不合法：需要 contestId + index（或直接给 entryId）' };
  }
  /**
   * 缓存键统一按"**比赛 + 题号**"算，不用 entry 号。
   *
   * 为什么（真实观察到的浪费）：同一篇题解页，从"题目页找 Tutorial 链接"进去时键是 `2267C`，
   * 从用户粘贴的 entry 链接进去时键是 `entry157126-C` —— 同一份内容被存了两份、
   * 第二次还得重新抓一遍（缓存命中不了）。key 只跟"哪道题"有关才符合直觉。
   * 前提：contestId + index 必须可用；只给了 entryId 而没给题号时，退回用 entry 号做键。
   */
  const canKeyByProblem = /^\d{1,12}$/.test(contestId) && /^[A-Z]\d?$/.test(index);
  const cacheKey = canKeyByProblem ? (contestId + index) : ('entry' + entryId);
  const cacheFile = CACHE_DIR ? path.join(CACHE_DIR, 'cache', 'editorials', cacheKey + '.json') : null;
  if (!o.force && cacheFile) {
    const hit = readCacheJson(cacheFile);
    // **只缓存成功结果**：失败（没有题解 / 超时）不落盘，
    // 否则一次网络抖动就会让这道题被永久记成"没有题解"。
    if (hit && hit.ok) return Object.assign({}, hit, { cached: true });
  }
  const bf = typeof o.browserFetch === 'function' ? o.browserFetch : null;
  if (!bf) {
    return {
      ok: false,
      reason: 'no-browser',
      hint: '题解页在 Cloudflare 后面，只有桌面版的内嵌浏览器通道能抓。Web 模式下请手动打开 CF 查看。'
    };
  }
  let r;
  try {
    r = await bf({ contestId, index, entryId: entryId || undefined });
  } catch (e) {
    return { ok: false, reason: 'browser-error', hint: String((e && e.message) || e).slice(0, 160) };
  }
  if (!r) return { ok: false, reason: 'no-result' };
  if (r.ok && r.content) {
    const out = {
      ok: true, contestId, index, entryId: r.entryId || null, url: r.url || null,
      title: r.title || '', content: r.content, sliced: !!r.sliced,
      heading: r.heading || null,
      letterMentioned: r.content ? editorialMentionsLetter(r.content, index) : true,
      fetchedAt: Date.now()
    };
    // 诊断数据（只在桌面版开了 CFCOACH_DEBUG_EDITORIAL 时才有）原样透传，且**不进缓存**
    if (r.diag) out.diag = r.diag;
    if (cacheFile) { try { writeCacheJson(cacheFile, out); } catch (e) { /* 缓存失败不影响返回 */ } }
    return out;
  }
  const D = {
    'no-tutorial-link': '这道题（或这场比赛）在 Codeforces 上没有官方题解链接——不是每场都有。',
    'not-found': '题解页面打不开，或正文为空。',
    timeout: '抓取超时。最常见的原因是**短时间内抓太多次被 Codeforces 限流**（页面会变成空白/只有导航栏），'
      + '或者 Cloudflare 挑战没过。等几分钟再试通常会好；也可以先用「🛡 过一次反爬挑战」把 cookie 拿下来。'
  };
  return {
    ok: false, reason: r.reason || 'unknown',
    hint: r.hint || D[r.reason] || ('抓取失败：' + String(r.reason || '').slice(0, 120))
  };
}

/* ---------------- 复盘诊断包（给 AI 读的那份材料） ---------------- */

/**
 * 把一场比赛的提交记录整理成"可以直接交给模型做诊断"的材料。
 *
 * 为什么单独做这个：复盘的价值在于**真实提交**这份地面真相。把已经算好的机械结论
 * （哪题几发、卡在哪、罚时花在哪、标签分布）连同题解一起打包，模型就不用从几百条原始记录里
 * 自己找规律——省 token，也更不容易看错。
 *
 * @param {object} o handle / contestId / includeEditorial / editorialFetch
 */
async function reviewBundle(o) {
  const { handle, list } = await fetchSubmissions({ handle: o.handle, contestId: o.contestId });
  const contests = groupByContest(list);
  if (!contests.length) return { ok: false, reason: '这场比赛没有提交记录', handle };
  const c = contests[0];
  const info = await contestInfo(c.contestId).catch(() => null);

  const L = [];
  L.push('# Codeforces 赛后复盘材料');
  L.push('');
  L.push('- 选手：' + handle);
  L.push('- 比赛：' + c.contestId + (info && info.name ? '「' + info.name + '」' : '')
    + (info ? '（' + (info.finished ? '已结束' : '**未结束** — 比赛进行中源码是隐藏的') + '）' : ''));
  L.push('- 提交 ' + c.submissions + ' 条｜涉及 ' + c.problems + ' 题｜AC ' + c.solved + ' 题'
    + '｜本场跨度 ' + fmtDur(c.spanMs));
  L.push('- 罚时（只计 AC 题的失败提交 × 50）：' + c.penaltyApprox
    + '｜未 AC 题目的白交提交：' + c.failedSubmissions + ' 发');
  L.push('');
  L.push('## 逐题');
  L.push('');
  for (const p of c.problemList) {
    const seq = p.verdicts.slice().reverse().map(verdictCn).join(' → ');
    L.push('### ' + p.index + '（' + (p.rating || '未定级') + (p.problemName ? '，' + p.problemName : '') + '）');
    L.push('- 结果：' + (p.solved ? '✅ AC' : '❌ ' + verdictCn(p.lastVerdict))
      + '｜提交 ' + p.attempts + ' 次｜判定序列 ' + seq);
    L.push('- 最后一发：' + (p.lastTimeMs != null ? p.lastTimeMs + 'ms' : '—') + '｜提交 id ' + p.lastSubmissionId);
    if (p.solved) L.push('- 从首次提交到 AC：' + fmtDur(p.solvedAfterMs));
    if (p.tags && p.tags.length) L.push('- 标签：' + p.tags.join('、'));
    L.push('');
  }

  if (o.includeEditorial !== false) {
    L.push('## 官方题解（尽力而为：CF 上不是每场每题都有）');
    L.push('');
    for (const p of c.problemList) {
      let ed = null;
      if (typeof o.editorialFetch === 'function') {
        try { ed = await o.editorialFetch({ contestId: c.contestId, index: p.index }); } catch (e) { ed = null; }
      }
      if (ed && ed.ok && ed.content) {
        L.push('### ' + p.index + ' 题解' + (ed.entryId ? '（blog/entry/' + ed.entryId + '）' : '')
          + (ed.sliced ? '' : '（⚠ 未能精确切出本题，以下是整篇题解）'));
        L.push(ed.content.slice(0, 6000));
        L.push('');
      } else {
        L.push('### ' + p.index + ' 题解：**没有找到**'
          + (ed && ed.hint ? '（' + ed.hint + '）' : '') + ' —— 不要编造官方做法。');
        L.push('');
      }
    }
  }

  if (o.includeSource !== false) {
    /**
     * 逐条装源码：**不只最后一发**（用户两次反馈的正是这一点）。
     *
     * 一题往往交错着 WA/TLE/AC，只看最后一发看不到"错在哪 → 怎么改对的"这个过程，
     * 而那正是复盘最值钱的地方。取法与复盘会话完全一致（sourcePicks：首次提交 /
     * 最后一次未通过 / 首次通过），每题最多 3 份，超出总预算的如实标注"超时未抓"。
     */
    L.push('## 选手源码（每题最多 3 发：首次提交 / 最后一次未通过 / 首次通过）');
    L.push('');
    if (!o.sourceFetch) {
      L.push('（本次没有源码通道，只做了记录层面的复盘）');
      L.push('');
    } else {
      const deadline = Date.now() + (Number(o.sourceBudgetMs) || 100000);
      for (const p of c.problemList) {
        const picks = (Array.isArray(p.sourcePicks) && p.sourcePicks.length) ? p.sourcePicks.slice(0, 3) : [];
        if (!picks.length) continue;
        const got = []; const missed = [];
        for (const pk of picks) {
          if (Date.now() > deadline) { missed.push(pk.role + '（超时未抓）'); continue; }
          let s = null;
          try { s = await o.sourceFetch({ contestId: c.contestId, submissionId: pk.id }); } catch (e) { s = null; }
          if (s && s.ok && s.code) got.push({ pk, s });
          else missed.push(pk.role + '（' + ((s && (s.hint || s.reason)) || '抓取失败') + '）');
        }
        if (!got.length) {
          L.push('### ' + p.index + ' 源码：**没取到**（' + (missed[0] || '未知原因') + '）');
          if (/not-found|未登录|重定向|not-allowed/i.test(missed.join(' '))) {
            L.push('> 原因通常是应用内浏览器**没有登录 Codeforces**（提交源码页要求登录）。'
              + '点复盘页的「🔑 登录 Codeforces」登一次，之后重拉即可。');
          }
          L.push('');
          continue;
        }
        for (const g of got) {
          L.push('### ' + p.index + ' · ' + g.pk.role + '（提交 ' + g.pk.id + '，'
            + verdictCn(g.pk.verdict) + '，' + (g.s.lang || g.pk.lang || '') + '）');
          L.push('```' + (g.s.lang || ''));
          L.push(String(g.s.code).slice(0, 6000));
          L.push('```');
          L.push('');
        }
        if (missed.length) { L.push('（另外没取到：' + missed.join('；') + '）'); L.push(''); }
      }
    }
  }

  L.push('## 请你做什么');
  L.push('');
  L.push('按 cf-review 技能：先给全局分布（几题、罚时花在哪、哪题最吃时间），');
  L.push('再逐题给「现象 / 根因 / 最小反例 / 可立刻执行的改进项」，最后跨题归纳失败模式与 ≤3 条下场比赛行动项。');
  L.push('**材料里已经给出的源码/题解不要再自己去取一遍**；');
  L.push('**没有源码的题不要猜实现细节**；官方题解缺失的题不要假装引用它。');
  return { ok: true, contestId: c.contestId, contestName: info ? info.name : null, bundle: L.join('\n'), stats: c };
}

module.exports = {
  fetchSubmissions, summarizeByProblem, groupByContest, submissionsText,
  fetchSource, submissionUrl, contestInfo, validateHandle,
  fetchEditorial, reviewBundle,
  editorialHtmlToText, splitEditorialByProblem, editorialMentionsLetter,
  verdictCn, VERDICT_CN, PRACTICE_RELATIVE, setCacheDir
};
