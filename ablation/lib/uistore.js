/**
 * 人工测试台的存储层（零依赖）：题目 / 记录 / 判分 / 人工判定，全部落在 --root 目录里。
 *
 * 为什么要单独一层：人工测试台要能在**同一个目录**里反复跑同一道题（改题面、改 oracle、重跑），
 * 所以"题面 / oracle / 生成器"必须落成文件（判分用的是 runner.stressTest，它只认文件），
 * 而 problems.json 只是这些文件的索引。
 *
 * 目录结构（root 默认 ablation/out/ui）：
 *   problems.json      题目索引（题面文本 + 样例 + oracle/gen 的语言与文件路径）
 *   statements/<id>.txt 题面（喂给三档的同一份文本）
 *   oracle/<id>.py|cpp  外部 AC 标准（⛔ 绝不能是 L2 自己产出的）
 *   gen/<id>.py|cpp     随机数据生成器（可按 argv 控制规模）
 *   records.jsonl       每次 (题×档) 一行（run.js 的记录格式）
 *   answers/ transcript/ sandbox/ docs/  L0/L1/L2 的产出留档
 *   verdicts.jsonl      判分明细；compare.json 配对比较；human.jsonl 人工判定
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');
const statementLib = require('../../lib/statement');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function extOf(lang) { return String(lang) === 'cpp' ? 'cpp' : 'py'; }

function init(rootDir) {
  const dir = path.resolve(String(rootDir));
  const dirs = {
    statements: path.join(dir, 'statements'),
    oracle: path.join(dir, 'oracle'),
    gen: path.join(dir, 'gen'),
    answers: path.join(dir, 'answers'),
    transcript: path.join(dir, 'transcript'),
    docs: path.join(dir, 'docs'),
    sandbox: path.join(dir, 'sandbox')
  };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const problemsFile = path.join(dir, 'problems.json');
  let problems = readJson(problemsFile, []);
  if (!Array.isArray(problems)) problems = [];

  const store = {
    dir,
    dirs,
    problemsFile,
    get problems() { return problems; },
    recordsFile: path.join(dir, 'records.jsonl'),
    verdictsFile: path.join(dir, 'verdicts.jsonl'),
    compareFile: path.join(dir, 'compare.json'),
    humanFile: path.join(dir, 'human.jsonl'),

    list() { return problems.map((p) => Object.assign({}, p)); },
    get(id) { return problems.find((p) => p.id === id) || null; },

    save(p) {
      const id = String((p && p.id) || '').trim();
      if (!id) throw new Error('题目必须有 id');
      const prev = store.get(id) || {};
      const statement = p.statement != null ? String(p.statement) : (prev.statement || '');
      const rec = {
        id,
        title: String(p.title != null ? p.title : (prev.title || id)),
        rating: p.rating != null && p.rating !== '' ? Number(p.rating) : (prev.rating || null),
        url: String(p.url != null ? p.url : (prev.url || '')),
        source: String(p.source != null ? p.source : (prev.source || 'manual')),
        note: String(p.note != null ? p.note : (prev.note || '')),
        statement,
        samples: Array.isArray(p.samples) && p.samples.length ? p.samples.map((s) => ({ input: String(s.input == null ? '' : s.input), output: String(s.output == null ? '' : s.output) }))
          : (p.samples == null ? (prev.samples || []) : []),
        oracleLang: String(p.oracleLang || prev.oracleLang || 'python') === 'cpp' ? 'cpp' : 'python',
        genLang: String(p.genLang || prev.genLang || 'python') === 'cpp' ? 'cpp' : 'python',
        updatedAt: new Date().toISOString()
      };
      // 题面落文件（喂给三档的是同一份文本 → 题面 sha 可审计）
      if (rec.statement.trim()) {
        const sf = path.join(dirs.statements, id + '.txt');
        fs.writeFileSync(sf, rec.statement, 'utf8');
        rec.statementFile = sf;
        rec.statementSha = env.sha256(rec.statement);
      } else { rec.statementFile = null; rec.statementSha = null; }
      // 官方样例：没给就尝试从题面里解析（解析不到就留空，判分只跑差分）
      if (!rec.samples.length) rec.samples = statementLib.extractSamples(rec.statement) || [];
      // oracle / gen 落文件（判分只认文件）
      const put = (which, lang, code) => {
        const file = path.join(dirs[which], id + '.' + extOf(lang));
        if (code != null && String(code).trim()) { fs.writeFileSync(file, String(code), 'utf8'); return { lang, file }; }
        if (fs.existsSync(file)) { fs.unlinkSync(file); }
        return null;
      };
      rec.oracle = put('oracle', rec.oracleLang, p.oracleCode != null ? p.oracleCode : (prev.oracle ? fs.existsSync(prev.oracle.file) ? fs.readFileSync(prev.oracle.file, 'utf8') : '' : ''));
      rec.gen = put('gen', rec.genLang, p.genCode != null ? p.genCode : (prev.gen ? fs.existsSync(prev.gen.file) ? fs.readFileSync(prev.gen.file, 'utf8') : '' : ''));
      // 旧语言的文件（切语言后残留）删掉，避免判分读到过期的那个
      ['oracle', 'gen'].forEach((which) => {
        const other = path.join(dirs[which], id + '.' + (rec[which] ? (rec[which].lang === 'cpp' ? 'py' : 'cpp') : 'py'));
        if (fs.existsSync(other) && (!rec[which] || rec[which].file !== other)) fs.unlinkSync(other);
      });
      const i = problems.findIndex((x) => x.id === id);
      if (i >= 0) problems[i] = rec; else problems.push(rec);
      store.flush();
      return rec;
    },

    remove(id) {
      const i = problems.findIndex((p) => p.id === id);
      if (i < 0) return false;
      const p = problems[i];
      [p.oracle, p.gen, p.statementFile].forEach((f) => { if (f && f.file && fs.existsSync(f.file)) fs.unlinkSync(f.file); });
      problems.splice(i, 1);
      store.flush();
      return true;
    },

    flush() {
      fs.writeFileSync(problemsFile, JSON.stringify(problems, null, 2), 'utf8');
      return problemsFile;
    },

    /** 喂给 levels.runL0/runL1/l2.runL2/judge.judgeRecord 的题目对象（与 problems.js 的产出同形） */
    runtime(id) {
      const p = store.get(id);
      if (!p) return null;
      return {
        id: p.id, title: p.title, rating: p.rating, url: p.url, source: p.source, note: p.note,
        statement: p.statement, statementSha: p.statementSha, statementFile: p.statementFile,
        samples: p.samples || [], oracle: p.oracle ? Object.assign({}, p.oracle) : null, gen: p.gen ? Object.assign({}, p.gen) : null
      };
    },

    /** 题库（判分/配对比较都要一份 all） */
    runtimeAll(ids) {
      const list = Array.isArray(ids) && ids.length ? ids : problems.map((p) => p.id);
      return list.map((id) => store.runtime(id)).filter(Boolean);
    },

    records() { return readJsonl(store.recordsFile); },
    /** 每题每档只留最后一条（重跑同一题时旧记录不该再参与统计） */
    latestRecords() {
      const m = new Map();
      store.records().forEach((r) => { if (r && r.level) m.set(r.level + '|' + r.problem, r); });
      return [...m.values()];
    },
    verdicts() { return readJsonl(store.verdictsFile); },
    compare() { return readJson(store.compareFile, null); },
    human() { return readJsonl(store.humanFile); },
    saveHuman(entry) {
      const e = Object.assign({ at: new Date().toISOString() }, entry || {});
      fs.appendFileSync(store.humanFile, JSON.stringify(e) + '\n', 'utf8');
      return e;
    },
    clearHistory() {
      [store.recordsFile, store.verdictsFile, store.compareFile, store.humanFile].forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
      return true;
    }
  };
  return store;
}

module.exports = { init };
