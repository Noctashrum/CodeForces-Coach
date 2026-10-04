/**
 * L2 档 = cf-coach 本体（无头跑）。
 *
 * 为什么要无头跑主程序，而不是"人在界面里点一遍"：
 *  ① 消融要的是**同一条链**（同样的 harness、同样的提示词、同样的判据）在几十道题上的结果，
 *     界面点击既不可复现也不可 diff；这里的 runPipeline 就是主程序自己调用的那个函数。
 *  ② 记录必须能自证：题面 sha、每个角色 Agent 的调用次数、验证报告（含覆盖范围）、最终交付的代码。
 *
 * 关键隔离：工作区根目录被指到 <实验目录>/l2-data/workspace，**绝不碰用户真实 data/**。
 *
 * 口径说明（写进记录，评审要看）：
 *  · L2 的"题面"和 L0/L1 用的是**同一份文本、同一个 sha**（信息预算对齐）；
 *  · L2 的最终代码取自**工作区里交付的文件**（= 人从界面上拿到的那个版本），不是过程产物；
 *  · `assertedVerified` = 链自己声称"已验证"（verification.status === 'ok'）。
 *    这个字段与判分结果对照，就能算出**假自信率**（声称已验证但差分判 WA 的比例）——
 *    这正是"验证链到底有没有用"最硬的指标。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('../../lib/harness');
const workspace = require('../../lib/workspace');
const llm = require('../../lib/llm');
const agentloop = require('../../lib/agentloop');
const env = require('./env');
const record = require('./record');

/** 系统提示词 → 角色（callAgent 一般会直接给 role，这里只作为兜底） */
const ROLE_MARKERS = [
  [/【题解 Agent】/, 'solution'],
  [/【暴力 Agent】/, 'brute'],
  [/【数据生成 Agent】/, 'gen'],
  [/【手算锚点 Agent】/, 'witness'],
  [/【讲解 Agent】/, 'explainer'],
  [/【讲解提纲 Agent】/, 'plan'],
  [/【路由判断器】/, 'router'],
  [/【做法评估 Agent】/, 'assess'],
  [/【错因仲裁 Agent】/, 'adjudicate']
];

function roleOf(system) {
  const s = String(system || '');
  for (const pair of ROLE_MARKERS) if (pair[0].test(s)) return pair[1];
  return 'other';
}

let wsRoot = null;

/** 工作区根目录指向实验目录（一个进程只设一次；幂等） */
function prepareWorkspace(outDir) {
  const root = path.join(outDir, 'l2-data');
  if (wsRoot !== root) {
    workspace.setRoot(root);
    wsRoot = root;
  }
  return root;
}

/** 造一个"会话对象"：有题号就用 cf-<contestId><index> 作共享键（与真实产品一致） */
function convFor(problem) {
  const hasCf = !!(problem.contestId && problem.index);
  return {
    id: hasCf ? ('cf-' + problem.contestId + String(problem.index).toUpperCase())
      : ('ab-' + String(problem.id || 'x').replace(/[^a-zA-Z0-9_-]/g, '')),
    cfProblem: hasCf ? { contestId: problem.contestId, index: problem.index, title: problem.name || '' } : null,
    title: problem.name || problem.id,
    problemMeta: { rating: problem.rating || null }
  };
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 跑一次 L2。
 * @param {{problem:object, statement:string, target:object, params:object, run:object, name:string,
 *          lang?:string, rich?:boolean, iterations?:number, maxStressMs?:number, depth?:string}} ctx
 */
async function runL2(ctx) {
  const { problem, statement, target, params, run, name } = ctx;
  const t0 = Date.now();
  prepareWorkspace(run.outDir);
  const conv = convFor(problem);
  const key = workspace.keyFor(conv);
  const lang = ctx.lang === 'cpp' ? 'cpp' : 'python';
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const byRole = {};
  const events = [];
  const rec = {
    level: 'L2', problem: problem.id, model: target.model, providerId: target.providerId,
    startedAt: new Date(t0).toISOString(),
    system: 'cf-coach harness.runPipeline（题解/暴力/生成器/对拍/仲裁/讲解 内部多 Agent 链）',
    tools: ['harness.runPipeline'],
    statementSha: env.sha256(statement), statementFile: problem.statementFile || null,
    request: {
      stream: true, hasTools: false, pipeline: 'cf-coach/runPipeline',
      intent: 'full', rich: !!ctx.rich, lang, wsKey: key,
      perTier: ctx.iterations || 30, maxStressMs: ctx.maxStressMs || 90000, depth: ctx.depth || 'L3'
    }
  };

  const callAgent = async (o) => {
    const role = (o && o.role) || roleOf(o && o.system);
    byRole[role] = (byRole[role] || 0) + 1;
    const label = (o && o.label) || role;
    const at = Date.now() - t0;
    events.push({ t: at, kind: 'agentStart', role, label });
    try {
      const res = await llm.callModel({
        provider: target.provider,
        model: target.model,
        system: o.system,
        messages: [{ role: 'user', content: o.user }],
        maxTokens: (o && o.maxTokens) || params.maxTokens || undefined,
        stream: (o && o.stream) !== false,
        signal: o && o.signal,
        onUsage: (u) => {
          if (u && u.promptTokens != null) { usage.promptTokens += u.promptTokens; usage.calls++; }
          if (u && u.completionTokens != null) usage.completionTokens += u.completionTokens;
          if (typeof o.onUsage === 'function') o.onUsage(u);
        },
        onMeta: typeof o.onMeta === 'function' ? o.onMeta : undefined
      });
      events.push({ t: Date.now() - t0, kind: 'agentEnd', role, label, ms: Date.now() - t0 - at, out: clip(res.content, 300) });
      return String(res.content || '');
    } catch (e) {
      events.push({ t: Date.now() - t0, kind: 'agentError', role, label, ms: Date.now() - t0 - at, error: clip((e && e.message) || e, 300) });
      throw e;
    }
  };

  try {
    const res = await harness.runPipeline({
      callAgent,
      workspace,
      wsKey: key,
      conv,
      lang,
      rating: problem.rating || null,
      statement,
      samples: problem.samples || [],
      intent: 'full',
      level: ctx.depth || 'L3',
      rich: !!ctx.rich,
      richTheme: 'dark',
      perTier: ctx.iterations || 30,
      maxStressMs: ctx.maxStressMs || 90000,
      log: () => {},
      emit: (ev) => {
        if (!ev || !ev.type) return;
        if (ev.type === 'tool' && Array.isArray(ev.calls)) {
          ev.calls.forEach((c) => events.push({ t: Date.now() - t0, kind: 'phaseStart', name: c.name, args: clip(c.args, 300) }));
        } else if (ev.type === 'toolResult' && Array.isArray(ev.results)) {
          ev.results.forEach((r2) => events.push({ t: Date.now() - t0, kind: 'phaseEnd', name: r2.name, ok: r2.ok !== false, summary: clip(r2.summary, 300) }));
        }
      }
    });

    const v = res.verification || null;
    // 交付物 = 工作区里那份题解（可能被 P0 回退过）；没有才回落到链内存里的代码，最后才是讲解正文
    const fromWs = workspace.readFile(key, workspace.solName(lang));
    let code = null;
    if (fromWs && fromWs.trim()) code = { code: fromWs, lang, source: 'workspace:' + workspace.solName(lang) };
    else if (res.solCode && res.solCode.trim()) code = { code: res.solCode, lang, source: 'pipeline:solCode' };
    else {
      const c = record.extractFinalCode(String(res.explainerText || ''));
      if (c) code = { code: c.code, lang: c.lang, source: 'explainer' };
    }

    rec.code = code ? code.code : null;
    rec.codeLang = code ? code.lang : null;
    rec.codeSource = code ? code.source : null;
    rec.ok = !!rec.code;
    rec.error = rec.ok ? null : ('验证链没有产出题解代码（status=' + (res.status || '?') + '）');
    rec.usage = {
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      calls: usage.calls, estimated: false
    };
    rec.calls = usage.calls;
    rec.steps = usage.calls;
    rec.roles = byRole;
    rec.toolsUsed = Object.keys(byRole);
    rec.verification = v;
    rec.verificationStatus = v ? v.status : null;
    rec.assertedVerified = !!(v && v.status === 'ok');
    rec.scopeComplete = v ? (v.scopeComplete !== false) : false;
    rec.delivered = v ? (v.delivered || null) : null;
    rec.solRollback = v ? !!v.solRollback : false;
    rec.stressTruncated = v ? (v.stressTruncated || '') : '';
    rec.scopeNote = v ? (v.scopeNote || '') : '';
    rec.iterationsRun = v ? (v.iterations || 0) : 0;
    rec.trajectory = (res.trajectory || []).slice(-40).map((x) => ({ kind: x.kind, note: clip(x.note, 300) }));
    rec.minimalCase = res.minimalCase || null;
    rec.notes = res.notes || [];
    rec.richFallback = res.richFallback || null;
    rec.workspace = { key, dir: workspace.convDir(key), files: (workspace.listFiles(key) || []).map((f) => f.name) };
    const answerText = String(res.explainerText || '');
    if (agentloop.hasLeakMarkup(answerText)) rec.leakMarkup = true;
    rec.answerFile = run.saveAnswer(name, agentloop.stripLeakMarkup(answerText));
    if (res.richDoc) {
      const docsDir = record.ensureDir(path.join(run.outDir, 'docs'));
      rec.docFile = path.join(docsDir, name + '.html');
      fs.writeFileSync(rec.docFile, res.richDoc, 'utf8');
      rec.richDocBytes = Buffer.byteLength(res.richDoc, 'utf8');
    }
    rec.transcriptFile = run.saveTranscript(name, events);
    rec.ms = Date.now() - t0;
    return run.add(rec);
  } catch (e) {
    rec.ok = false;
    rec.error = (e && e.message) || String(e);
    rec.usage = { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, calls: usage.calls, estimated: false };
    rec.calls = usage.calls;
    rec.roles = byRole;
    rec.toolsUsed = Object.keys(byRole);
    rec.ms = Date.now() - t0;
    rec.transcriptFile = run.saveTranscript(name, events);
    return run.add(rec);
  }
}

module.exports = { runL2, prepareWorkspace, convFor, roleOf };
