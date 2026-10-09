/**
 * 实验记录：把每次运行的**可审计**信息落成 JSONL。
 *
 * 审计要求（做消融是为了"证明有提升"，所以原始记录必须能自证）：
 *  - 题面：记题面文件的 sha256（证明三档拿到的是同一份文本）
 *  - 提示词：整段 system prompt + 参数（temperature/maxTokens/model/工具名）
 *  - 用量：prompt/completion tokens + 按 cf-coach 的价目表算出的花费
 *  - 产出：最终代码、原始回答全文、L1 的完整工具调用流水
 */
'use strict';

const fs = require('fs');
const path = require('path');
const pricing = require('../../lib/pricing');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 代码块语言标记 → 我们的语言名（cpp | python） */
function normLang(info, body) {
  const t = String(info || '').toLowerCase();
  if (/cpp|c\+\+|cc|g\+\+/.test(t)) return 'cpp';
  if (/py|python/.test(t)) return 'python';
  const b = String(body || '');
  if (/#include\s*</.test(b) || /int\s+main\s*\(/.test(b)) return 'cpp';
  if (/^\s*(import |from |def |n\s*=)/m.test(b) || /input\s*\(/.test(b)) return 'python';
  return '';
}

/**
 * 从模型回答里抽"最终代码"。
 * L0 只给纯文本，所以这条抽不出来就等于该题失败（如实记为 no-code，绝不替模型补代码）。
 * @returns {{lang:string, code:string, blockIndex:number}|null}
 */
function extractFinalCode(text) {
  const s = String(text || '');
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  const blocks = [];
  while ((m = re.exec(s)) !== null) {
    const lang = normLang(m[1], m[2]);
    if (lang && String(m[2]).trim()) blocks.push({ lang, code: String(m[2]).replace(/\s+$/, ''), blockIndex: blocks.length });
  }
  if (!blocks.length) {
    // 没有围栏：整段里找 #include 或 def/print 的开头，尽量不做聪明猜测
    const ci = s.search(/#include\s*</);
    if (ci >= 0) return { lang: 'cpp', code: s.slice(ci).trim(), blockIndex: -1 };
    const pi = s.search(/(?:^|\n)\s*(?:import |from |def |n\s*=|a\s*,\s*b\s*=)/);
    if (pi >= 0) return { lang: 'python', code: s.slice(pi).trim(), blockIndex: -1 };
    return null;
  }
  // 取最后一个代码块（模型习惯把最终版放最后；这也是最不容易"抽到中间草稿"的口径）
  const last = blocks[blocks.length - 1];
  return { lang: last.lang, code: last.code, blockIndex: last.blockIndex };
}

/** 由 token 用量算钱（复用 cf-coach 的价目表；表里没有的模型返回 null） */
function costOf(cfg, providerId, model, usage) {
  try {
    return pricing.estimateCost(cfg, providerId, model, usage || {});
  } catch {
    return null;
  }
}

function fileStamp(file) {
  const stat = fs.statSync(file);
  return { file, bytes: stat.size, mtime: stat.mtime.toISOString() };
}

/** 批次号（YYYYMMDD-HHMMSS）：一次"开始跑"= 一个批次，用于按轮次隔离工作区与文档 */
function runId(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + p(x.getMonth() + 1) + p(x.getDate()) + '-' + p(x.getHours()) + p(x.getMinutes()) + p(x.getSeconds());
}

/** 一次实验的输出目录：records.jsonl / summary.json / answers/ / transcript/ / sandbox/ */
function openRun(outDir) {
  ensureDir(outDir);
  ensureDir(path.join(outDir, 'answers'));
  ensureDir(path.join(outDir, 'transcript'));
  ensureDir(path.join(outDir, 'sandbox'));
  const recordsFile = path.join(outDir, 'records.jsonl');
  const records = [];
  // 这个 store 里**以前批次**的行（本批次 add() 会往后面追加，收尾时要把它们原样留在前面）
  const priorLines = fs.existsSync(recordsFile)
    ? fs.readFileSync(recordsFile, 'utf8').split('\n').filter(Boolean)
    : [];
  const id = runId();
  return {
    id,
    outDir,
    recordsFile,
    records,
    priorLines,
    answerPath(name) { return path.join(outDir, 'answers', name + '.md'); },
    transcriptPath(name) { return path.join(outDir, 'transcript', name + '.jsonl'); },
    sandboxDir(name) { return ensureDir(path.join(outDir, 'sandbox', name)); },
    saveAnswer(name, text) {
      const p = this.answerPath(name);
      fs.writeFileSync(p, String(text == null ? '' : text), 'utf8');
      return p;
    },
    saveTranscript(name, events) {
      const p = this.transcriptPath(name);
      fs.writeFileSync(p, (events || []).map((e) => JSON.stringify(e)).join('\n') + ((events || []).length ? '\n' : ''), 'utf8');
      return p;
    },
    add(rec) {
      records.push(rec);
      fs.appendFileSync(recordsFile, JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    },
    /**
     * 收尾：把内存里补全后的记录（带 cost / requestFingerprint）写回 records.jsonl。
     *
     * **同一个 store 是"一批题在同一把尺子下的全部证据"**，跨批次累积才读得出"这道题一共花了多少钱"。
     * 所以这里必须把以前批次的行留在前面 —— 曾经是 `writeFileSync(recordsFile, records.map(...))`
     * 直接覆盖，对同一个 store 跑第二批就把第一批整批抹掉（2026-10-10 实测：recheck2-m1 先后三次
     * 调用只剩最后 1 条，2101E/2247D2/2247F/2250F/2241D/2267F2 六格的记录全丢，花掉的钱却已经花了）。
     * @returns {number} 写回后文件里的总行数
     */
    finalize() {
      const all = priorLines.concat(records.map((r) => JSON.stringify(r)));
      fs.writeFileSync(recordsFile, all.join('\n') + (all.length ? '\n' : ''), 'utf8');
      return all.length;
    },
    /**
     * 整体重写，**不拼 priorLines**：调用方自己就是全部历史的持有者。
     *
     * 工作台（`ablation/serve.js`）在 `openRun` 之后会 `store.records().forEach((r) => run.records.push(r))`
     * —— 它把 store 里已有的行装进了 `records`，所以收尾只能按 `records` 整体重写：
     * 再用 `finalize()` 就会把历史写两遍（2026-10-10 实测：工作台 e2e 四格的行数直接翻倍，11 → 22）。
     * @returns {number} 写回后文件里的总行数
     */
    rewriteAll() {
      const all = records.map((r) => JSON.stringify(r));
      fs.writeFileSync(recordsFile, all.join('\n') + (all.length ? '\n' : ''), 'utf8');
      return all.length;
    },
    writeSummary(extra) {
      const byLevel = {};
      for (const r of records) {
        const g = byLevel[r.level] = byLevel[r.level] || { runs: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0, cost: 0, ms: 0, unpriced: 0 };
        g.runs++;
        if (r.ok) g.ok++; else g.failed++;
        g.promptTokens += (r.usage && r.usage.promptTokens) || 0;
        g.completionTokens += (r.usage && r.usage.completionTokens) || 0;
        g.ms += r.ms || 0;
        if (r.cost && typeof r.cost.amount === 'number') g.cost += r.cost.amount; else g.unpriced++;
      }
      const summary = Object.assign({
        generatedAt: new Date().toISOString(),
        runs: records.length,
        recordsFile,
        byLevel
      }, extra || {});
      fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
      return summary;
    }
  };
}

module.exports = { ensureDir, normLang, extractFinalCode, costOf, fileStamp, openRun, runId };
