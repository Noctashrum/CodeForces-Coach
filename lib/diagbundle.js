/**
 * 诊断包：把"出问题那一刻"的证据打成一个**纯文本**文件，用户一键导出、发给开发者。
 *
 * 为什么是纯文本而不是 zip：
 *   用户的真实场景是"另一台电脑上的 cfcoach 运行日志怎么传过来"——
 *   纯文本既能直接贴进聊天窗口，也能当附件发；不用解压、不用额外依赖、不会因为
 *   对方没装解压工具而卡住。体积靠分段裁剪控制。
 *
 * 三处共用同一份实现（这就是不重复造轮子的意义）：
 *   ① 应用内     ：GET /api/diag/export（设置 → 数据存储 → 导出诊断包）
 *   ② 命令行     ：node scripts/diag.js --out 诊断包.txt（连界面都起不来时用这个）
 *   ③ 消融测试台 ：ablation/serve.js 的 GET /api/diag/export（额外带上跑分记录）
 *
 * **脱敏是第一原则**：API key / cookie / 邮箱 / 系统用户名一律打码（redact），
 * 写出去的每一段都必须先过 redact()，不允许"顺手把原始配置带上"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = 1;

/** 默认裁剪上限（字符）：宁可少带，也不要出一个几 MB 的包 */
const DEFAULT_LIMITS = {
  section: 200000,        // 单段上限
  total: 900000,          // 整包上限
  log: 120000,            // 单个日志文件上限（取尾部）
  messagesPerConv: 4,     // 每个会话保留最近几条消息
  messageChars: 1200,     // 每条消息截断长度
  conversations: 6,       // 最多带几个会话（按更新时间倒序）
  workspaceFiles: 40,     // 每个工作区最多列几个文件
  answers: 6,             // 最多带几份答案
  answerChars: 600,       // 每份答案只带前 N 字符
  transcriptEvents: 60,   // 每份 transcript 最多列几行工具过程
  transcriptResultChars: 300
};

// ---------------------------------------------------------------- 脱敏

/** 保留末 4 位打码：既看不出原文，又能判断"是不是同一个 key" */
function mask(v) {
  const s = String(v == null ? '' : v);
  if (!s) return s;
  if (s.length <= 6) return '***';
  return '***' + s.slice(-4);
}

/** `"apiKey": "xxx"` / `api_key=xxx` 两种写法 */
const SECRET_KEY = /("?(?:api[_-]?key|apikey|api[_-]?secret|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization|cookie|cookies|session[_-]?id)"?\s*[:=]\s*"?)([^"\s,;}\]]+)/gi;

/**
 * 把一段文本里的敏感信息打码。幂等（重复调用结果不变），可以安全地对任何段落使用。
 */
function redact(input) {
  let s = String(input == null ? '' : input);
  if (!s) return s;
  // 0) 先处理 `Authorization: Bearer <token>` 这种"键名后面还有方案名"的写法：
  //    如果先跑 SECRET_KEY，它只会把 `Bearer` 当值遮掉，真正的 token 反而留在原地（踩过）。
  s = s.replace(/(\bauthorization\s*[:=]\s*)(?:bearer|basic|token)\s+[^\s,;"']+/gi, '$1***');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***');
  // 1) 键值对（JSON / .env / 请求头三种写法都覆盖）
  s = s.replace(SECRET_KEY, (m, k, v) => k + mask(v));
  // 2) cookie 串（cf 反爬那几个名字单独列出来，它们最容易被忽略）
  s = s.replace(/\b(cf_clearance|cf_chl_\w+|codeforces|39ce7|X-User-Sha1|JSESSIONID|__cf\w*)=([^;\s"']+)/gi,
    (m, k) => k + '=***');
  // 3) 裸 key 形态（万一没配键名）
  s = s.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-***');
  s = s.replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g, '$1_***');
  // 4) 邮箱与系统用户名（隐私，与问题定位无关）
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  s = s.replace(/([A-Za-z]:\\Users\\)[^\\\r\n]+/g, '$1<user>');
  s = s.replace(/(\/Users\/)[^/\r\n]+/g, '$1<user>');
  s = s.replace(/(\/home\/)[^/\r\n]+/g, '$1<user>');
  return s;
}

// ---------------------------------------------------------------- 小工具

function clip(s, n) {
  const t = String(s == null ? '' : s);
  if (t.length <= n) return t;
  return t.slice(0, n) + '\n…（本段已截断，原长 ' + t.length + ' 字符）';
}

function isDir(p) { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } }

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 读日志尾部（日志看的是最后发生的事） */
function tailText(p, cap) {
  const s = readTextSafe(p);
  if (s == null) return null;
  return s.length > cap ? '…（只保留最后 ' + cap + ' 字符，原长 ' + s.length + '）\n' + s.slice(-cap) : s;
}

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}

function sizeOf(p) { try { return fs.statSync(p).size; } catch { return null; } }
function mtimeOf(p) { try { return new Date(fs.statSync(p).mtimeMs).toISOString(); } catch { return null; } }

function appDataDir() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Electron 的 userData 目录（cf-diag.log 就在那里）。
 * 主进程会设 CFCOACH_USER_DATA（app.getPath('userData') 的权威值），优先用它。
 */
function defaultUserDataDir() {
  return process.env.CFCOACH_USER_DATA || path.join(appDataDir(), 'codeforces-coach');
}

/** 应用数据目录的候选（顺序即优先级） */
function dataDirCandidates(rootDir) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(process.env.CHATBOX_DATA_DIR);
  add(process.env.CFCOACH_APP_DATA);
  if (rootDir) {
    add(path.join(rootDir, 'data'));
    try {
      for (const d of fs.readdirSync(path.join(rootDir, 'dist'))) add(path.join(rootDir, 'dist', d, 'data'));
    } catch { /* 没有 dist 就算了 */ }
  }
  add(path.join(appDataDir(), 'codeforces-coach'));
  return out;
}

function hasProviders(dir) {
  const j = readJsonSafe(path.join(dir, 'config.json'));
  return !!(j && Array.isArray(j.providers) && j.providers.length);
}

/**
 * 挑出真正的应用数据目录：先要有 providers 的（模型配置在哪，题面缓存就在哪），
 * 其次只要存在即可，最后退回第一个候选。
 */
function pickDataDir(rootDir) {
  const cands = dataDirCandidates(rootDir);
  for (const c of cands) if (hasProviders(c)) return c;
  for (const c of cands) if (isDir(c)) return c;
  return cands[0] || null;
}

function diagDir(dataDir) { return dataDir ? path.join(dataDir, 'diag') : null; }

function stamp(now) {
  const t = now || new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

function defaultFileName(now) { return 'cfcoach-diag-' + stamp(now) + '.txt'; }

// ---------------------------------------------------------------- 各段

function envSection(o, ctx) {
  let cpu = '—';
  try { cpu = (os.cpus()[0] || {}).model || '—'; } catch { /* ignore */ }
  // CLI 与测试台不一定交底 locale/timeZone，这里自己兜一次（否则环境段永远是"— / —"，白留两个字段）
  let locale = o.locale, timeZone = o.timeZone;
  try {
    const ro = Intl.DateTimeFormat().resolvedOptions();
    if (!locale) locale = ro.locale;
    if (!timeZone) timeZone = ro.timeZone;
  } catch { /* ignore */ }
  const envLine = (name) => name + '=' + (process.env[name] ? process.env[name] : '（未设置）');
  const lines = [
    '生成时间：' + new Date(o.now || Date.now()).toISOString(),
    '诊断包版本：v' + VERSION,
    '平台：' + process.platform + ' ' + process.arch + ' · ' + os.release(),
    'Node：' + process.version,
    'Electron：' + (o.electronVersion || '—'),
    'Chromium：' + (o.chromeVersion || '—'),
    '应用版本：' + (o.appVersion || '—') + (o.packed == null ? '' : '（' + (o.packed ? '打包版' : '开发版') + '）'),
    'CPU：' + cpu + ' × ' + (os.cpus() || []).length,
    '内存：' + bytes(os.totalmem()) + ' 总 / ' + bytes(os.freemem()) + ' 空闲',
    '语言/时区：' + (locale || '—') + ' / ' + (timeZone || '—'),
    '项目根：' + (o.rootDir || '—'),
    '应用数据目录：' + (ctx.dataDir || '（没找到）'),
    '用户数据目录：' + (ctx.userDataDir || '—'),
    '环境变量：' + envLine('CHATBOX_DATA_DIR') + ' ' + envLine('CFCOACH_APP_DATA') +
      ' ' + envLine('CF_BASE') + ' ' + envLine('CFCOACH_DEBUG_EDITORIAL')
  ];
  return lines.join('\n');
}

function configSection(ctx) {
  if (!ctx.dataDir) return '（没有定位到应用数据目录，读不到 config.json）';
  const p = path.join(ctx.dataDir, 'config.json');
  const raw = readTextSafe(p);
  if (raw == null) return '（读不到 ' + p + '）';
  const j = readJsonSafe(p);
  const head = '文件：' + p + '（' + bytes(sizeOf(p)) + '）\n'
    + '说明：apiKey / token / cookie 已打码；baseUrl 与模型名保留（定位问题需要）。\n';
  return head + (j ? JSON.stringify(j, null, 2) : raw);
}

function logSection(o, ctx, name, file, cap) {
  if (!file) return '（路径未知）';
  const s = tailText(file, cap);
  if (s == null) {
    return '（没有这个文件：' + file + '）\n'
      + (o.logHint ? o.logHint(name) : '它只在相关流程出错时才会写；请先复现一次问题再导出。');
  }
  return '文件：' + file + '（' + bytes(sizeOf(file)) + '，改动于 ' + mtimeOf(file) + '）\n\n' + s;
}

/** 题面缓存台账：只带"有什么题、多大、几组样例"，不带题面正文（省体积） */
function problemCacheSection(ctx) {
  const dir = ctx.dataDir ? path.join(ctx.dataDir, 'cf-problems') : null;
  if (!isDir(dir)) return '（没有题面缓存目录：' + (dir || '—') + '）';
  const rows = [];
  for (const f of listDir(dir).filter((x) => x.endsWith('.json')).sort()) {
    const p = path.join(dir, f);
    const j = readJsonSafe(p) || {};
    const stmt = String(j.statement || '');
    const samples = Array.isArray(j.samples) ? j.samples.length : 0;
    rows.push([
      f,
      j.contestId != null && j.index ? j.contestId + j.index : '—',
      (j.title || j.name || '—'),
      j.rating != null ? 'rating ' + j.rating : 'rating —',
      '题面 ' + stmt.length + ' 字符',
      '样例 ' + samples + ' 组',
      bytes(sizeOf(p)),
      mtimeOf(p)
    ].join('  |  '));
  }
  return '目录：' + dir + '（' + rows.length + ' 道）\n' + (rows.join('\n') || '（空）');
}

/** 工作区：meta.json 是"验证链到底走到哪一步"的现场，必须带 */
function workspaceSection(o, ctx, limits) {
  const dir = ctx.dataDir ? path.join(ctx.dataDir, 'workspace') : null;
  if (!isDir(dir)) return '（没有工作区目录：' + (dir || '—') + '）';
  const out = ['目录：' + dir];
  for (const key of listDir(dir).sort()) {
    const wd = path.join(dir, key);
    if (!isDir(wd)) continue;
    const files = listDir(wd).map((f) => f + '(' + bytes(sizeOf(path.join(wd, f))) + ')')
      .slice(0, limits.workspaceFiles);
    out.push('\n--- 工作区 ' + key + '（' + mtimeOf(wd) + '）---');
    out.push('文件：' + (files.join(', ') || '（空）'));
    const metaRaw = readTextSafe(path.join(wd, 'meta.json'));
    if (metaRaw != null) {
      const meta = readJsonSafe(path.join(wd, 'meta.json'));
      if (meta) {
        const v = meta.verification || {};
        out.push('验证：status=' + (v.status || '—') + ' verdict=' + (v.verdict || '—')
          + ' 对拍 ' + (v.iterations != null ? v.iterations : '—') + ' 组'
          + ' 样例 ' + (v.samples != null ? v.samples : '—')
          + ' 规模档 [' + (Array.isArray(v.tiers) ? v.tiers.join(',') : '—') + ']'
          + (v.samplesSource ? ' 样例来源 ' + v.samplesSource : '')
          + (v.scopeComplete === false ? '  ⚠️scopeComplete=false' : '')
          + (v.stressTruncated ? '  ⚠️' + v.stressTruncated : '')
          + (v.delivered ? '  交付=' + v.delivered : '')
          + (v.solRollback ? '  已回退第一版' : ''));
        out.push('轨迹：' + (Array.isArray(meta.trajectory) ? meta.trajectory.map((x) => x && x.kind).join(' → ') : '—'));
        const trace = Array.isArray(meta.trace) ? meta.trace : [];
        out.push('模型调用：' + trace.map((t) => (t.label || t.role) + (t.ok === false ? '(失败)' : '') + '/' + (t.ms != null ? t.ms + 'ms' : '—')).join(' → '));
        out.push('（meta.json 全文如下，code 字段是元数据不是解题代码）');
      }
      out.push(clip(metaRaw, 6000));
    } else {
      out.push('（没有 meta.json）');
    }
  }
  return out.join('\n');
}

/** 会话台账：带最近几条消息（这才是"用户看到的界面到底显示了什么"） */
function conversationSection(o, ctx, limits) {
  const out = [];
  for (const which of ['conversations', 'archived']) {
    const dir = ctx.dataDir ? path.join(ctx.dataDir, which) : null;
    if (!isDir(dir)) continue;
    const files = listDir(dir).filter((f) => f.endsWith('.json'));
    const metas = files.map((f) => {
      const p = path.join(dir, f);
      const j = readJsonSafe(p) || {};
      return { f, p, j, at: j.updatedAt || 0 };
    }).sort((a, b) => (b.at || 0) - (a.at || 0));
    out.push('\n=== ' + which + '：' + dir + '（' + files.length + ' 个会话，按更新时间倒序）===');
    if (!files.length) { out.push('（空）'); continue; }
    if (metas.length > limits.conversations) {
      out.push('（只带最近 ' + limits.conversations + ' 个；其余 ' + (metas.length - limits.conversations) + ' 个仅列文件名：'
        + metas.slice(limits.conversations).map((m) => m.f).join(', ') + '）');
    }
    for (const m of metas.slice(0, limits.conversations)) {
      const j = m.j || {};
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      out.push('\n--- ' + m.f + '  "' + (j.title || '（无标题）') + '"');
      out.push('  provider=' + (j.providerId || '—') + ' model=' + (j.model || '—')
        + ' mode=' + (j.mode || '—') + ' rich=' + (j.rich === true)
        + ' 题=' + (j.cfProblem ? (j.cfProblem.contestId || '') + (j.cfProblem.index || '') + ' ' + (j.cfProblem.title || '') : '—')
        + ' 更新=' + (j.updatedAt ? new Date(j.updatedAt).toISOString() : '—'));
      out.push('  题面 ' + String(j.statementText || '').length + ' 字符 · 消息 ' + msgs.length + ' 条 · 文件 ' + bytes(sizeOf(m.p)));
      const recent = msgs.slice(-limits.messagesPerConv);
      if (msgs.length > recent.length) out.push('  （只带最后 ' + recent.length + ' 条消息）');
      for (const mm of recent) {
        const body = clip(String(mm.content == null ? '' : mm.content), limits.messageChars);
        out.push('  [' + (mm.role || '?') + (mm.error ? ' ERROR' : '') + '] ' + body.replace(/\n/g, '\n    '));
      }
    }
  }
  return out.join('\n') || '（没有会话目录）';
}

/** 跑分/消融记录：别的电脑上跑完的"运行包"，这是最需要传回来的部分 */
function ablationSection(o, ctx, limits) {
  const dir = o.ablationOut || (o.rootDir ? path.join(o.rootDir, 'ablation', 'out', 'ui') : null);
  if (!isDir(dir)) return '（没有跑分目录：' + (dir || '—') + '）';
  const out = ['目录：' + dir];

  const summary = readJsonSafe(path.join(dir, 'summary.json'));
  if (summary) out.push('\n--- summary.json ---\n' + JSON.stringify(summary, null, 2));

  const problems = readJsonSafe(path.join(dir, 'problems.json'));
  if (problems) {
    const arr = Array.isArray(problems) ? problems : (problems.problems || []);
    out.push('\n--- 题库（problems.json，' + arr.length + ' 道）---');
    for (const p of arr) {
      const orc = p.oracle ? (p.oracle.file ? p.oracle.file : '(内联)') : '—';
      const gen = p.gen ? (p.gen.file ? p.gen.file : '(内联)') : '—';
      out.push([p.id, p.title || '', 'rating ' + (p.rating == null ? '—' : p.rating),
        '样例 ' + ((p.samples || []).length) + ' 组',
        'oracle ' + (p.oracleLang || '—') + ':' + orc + (p.oracle && p.oracle.file ? '(' + bytes(sizeOf(p.oracle.file)) + ')' : ''),
        'gen ' + (p.genLang || '—') + ':' + gen,
        'note=' + (p.note || ''), 'statementSha=' + String(p.statementSha || '').slice(0, 12)].join('  |  '));
    }
  }

  const recFile = path.join(dir, 'records.jsonl');
  if (isFile(recFile)) {
    const recs = String(readTextSafe(recFile) || '').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    out.push('\n--- records.jsonl（' + recs.length + ' 条；解题代码正文不带，只带元数据）---');
    for (const r of recs) {
      const v = r.verification || {};
      out.push([r.level, r.problem, r.model || '',
        r.ok ? 'ok' : 'FAILED',
        'steps=' + (r.steps == null ? '—' : r.steps), 'calls=' + (r.calls == null ? '—' : r.calls),
        'code=' + (r.codeLang || '—') + '/' + (r.codeSource || '—'),
        'tokens=' + ((r.usage && r.usage.promptTokens) || 0) + '+' + ((r.usage && r.usage.completionTokens) || 0),
        'ms=' + (r.ms == null ? '—' : r.ms),
        r.error ? 'error=' + clip(r.error, 300) : '',
        r.toolsUsed && r.toolsUsed.length ? 'tools=' + r.toolsUsed.join(',') : ''
      ].filter(Boolean).join('  |  '));
      if (v && Object.keys(v).length) {
        out.push('    verification: ' + JSON.stringify(v));
      }
      if (r.finalize) out.push('    finalize: ' + JSON.stringify(r.finalize));
      if (r.roles) out.push('    roles: ' + JSON.stringify(r.roles));
    }
  }

  const verFile = path.join(dir, 'verdicts.jsonl');
  if (isFile(verFile)) out.push('\n--- verdicts.jsonl ---\n' + String(readTextSafe(verFile) || '').trim());

  const cmp = readJsonSafe(path.join(dir, 'compare.json'));
  if (cmp) out.push('\n--- compare.json ---\n' + JSON.stringify(cmp, null, 2));

  const ansDir = path.join(dir, 'answers');
  if (isDir(ansDir)) {
    const fs2 = listDir(ansDir).filter((f) => f.endsWith('.md')).sort().slice(0, limits.answers);
    out.push('\n--- answers/（每份只带前 ' + limits.answerChars + ' 字符）---');
    for (const f of fs2) {
      const p = path.join(ansDir, f);
      out.push('\n>>> ' + f + '（' + bytes(sizeOf(p)) + '）\n' + clip(String(readTextSafe(p) || ''), limits.answerChars));
    }
  }

  const tDir = path.join(dir, 'transcript');
  if (isDir(tDir)) {
    out.push('\n--- transcript/（工具过程：这一段最能把"哪一步走歪了"说清楚）---');
    for (const f of listDir(tDir).filter((x) => x.endsWith('.jsonl')).sort()) {
      const evs = String(readTextSafe(path.join(tDir, f)) || '').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const ends = evs.filter((e) => e.kind === 'toolEnd');
      out.push('\n>>> ' + f + '：' + evs.length + ' 条事件，工具 ' + ends.length + ' 次'
        + '，总耗时 ' + (ends.reduce((s, e) => s + (e.ms || 0), 0)) + 'ms');
      out.push('    序列：' + ends.map((e) => e.name + (e.ok ? '' : '✗') + '(' + (e.ms || 0) + 'ms)').join(' → '));
      for (const e of evs.slice(0, limits.transcriptEvents)) {
        if (e.kind === 'toolStart') continue;
        out.push('    +' + (e.t == null ? '—' : e.t) + 'ms ' + (e.name || '?') + (e.ok ? ' OK' : ' FAIL')
          + ' ' + clip(String(e.result || ''), limits.transcriptResultChars).replace(/\n/g, ' ⏎ '));
      }
      if (evs.length > limits.transcriptEvents) out.push('    …（还有 ' + (evs.length - limits.transcriptEvents) + ' 条未列）');
    }
  }

  const sbDir = path.join(dir, 'sandbox');
  if (isDir(sbDir)) {
    out.push('\n--- sandbox/（模型自己写的文件清单，不带内容）---');
    for (const k of listDir(sbDir).sort()) {
      const p = path.join(sbDir, k);
      if (!isDir(p)) continue;
      out.push(k + '：' + listDir(p).map((f) => f + '(' + bytes(sizeOf(path.join(p, f))) + ')').join(', '));
    }
  }

  const docsDir = path.join(dir, 'docs');
  if (isDir(docsDir)) {
    out.push('\n--- docs/（只列大小）---');
    out.push(listDir(docsDir).map((f) => f + '(' + bytes(sizeOf(path.join(docsDir, f))) + ')').join(', '));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- 主入口

/**
 * 收集诊断包正文。
 *
 * @param {object} opts
 *   dataDir / userDataDir / rootDir / ablationOut —— 目录；缺省自动探测
 *   appVersion / electronVersion / chromeVersion / locale / timeZone / packed —— 环境补充
 *   extra: [{name, text}] —— 调用方追加的段落（例如应用侧的路由表、测试台的内存状态）
 *   limits、now
 * @returns {{text:string, sections:{name:string,chars:number,truncated:boolean}[], bytes:number,
 *            warnings:string[], dataDir:string, userDataDir:string, file?:string}}
 */
function collect(opts) {
  const o = opts || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, o.limits || {});
  const warnings = [];
  const rootDir = o.rootDir || null;
  const dataDir = o.dataDir || pickDataDir(rootDir);
  const userDataDir = o.userDataDir || defaultUserDataDir();
  const ctx = { dataDir, userDataDir };
  const now = o.now ? new Date(o.now) : new Date();

  const parts = [];
  const sections = [];
  let budget = limits.total;

  function push(name, text) {
    let body = redact(String(text == null ? '' : text));
    let truncated = false;
    if (body.length > limits.section) { body = clip(body, limits.section); truncated = true; }
    if (body.length > budget) {
      body = clip(body, Math.max(0, budget));
      truncated = true;
      warnings.push('总长度上限已到，后面的段落被裁掉：' + name);
    }
    const block = '\n########## ' + name + ' ##########\n' + body.replace(/\s+$/, '') + '\n';
    parts.push(block);
    budget -= block.length;
    sections.push({ name, chars: body.length, truncated });
    return body.length;
  }

  const safe = (name, fn) => {
    try { push(name, fn()); } catch (e) {
      warnings.push('段落『' + name + '』收集失败：' + ((e && e.message) || e));
      push(name, '（收集失败：' + ((e && e.message) || e) + '）');
    }
  };

  safe('环境', () => envSection(o, ctx));
  safe('模型配置（已脱敏）', () => configSection(ctx));
  safe('应用诊断日志 cf-diag.log', () => logSection(o, ctx, 'cf-diag.log',
    path.join(userDataDir, 'cf-diag.log'), limits.log));
  safe('抓取日志 cf-fetch.log', () => logSection(o, ctx, 'cf-fetch.log',
    dataDir ? path.join(dataDir, 'cf-fetch.log') : null, limits.log));
  safe('学员档案日志 profile-log.jsonl', () => logSection(o, ctx, 'profile-log.jsonl',
    dataDir ? path.join(dataDir, 'profile-log.jsonl') : null, limits.log));
  safe('学员档案 profile-card.json', () => {
    const p = dataDir ? path.join(dataDir, 'profile-card.json') : null;
    const s = p ? readTextSafe(p) : null;
    return s == null ? '（没有这个文件）' : s;
  });
  safe('题面缓存台账 cf-problems/', () => problemCacheSection(ctx));
  safe('工作区 workspace/', () => workspaceSection(o, ctx, limits));
  safe('会话 conversations/', () => conversationSection(o, ctx, limits));
  safe('跑分与消融记录', () => ablationSection(o, ctx, limits));
  for (const ex of (o.extra || [])) {
    if (ex && ex.name) safe(String(ex.name), () => String(ex.text == null ? '' : ex.text));
  }

  const head = [
    '============================================================',
    'cf-coach 诊断包 v' + VERSION,
    '生成时间：' + now.toISOString(),
    '本文件按顺序包含：' + sections.map((s) => s.name).join(' / '),
    '所有 API key、cookie、邮箱、系统用户名都已自动打码 —— 直接把它发出去即可（也可以先自己扫一眼）。',
    '解题代码只以片段形式出现（模型回答前 600 字符 / 工具结果前 300 字符），完整代码与完整题面正文不进包，体积已分段裁剪。',
    '============================================================'
  ].join('\n');

  const text = head + '\n' + parts.join('') + '\n===== 诊断包结束 =====\n';
  return {
    text,
    sections,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    dataDir: dataDir || null,
    userDataDir,
    limits
  };
}

/**
 * 写盘。缺省写到 `<dataDir>/diag/cfcoach-diag-<时间>.txt`。
 * @returns {{file:string, bytes:number, chars:number, sections:object[], warnings:string[], dataDir:string}}
 */
function write(opts) {
  const o = opts || {};
  const r = collect(o);
  const dir = o.outDir || diagDir(r.dataDir) || os.tmpdir();
  const file = o.file || path.join(dir, defaultFileName(o.now));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text, 'utf8');
  return { file, bytes: r.bytes, chars: r.chars, sections: r.sections, warnings: r.warnings, dataDir: r.dataDir };
}

module.exports = {
  VERSION,
  DEFAULT_LIMITS,
  redact,
  mask,
  collect,
  write,
  clip,
  bytes,
  appDataDir,
  defaultUserDataDir,
  dataDirCandidates,
  pickDataDir,
  diagDir,
  defaultFileName
};
