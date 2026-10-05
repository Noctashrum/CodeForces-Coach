#!/usr/bin/env node
/**
 * 人工消融测试台（零依赖 Node HTTP，本机 127.0.0.1）。
 *
 * 它要回答的问题只有一个（用户口径）：
 *   **同一道题，cf-coach（L2）做的会不会"不如"裸模型（L0）？**
 *   只要不差于 L0（打平或更好），这个项目至少不帮倒忙。
 *
 * 所以这个台子做三件事：
 *   ① 攒题：粘贴题面（官方样例自动解析）+ 贴一份**外部 AC 题解当 oracle**（⛔ 不许用 L2 自己产的）
 *   ② 一键跑：同一题同一题面，跑 L0（一次调用）与 L2（cf-coach 无头跑，含验证链与图文文档）
 *   ③ 判分 + 人工判定：样例 / 与 oracle 差分（AC|WA）+ 链有没有"假自信"；人再并排读两份答案，
 *      记 coach 更好 / 打平 / L0 更好 / 两个都不行 —— 这才是"讲解质量"的轴
 *
 * 用法：
 *   node ablation/serve.js                                  # 用 data/config.json 里的服务商
 *   node ablation/serve.js --port 4311 --root ablation/out/ui --iterations 60
 *   node ablation/serve.js --base-url http://127.0.0.1:3996/v1 --api-key mock --model mock-gpt-4   # 假模型自测
 *
 * 安全：只监听 127.0.0.1；不做任何外网请求（除了你自己配置的模型服务商）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const env = require('./lib/env');
const record = require('./lib/record');
const levels = require('./lib/levels');
const l2 = require('./lib/l2');
const uistore = require('./lib/uistore');
const cffetch = require('./lib/cffetch');
const mkgen = require('./lib/mkgen');
const judgeLib = require('./judge');
const workspace = require('../lib/workspace');
const agentloop = require('../lib/agentloop');

function usage() {
  console.log([
    '人工消融测试台：node ablation/serve.js [选项]',
    '',
    '  --port N             端口（默认 4311，只监听 127.0.0.1）',
    '  --root DIR           数据目录（默认 ablation/out/ui）',
    '  --model NAME         模型名（默认取 data/config.json 的默认服务商）',
    '  --provider-id ID     服务商 id',
    '  --base-url URL       直接指定服务商地址（测试用，如本地 mock）+ --api-key KEY',
    '  --max-tokens N       单次输出上限（0/缺省 = 不发这个字段）',
    '  --iterations N       默认对拍组数（默认 60）',
    '  --max-steps N        L1 工具循环上限（默认 20）',
    '  --lang python|cpp    L2 交题解的语言（默认 python）',
    '  --depth L1|L2|L3     L2 讲解深度（默认 L3）',
    '  --no-rich            不生成图文文档（默认生成，人工要读它）',
    '  --open               启动后打印地址（默认就打印）'
  ].join('\n'));
}

const args = env.parseArgs(process.argv.slice(2));
if (args.help || args.h) { usage(); process.exit(0); }

const PORT = env.num(args.port, 4311);
const ROOT = args.root ? path.resolve(String(args.root)) : path.join(__dirname, 'out', 'ui');
const store = uistore.init(ROOT);
const cfg = env.loadAppConfig();
const targets = env.resolveTargets(args);
const params = env.resolveParams(args);
const DEFAULTS = {
  iterations: env.num(args.iterations, 60),
  maxSteps: env.num(args.maxSteps, 20),
  lang: args.lang === 'cpp' ? 'cpp' : 'python',
  depth: args.depth ? String(args.depth).toUpperCase() : 'L3',
  rich: args.rich === false || args.noRich ? false : env.bool(args.rich, true),
  maxStressMs: env.num(args.maxStressMs, 90000)
};

/* ---------------- 事件流（SSE）：跑分与判分的实时进度 ---------------- */
const clients = new Set();
const ring = [];
function emit(ev) {
  const e = Object.assign({ at: Date.now() }, ev);
  ring.push(e);
  if (ring.length > 600) ring.shift();
  const line = 'data: ' + JSON.stringify(e) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch { /* 断了就算了 */ } }
}
function logEvent(text) { emit({ type: 'log', text: String(text) }); }

/* ---------------- 跑分 ---------------- */
let job = null;

function fitRec(rec, target, problem, t0) {
  rec.cost = record.costOf(cfg, target.providerId, target.model, rec.usage);
  rec.statementSha = problem.statementSha;
  rec.statementFile = problem.statementFile;
  if (agentloop.hasLeakMarkup(rec.code || '')) rec.codeLeakMarkup = true;
  rec.requestFingerprint = {
    model: target.model, providerId: target.providerId, baseUrl: target.provider.baseUrl,
    stream: true, maxTokens: params.maxTokens || null,
    toolNames: rec.tools && rec.tools.length ? rec.tools : [],
    leakMarkupInAnswer: !!rec.leakMarkup
  };
  if (!rec.ms) rec.ms = Date.now() - t0;
  return rec;
}

function rewriteRecords(run) {
  fs.writeFileSync(run.recordsFile, run.records.map((r) => JSON.stringify(r)).join('\n') + (run.records.length ? '\n' : ''), 'utf8');
}

async function startRun(o) {
  if (job && job.running) throw new Error('已经有一个跑分任务在跑（先等它结束或点取消）');
  const ids = Array.isArray(o.ids) && o.ids.length ? o.ids : store.problems.map((p) => p.id);
  const wanted = (Array.isArray(o.levels) && o.levels.length ? o.levels : ['L0', 'L2']).map((s) => String(s).toUpperCase());
  for (const l of wanted) if (['L0', 'L1', 'L2'].indexOf(l) < 0) throw new Error('未知档位：' + l);
  const opts = Object.assign({}, DEFAULTS, {
    iterations: o.iterations != null && o.iterations !== '' ? Number(o.iterations) : DEFAULTS.iterations,
    lang: o.lang ? (String(o.lang) === 'cpp' ? 'cpp' : 'python') : DEFAULTS.lang,
    depth: o.depth ? String(o.depth).toUpperCase() : DEFAULTS.depth,
    rich: o.rich != null ? !!o.rich : DEFAULTS.rich
  });
  const problems = store.runtimeAll(ids).filter((p) => p.statement && p.statement.trim());
  if (!problems.length) throw new Error('没有可跑的题：先在界面上加题（题面必须有）');

  const jobs = [];
  for (const p of problems) for (const lv of wanted) jobs.push({ problem: p, level: lv, name: lv + '-' + p.id });
  const run = record.openRun(store.dir);
  store.records().forEach((r) => run.records.push(r));   // 保住历史（最后整体重写 records.jsonl）
  const target = targets[0];
  job = { running: true, cancelled: false, startedAt: Date.now(), done: 0, total: jobs.length, current: null, opts };
  emit({ type: 'runStart', total: jobs.length, levels: wanted, problems: problems.map((p) => p.id), model: target.providerId + '::' + target.model, opts });
  logEvent('用 ' + target.providerId + '::' + target.model + ' 跑 ' + jobs.length + ' 个 (题×档)，并发 1（L2 内部本来就多角色，串行才能看清）');

  for (const j of jobs) {
    if (job.cancelled) break;
    job.current = j.name;
    emit({ type: 'jobStart', name: j.name, level: j.level, problem: j.problem.id, done: job.done, total: job.total });
    const ctx = { problem: j.problem, statement: j.problem.statement, target, params, run, name: j.name, maxSteps: opts.maxSteps, iterations: opts.iterations };
    const t0 = Date.now();
    let rec;
    try {
      if (j.level === 'L0') rec = await levels.runL0(ctx);
      else if (j.level === 'L1') rec = await levels.runL1(ctx);
      else {
        // 每次都要干净的工作区：否则链会走"上次已对拍通过"的快通道 —— 测出来的就不是模型，而是缓存
        try { workspace.removeWorkspace(workspace.keyFor(l2.convFor(j.problem))); } catch { /* 没有就算了 */ }
        rec = await l2.runL2(Object.assign({}, ctx, { lang: opts.lang, rich: !!opts.rich, depth: opts.depth, maxStressMs: opts.maxStressMs }));
      }
    } catch (e) {
      rec = { level: j.level, problem: j.problem.id, model: target.model, ok: false, error: String((e && e.message) || e), usage: null, ms: Date.now() - t0 };
      run.add(rec);
    }
    fitRec(rec, target, j.problem, t0);
    job.done++;
    emit({
      type: 'jobDone', name: j.name, level: j.level, problem: j.problem.id,
      ok: rec.ok !== false, ms: Date.now() - t0, usage: rec.usage || null, cost: rec.cost || null,
      codeSource: rec.codeSource || null, error: rec.error || null,
      verification: rec.level === 'L2' ? {
        status: rec.verificationStatus || null, assertedVerified: rec.assertedVerified === true,
        scopeComplete: rec.scopeComplete === true, delivered: rec.delivered || null, scopeNote: rec.scopeNote || null,
        docFile: rec.docFile ? path.basename(rec.docFile) : null
      } : null
    });
    rewriteRecords(run);   // 每题都落盘：中途崩了也不丢
  }
  rewriteRecords(run);
  const cancelled = job.cancelled;
  const done = job.done;
  job.running = false;
  const summary = run.writeSummary({ source: 'serve', problems: problems.map((p) => p.id), levels: wanted });
  emit({ type: 'runEnd', cancelled, done, total: jobs.length, summary });
  return summary;
}

/* ---------------- 判分 ---------------- */
async function runJudge(o) {
  if (job && job.running) throw new Error('跑分任务还在跑，等它结束再判分');
  const iterations = o && o.iterations != null && o.iterations !== '' ? Number(o.iterations) : DEFAULTS.iterations;
  const problems = store.runtimeAll();
  if (!problems.length) throw new Error('题库是空的');
  const withoutOracle = problems.filter((p) => !p.oracle || !p.gen);
  if (withoutOracle.length) logEvent('⚠️ 这些题缺 oracle 或生成器，只能判样例、差分记 no-oracle：' + withoutOracle.map((p) => p.id).join(', '));
  emit({ type: 'judgeStart', iterations, problems: problems.length });
  const r = await judgeLib.judgeAll(
    { outDir: store.dir, problems, records: store.latestRecords(), iterations, human: store.human() },
    {
      log: logEvent,
      onVerdict: (v, i, total) => emit({ type: 'verdict', verdict: v, done: i + 1, total })
    }
  );
  emit({ type: 'judgeEnd', compare: r.cmp, byLevel: r.byLevel, verdicts: r.verdicts.length });
  return r;
}

/* ---------------- 攒题：从 CF 取题 + 自动写生成器 ---------------- */

/** 写生成器是"一次模型调用"，不许两件同时跑（也不许和跑分抢模型） */
let genBusy = false;

/**
 * 复用应用自己的取题通道（electron/main.js 的 CHATBOX_CF_API_TEST + CHATBOX_CF_JSON）把题扒进题库。
 *
 * 已有的 oracle / 生成器**原样保留**：save() 在没给 oracleCode/genCode 时会沿用旧文件，
 * 所以"先贴 oracle，再重新取一次题面"不会把用户贴的代码弄丢。
 */
async function cfFetchInto(ref) {
  if (job && job.running) return { ok: false, error: '跑分任务在跑，等它结束再取题' };
  logEvent('取题：' + String(ref || '') + '（借应用内嵌浏览器过 CF 反爬，实测 20–60 秒）');
  const r = await cffetch.fetchProblem(String(ref || ''), { log: logEvent });
  if (!r.ok) { logEvent('取题失败：' + r.error); return { ok: false, error: r.error, logTail: r.logTail || '' }; }
  const incoming = cffetch.toStoreProblem(r.problem);
  const prev = store.get(incoming.id) || {};
  const saved = store.save({
    id: incoming.id, title: incoming.title, rating: incoming.rating, url: incoming.url,
    source: 'cf',
    note: prev.note || incoming.note,     // 用户自己写的备注别被 CF 的 tags 顶掉
    statement: incoming.statement,
    samples: incoming.samples
  });
  (r.problem.warnings || []).forEach((w) => logEvent('⚠️ 取题告警：' + w));
  logEvent('已入库：' + saved.id + ' ' + saved.title + '（题面 ' + String(saved.statement || '').length + ' 字，样例 '
    + (saved.samples || []).length + ' 组' + (saved.oracle ? '，oracle 已有' : '，还缺 oracle（贴你自己的 AC 题解）') + '）');
  return {
    ok: true, id: saved.id, title: saved.title, rating: saved.rating,
    samples: (saved.samples || []).length, statementLen: String(saved.statement || '').length,
    hasOracle: !!saved.oracle, hasGen: !!saved.gen, ms: r.ms
  };
}

/** 给一道题写生成器：一次模型调用 + 机械体检（见 ablation/lib/mkgen.js） */
async function makeGenFor(id) {
  const p = store.get(String(id || '').trim());
  if (!p) return { ok: false, error: '没有这道题：' + id };
  const oracleCode = readCode(p.oracle);
  if (!oracleCode.trim()) return { ok: false, error: '这题还没有 oracle：先贴一份你自己的 AC 题解（生成器要照它的输入格式写）' };
  const target = targets[0];
  if (!target) return { ok: false, error: '没有可用模型（用 --base-url/--model 或配 data/config.json）' };
  logEvent('写生成器：' + p.id + '（一次模型调用 + 跑代码体检）');
  const r = await mkgen.makeGen({
    problem: p, statement: p.statement,
    oracle: { lang: p.oracleLang, code: oracleCode },
    target, params
  });
  if (!r.ok) {
    logEvent('生成器体检没过：' + p.id + '：' + r.error);
    return { ok: false, error: r.error, usage: r.usage || null, calls: r.calls || 1, ms: r.ms || 0 };
  }
  store.save({ id: p.id, genLang: r.lang, genCode: r.code });
  ((r.gate && r.gate.warnings) || []).forEach((w) => logEvent('⚠️ ' + p.id + '：' + w));
  logEvent('生成器已写入：' + p.id + '（' + (r.lang === 'cpp' ? 'C++' : 'Python') + '，体检通过'
    + (((r.gate && r.gate.warnings) || []).length ? '，有 ' + r.gate.warnings.length + ' 条提醒' : '') + '）');
  return { ok: true, id: p.id, lang: r.lang, code: r.code, gate: r.gate, usage: r.usage || null, calls: r.calls || 1, ms: r.ms || 0 };
}

/** 批量补生成器：默认只补"有 oracle 但没生成器"的题 */
async function makeGensFor(ids, onlyMissing) {
  const all = (Array.isArray(ids) && ids.length) ? ids.map(String) : store.problems.map((p) => p.id);
  const todo = onlyMissing === false ? all : all.filter((id) => {
    const p = store.get(id);
    return p && !(p.gen && p.gen.file);
  });
  if (!todo.length) {
    logEvent('没有需要补生成器的题（要么都有生成器了，要么题库是空的）');
    return { ok: true, results: [] };
  }
  logEvent('补生成器：' + todo.length + ' 题（' + todo.join(', ') + '），一题一次模型调用');
  const results = [];
  for (const id of todo) {
    const r = await makeGenFor(id);
    results.push({ id, ok: !!r.ok, error: r.error || null, warnings: (r.gate && r.gate.warnings) || [] });
    emit({ type: 'genDone', id, ok: !!r.ok, done: results.length, total: todo.length });
  }
  logEvent('补生成器完成：' + results.filter((x) => x.ok).length + '/' + results.length + ' 成功');
  return { ok: true, results };
}

/* ---------------- HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj == null ? null : obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'content-type': (type || 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) { reject(new Error('请求体太大')); req.destroy(); } });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function readCode(f) { try { return f && f.file && fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : ''; } catch { return ''; } }

function stateOf() {
  return {
    root: store.dir,
    defaults: DEFAULTS,
    targets: targets.map((t) => ({ providerId: t.providerId, model: t.model })),
    running: !!(job && job.running),
    genBusy,
    job: job ? { running: job.running, cancelled: job.cancelled, startedAt: job.startedAt, done: job.done, total: job.total, current: job.current, opts: job.opts } : null,
    problems: store.list().map((p) => ({
      id: p.id, title: p.title, rating: p.rating, url: p.url, note: p.note, source: p.source,
      statement: p.statement, samples: p.samples || [], statementSha: p.statementSha,
      oracleLang: p.oracleLang, genLang: p.genLang,
      oracleCode: readCode(p.oracle), genCode: readCode(p.gen),
      hasOracle: !!(p.oracle && p.oracle.file), hasGen: !!(p.gen && p.gen.file)
    })),
    records: store.latestRecords().map((r) => ({
      level: r.level, problem: r.problem, model: r.model, ok: r.ok !== false, error: r.error || null,
      ms: r.ms || 0, usage: r.usage || null, cost: r.cost || null, code: r.code || null, codeLang: r.codeLang || null,
      codeSource: r.codeSource || null, answerFile: r.answerFile || null, answerName: r.answerFile ? path.basename(r.answerFile) : null, docFile: r.docFile ? path.basename(r.docFile) : null,
      verificationStatus: r.verificationStatus || null, assertedVerified: r.assertedVerified === true,
      scopeComplete: r.scopeComplete === true, delivered: r.delivered || null, scopeNote: r.scopeNote || null,
      trajectory: (r.trajectory || []).slice(-12), notes: r.notes || [], startedAt: r.startedAt || null
    })),
    verdicts: store.verdicts(),
    compare: store.compare(),
    human: store.human(),
    events: ring.slice(-120)
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
      return sendText(res, 200, html, 'text/html');
    }
    if (req.method === 'GET' && p.startsWith('/ui/')) {
      const rel = p.slice(4).replace(/\.\./g, '');
      const file = path.join(__dirname, 'ui', rel);
      if (!file.startsWith(path.join(__dirname, 'ui'))) return sendText(res, 403, 'no');
      if (!fs.existsSync(file)) return sendText(res, 404, 'not found');
      const type = /\.css$/.test(file) ? 'text/css' : (/\.js$/.test(file) ? 'text/javascript' : 'text/plain');
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), type);
    }
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, stateOf());
    if (req.method === 'GET' && p.startsWith('/api/doc/')) {
      const name = path.basename(decodeURIComponent(p.slice('/api/doc/'.length)));
      const file = path.join(store.dirs.docs, name);
      if (!fs.existsSync(file)) return sendText(res, 404, '这套记录没有图文文档（跑的时候勾了"生成图文文档"吗？）', 'text/plain');
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), 'text/html');
    }
    if (req.method === 'GET' && p.startsWith('/api/answer/')) {
      const name = path.basename(decodeURIComponent(p.slice('/api/answer/'.length)));
      const file = path.join(store.dirs.answers, name);
      if (!fs.existsSync(file)) return sendText(res, 404, '没有这份回答', 'text/plain');
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), 'text/plain');
    }
    if (req.method === 'GET' && p === '/api/export') {
      return sendJson(res, 200, {
        exportedAt: new Date().toISOString(), root: store.dir, defaults: DEFAULTS,
        problems: store.list(), records: store.latestRecords(), verdicts: store.verdicts(),
        compare: store.compare(), human: store.human()
      });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      ring.slice(-60).forEach((e) => { try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch { /* ignore */ } });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && p === '/api/problems') {
      const body = await readBody(req);
      const saved = store.save(body.problem || body);
      return sendJson(res, 200, { ok: true, problem: { id: saved.id, title: saved.title, hasOracle: !!saved.oracle, hasGen: !!saved.gen, samples: (saved.samples || []).length } });
    }
    if (req.method === 'POST' && p === '/api/problems/delete') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: store.remove(String(body.id || '')) });
    }
    if (req.method === 'POST' && p === '/api/run') {
      const body = await readBody(req);
      if (job && job.running) return sendJson(res, 409, { error: '已有跑分任务在跑' });
      // 不 await：立刻返回，进度走 SSE
      startRun(body).catch((e) => { if (job) job.running = false; emit({ type: 'error', error: String((e && e.message) || e) }); logEvent('跑分失败：' + ((e && e.message) || e)); });
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/cancel') {
      if (job && job.running) { job.cancelled = true; logEvent('收到取消：当前这道跑完就停'); return sendJson(res, 200, { ok: true, cancelling: true }); }
      return sendJson(res, 200, { ok: true, running: false });
    }
    if (req.method === 'POST' && p === '/api/judge') {
      const body = await readBody(req);
      if (job && job.running) return sendJson(res, 409, { error: '跑分任务还在跑' });
      runJudge(body).catch((e) => emit({ type: 'error', error: String((e && e.message) || e) }));
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/human') {
      const body = await readBody(req);
      const e = store.saveHuman({ problem: String(body.problem || ''), choice: String(body.choice || ''), note: String(body.note || ''), tags: body.tags || undefined, level: String(body.level || 'L2') });
      return sendJson(res, 200, { ok: true, entry: e });
    }
    if (req.method === 'POST' && p === '/api/cf-fetch') {
      const body = await readBody(req);
      // 取题本身要 20–60 秒：等它（前端有转圈 + SSE 日志），不要让它变成"后台静默任务"
      return sendJson(res, 200, await cfFetchInto(body.ref != null ? body.ref : body.id));
    }
    if (req.method === 'POST' && p === '/api/make-gen') {
      const body = await readBody(req);
      if (genBusy) return sendJson(res, 409, { error: '正在写生成器，等它结束' });
      genBusy = true;
      try { return sendJson(res, 200, await makeGenFor(body.id)); }
      finally { genBusy = false; }
    }
    if (req.method === 'POST' && p === '/api/make-gens') {
      const body = await readBody(req);
      if (genBusy) return sendJson(res, 409, { error: '正在写生成器，等它结束' });
      genBusy = true;
      // 不 await：一题一次模型调用，10 题可能好几分钟 —— 进度走 SSE（与跑分同一个套路）
      makeGensFor(body.ids, body.onlyMissing !== false)
        .catch((e) => { const m = String((e && e.message) || e); logEvent('补生成器失败：' + m); emit({ type: 'error', error: m }); })
        .finally(() => { genBusy = false; emit({ type: 'gensEnd' }); });
      return sendJson(res, 200, { ok: true, started: true });
    }
    if (req.method === 'POST' && p === '/api/clear') {
      const body = await readBody(req);
      if (body.records) store.clearHistory();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'no route ' + req.method + ' ' + p });
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('人工消融测试台：http://127.0.0.1:' + PORT + '/');
  console.log('数据目录：' + store.dir);
  console.log('模型：' + targets.map((t) => t.providerId + '::' + t.model).join('  ') + '（对拍组数默认 ' + DEFAULTS.iterations + '，L2 语言 ' + DEFAULTS.lang + '，图文文档 ' + (DEFAULTS.rich ? '开' : '关') + '）');
  console.log('题库：' + store.problems.length + ' 题' + (store.problems.length ? ('（' + store.problems.map((p) => p.id).join(', ') + '）') : '（先在界面上加题）'));
});
