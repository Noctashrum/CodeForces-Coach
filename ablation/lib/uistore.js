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

/**
 * 整块粘代码时最常见的坑：连着 Markdown 围栏一起粘进来。
 * 用户 m07960 的 oracle 就是这样 —— 文件第 1 行是 ```，跑起来立刻 SyntaxError，
 * 而体检脚本却把锅算在"生成器造的数据"上，看起来像生成器一直崩。
 * 只在"整段就是一个围栏块"时剥掉；正文内部出现 ``` 的正常代码不动。
 */
function stripFence(text) {
  const t = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  if (!/^\s*```/.test(t)) return t;
  const whole = t.match(/^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*$/);
  if (whole) return whole[1];
  return t.replace(/^\s*```[^\n]*\r?\n/, '');   // 结尾那道围栏被截断了
}

/** 从代码本身猜语言。只在证据明确时给答案；含糊就返回 null，不动用户选的项。 */
function detectLang(code) {
  const s = String(code == null ? '' : code);
  if (!s.trim()) return null;
  const cpp = /#\s*include\s*[<"]|\busing\s+namespace\s+std\b|\bint\s+main\s*\(|\bstd::\w|\bcin\s*>>|\bcout\s*<</.test(s);
  const py = /^[ \t]*(?:import|from)\s+[A-Za-z_][\w.]*/m.test(s)
    || /^[ \t]*def\s+[A-Za-z_]\w*\s*\(/m.test(s)
    || /\binput\s*\(/.test(s)
    || /\bprint\s*\(/.test(s);
  if (cpp && !py) return 'cpp';
  if (py && !cpp) return 'python';
  return null;
}

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

  /**
   * 一条记录"交付了什么" —— 排序用的级别（越高越是"这档自己给出的解"）：
   *   3 = 有代码，且链声明交付的是模型第一版（`delivered === 'model-first'`）
   *   2 = 有代码（没声明，或没这个概念 —— L0/L1 就是普通记录）
   *   1 = 有代码，但是**降级交付的暴力解**（`verification.degraded === 'brute'`）
   *   0 = 没代码
   *
   * 为什么降级交付要排在"有代码"之下：题解 Agent 一个字都没交出来时，链会把同一轮生成的
   * 暴力解交上来 —— 它是**有代码的**（正确但很慢）。按旧的"有代码优先"规则，它会顶掉更早那条
   * **真的解出来了**的记录：实测 2026-10-06，2268C 07:15 的 ok 记录、2268E 08:20 的 ok 记录
   * 就是这么被 18:28 的降级交付吃掉的，判分表里 L2 白丢两格 AC。
   */
  function deliveredRank(r) {
    if (!r || !r.code) return 0;
    const v = r.verification || {};
    const degraded = v.degraded ? String(v.degraded) : (r.verificationStatus === 'degraded-brute' ? 'brute' : null);
    if (degraded === 'brute' && r.delivered !== 'model-first') return 1;
    return r.delivered === 'model-first' ? 3 : 2;
  }

  /**
   * 每题每档挑一条给判分/汇总用。
   *
   * 取法：优先"交付得更像自己解的那条"（见 deliveredRank）；同级才取更新的。
   * 为什么不是无条件取最新：重跑失败（模型这次没给出代码块、只降级交了个暴力解）会把更早那条
   * **成功**记录顶掉，配对表里就变成"这一档什么都没产出"。用户 m08171 的 pilot 里 2268A 的
   * L0/L2 两次成功记录（02:35 / 02:39）就是这么被 05:31 / 05:36 的失败重跑吃掉的。
   */
  function pickLatest() {
    const m = new Map();   // key → { rec, dropped: [] }
    readJsonl(store.recordsFile).forEach((r) => {
      if (!r || !r.level) return;
      const key = r.level + '|' + r.problem;
      const cur = m.get(key);
      if (!cur) { m.set(key, { rec: r, dropped: [] }); return; }
      const nr = deliveredRank(r); const cr = deliveredRank(cur.rec);
      if (nr > cr) { cur.dropped.push(cur.rec); cur.rec = r; return; }   // 新的交付得更像自己的解 → 换新的
      if (nr < cr) { cur.dropped.push(r); return; }                      // 新的更差（比如降级交付）→ 保留旧的
      cur.dropped.push(cur.rec); cur.rec = r;                            // 一样好/一样差 → 取更新的
    });
    return m;
  }

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
        // 判不了的题（多解没 checker / 尺子贴错题）：标一下，跑分默认跳过。
        // 它们只烧钱不产数据 —— 实测 2267B+2268F 两道就吃掉 91 分钟 / ¥10.6。
        skip: p.skip != null ? !!p.skip : prev.skip === true,
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
      const prevCode = (which) => {
        const f = prev[which];
        return f && f.file && fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : '';
      };
      // 存盘前两道清洗：① 剥掉整块粘贴带上来的 ``` 围栏；② 语言以代码内容为准
      // （下拉停在默认的 python、贴的却是 C++，是最常见的一种"跑不起来"）。
      const codes = {
        oracle: stripFence(p.oracleCode != null ? p.oracleCode : prevCode('oracle')),
        gen: stripFence(p.genCode != null ? p.genCode : prevCode('gen'))
      };
      const langFix = [];
      [['oracle', 'oracleLang'], ['gen', 'genLang']].forEach(([which, key]) => {
        const guess = detectLang(codes[which]);
        if (guess && guess !== rec[key]) { langFix.push({ which, from: rec[key], to: guess }); rec[key] = guess; }
      });
      rec.oracle = put('oracle', rec.oracleLang, codes.oracle);
      rec.gen = put('gen', rec.genLang, codes.gen);
      if (langFix.length) rec.langFix = langFix;
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
      // 跑分队列从这里读题 —— skip 不带上，"判不了的题默认跳过"就是一句空话
      skip: p.skip === true,
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
    /** 每题每档一条（取法见 pickLatest：优先"最新且有代码"的那条，不让失败重跑吃掉成功记录） */
    latestRecords() { return [...pickLatest().values()].map((x) => x.rec); },
    /** 上面那个取法跳过了哪些记录（启动日志/排查用） */
    latestAudit() {
      const out = [];
      pickLatest().forEach((x, key) => {
        if (!x.dropped.length) return;
        out.push({
          key,
          kept: { startedAt: x.rec.startedAt || null, hasCode: !!x.rec.code },
          dropped: x.dropped.map((d) => ({ startedAt: d.startedAt || null, hasCode: !!d.code }))
        });
      });
      return out;
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
  // 自愈历史数据：以前"连着围栏整块粘进来"或"语言选错"的 oracle/gen，在这里一次性修好。
  // 不修的话，判分（直接读文件）和生成器体检都会莫名其妙失败，而且报错会指向错的方向。
  const repairs = [];
  problems.slice().forEach((p) => {
    const patch = { id: p.id };
    let dirty = false;
    [['oracle', 'oracleLang'], ['gen', 'genLang']].forEach(([which, key]) => {
      const f = p[which];
      if (!f || !f.file || !fs.existsSync(f.file)) return;
      const raw = fs.readFileSync(f.file, 'utf8');
      const clean = stripFence(raw);
      const guess = detectLang(clean);
      const langChanged = !!(guess && guess !== p[key]);
      if (clean === raw && !langChanged) return;
      patch[which + 'Code'] = clean;
      repairs.push({ id: p.id, which, fence: clean !== raw, from: p[key], to: langChanged ? guess : p[key] });
      dirty = true;
    });
    if (dirty) { try { store.save(patch); } catch { /* 单条坏记录不该拖垮启动 */ } }
  });
  store.repairs = repairs;
  // 重跑把成功记录顶掉的情况在这里留个账：判分用的是 latestRecords()，
  // 不说明白的话，"那一档没产出"会被误读成模型不行（用户 m08171 的 2268A 就是）。
  store.superseded = store.latestAudit();
  return store;
}

module.exports = { init, stripFence, detectLang };
