#!/usr/bin/env node
/**
 * 把 cf-coach（L2）自己的回答导入同一份 records.jsonl —— 三档共用一套判分脚本。
 *
 * 取哪份代码当 L2 的"最终答案"（按可信度从高到低）：
 *   ① 本题工作区里已验证通过的正解文件（data/workspace/cf-<题号>/sol.py | sol.cpp）—— 这是它真正交付的产物
 *   ② --code-file 显式指定的文件
 *   ③ 回答正文里的最后一个代码块
 *   ④ 图文文档（richDoc）里的代码块（正文只有引子时走这条）
 *
 * 用法：
 *   node ablation/import-l2.js --conv c_muj2cxsjc1640c --out ablation/out/trial1
 *   node ablation/import-l2.js --conv data/conversations/c_x.json --problem 1800C --code-file my.cpp
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const problemsLib = require('./lib/problems');
const record = require('./lib/record');

function findConvFile(idOrPath) {
  if (fs.existsSync(idOrPath)) return path.resolve(idOrPath);
  const base = env.dataDir();
  for (const sub of ['conversations', 'archive']) {
    const p = path.join(base, sub, idOrPath + '.json');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到会话文件：' + idOrPath + '（也没在 ' + path.join(base, 'conversations') + ' 下找到）');
}

function codeFromHtml(html) {
  const blocks = [];
  const re = /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) blocks.push(m[1]);
  if (!blocks.length) return null;
  const raw = blocks[blocks.length - 1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return record.extractFinalCode('```\n' + raw + '\n```');
}

function workspaceCode(problemId) {
  if (!problemId) return null;
  const dir = path.join(env.dataDir(), 'workspace', 'cf-' + problemId);
  if (!fs.existsSync(dir)) return null;
  for (const n of ['sol.cpp', 'solution.cpp', 'main.cpp', 'sol.py', 'solution.py', 'main.py']) {
    const p = path.join(dir, n);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        return { lang: /\.py$/.test(n) ? 'python' : 'cpp', code: fs.readFileSync(p, 'utf8'), source: 'workspace:' + n };
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

function main() {
  const args = env.parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args.conv) {
    console.log('用法：node ablation/import-l2.js --conv <会话id|文件> [--out DIR] [--problem 1800C] [--code-file PATH] [--last-only]');
    return;
  }
  const convFile = findConvFile(String(args.conv));
  const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
  const inferred = conv.cfProblem && conv.cfProblem.contestId && conv.cfProblem.index
    ? conv.cfProblem.contestId + conv.cfProblem.index : null;
  const problemId = String(args.problem || inferred || '');
  const outDir = args.out ? path.resolve(String(args.out)) : path.join(__dirname, 'out', 'l2-import');
  const run = record.openRun(outDir);

  let code = null;
  if (args.codeFile) {
    const p = path.resolve(String(args.codeFile));
    code = { lang: /\.py$/.test(p) ? 'python' : 'cpp', code: fs.readFileSync(p, 'utf8'), source: 'file:' + p };
  }
  if (!code) code = workspaceCode(problemId);

  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  const pairs = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    let ans = null;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'assistant' && msgs[j].status !== 'error' && String(msgs[j].content || '').trim()) { ans = msgs[j]; break; }
      if (msgs[j].role === 'user' && msgs[j] !== msgs[i]) break;
    }
    if (ans) pairs.push({ user: msgs[i], assistant: ans });
  }
  const chosen = args.lastOnly ? pairs.slice(-1) : pairs;
  if (!chosen.length) {
    console.log('这个会话里没有 "用户提问 → 助手回答" 的成对消息，什么都没导入。');
    return;
  }

  let n = 0;
  for (const pair of chosen) {
    const a = pair.assistant;
    let use = code;
    if (!use) {
      const fromText = record.extractFinalCode(a.content || '');
      use = fromText ? { lang: fromText.lang, code: fromText.code, source: 'answer' } : null;
    }
    if (!use) {
      const fromDoc = codeFromHtml(a.richDoc || (a.doc && a.doc.html) || '');
      use = fromDoc ? { lang: fromDoc.lang, code: fromDoc.code, source: 'richDoc' } : null;
    }
    const chips = Array.isArray(a.tools) ? a.tools : [];
    const usage = a.usage && (a.usage.promptTokens != null || a.usage.completionTokens != null)
      ? { promptTokens: a.usage.promptTokens || 0, completionTokens: a.usage.completionTokens || 0,
        calls: a.usage.calls || null, estimated: !!a.usage.estimated }
      : null;
    const name = 'L2-' + (problemId || 'unknown') + '-' + String(a.id || n).slice(-6);
    const rec = {
      level: 'L2',
      problem: problemId || null,
      model: a.model || conv.model || null,
      providerId: conv.providerId || null,
      startedAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
      ok: !!use,
      error: use ? null : '找不到 cf-coach 的最终代码（工作区没有正解文件，正文/文档里也没有代码块）',
      usage,
      cost: (a.usage && a.usage.cost) || null,
      steps: chips.length || null,
      calls: (a.usage && a.usage.calls) || null,
      toolsUsed: chips.map((c) => c.name).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i),
      code: use ? use.code : null,
      codeLang: use ? use.lang : null,
      codeSource: use ? 'l2:' + use.source : null,
      sourceConv: { file: convFile, convId: conv.id, messageId: a.id || null },
      statementSha: null,
      requestFingerprint: { model: a.model || conv.model, providerId: conv.providerId, source: 'cf-coach 会话导入', toolNames: chips.map((c) => c.name).filter(Boolean) },
      ms: null,
      answerFile: run.saveAnswer(name, a.content || '')
    };
    run.add(rec);
    n++;
  }
  // 保留同一个 store 里以前批次的行（见 lib/record.js 的 finalize 注释）
  run.finalize();
  console.log('导入 L2 记录 ' + n + ' 条 → ' + run.recordsFile);
  console.log('题号：' + (problemId || '(未知，请用 --problem 指定)') + '｜代码来源：' + (code ? code.source : '逐条从回答/文档里抽'));
  console.log('提示：判分前确认 problems.json 里这题有 samples 与 oracle——判分口径对三档必须完全一样。');
}

try { main(); } catch (e) { console.error('导入失败：' + ((e && e.stack) || e)); process.exit(1); }
