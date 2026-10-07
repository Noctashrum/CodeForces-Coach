/**
 * 题库装载：题目清单 + 题面文本 + 官方样例 + 外部 oracle（判分用）。
 *
 * 清单格式（见 problems.example.json）：
 * {
 *   "id": "1800C",
 *   "contestId": 1800, "index": "C", "name": "…", "rating": 1200,
 *   "statement": "statements/1800C.txt",        // 三档共用同一份题面文本
 *   "samples": [{"input": "…", "output": "…"}],  // 官方样例（判分第一关）
 *   "oracle": {"lang": "cpp", "file": "oracle/1800C.cpp"},   // 外部 AC 提交：**绝不能是 L2 自己产出的**
 *   "gen": {"lang": "cpp", "file": "oracle/1800C.gen.cpp"}   // 随机数据生成器（判分第二关：差分测试）
 * }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');

const ABLATION_DIR = path.join(__dirname, '..');

function resolveFile(baseDir, p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
  if (fs.existsSync(abs)) return abs;
  // 血泪教训（2026-10-07，另一台机器的 ui.zip）：工作台写出的 problems.json 里
  // `statementFile` / `oracle.file` / `gen.file` 存的是**绝对路径**，所以换一台机器解压之后
  // 每个文件都"不存在"→ 整份题库被判成 no-oracle（166 条记录全废，却一句报错都没有）。
  // 这里退一步：按路径末两段（`oracle/1978D.cpp`）在题库目录下再找一次；写侧也改成相对路径
  // （ablation/lib/uistore.js），两边都修才能让导出的题库可搬。
  const tail = path.join(path.basename(path.dirname(p)), path.basename(p));
  const guess = path.resolve(baseDir, tail);
  return fs.existsSync(guess) ? guess : null;
}

function loadProblems(args) {
  const want = env.listOf(args.problems);
  let file = args.problemsFile ? path.resolve(String(args.problemsFile)) : path.join(ABLATION_DIR, 'problems.json');
  let isExample = false;
  if (!fs.existsSync(file)) {
    const example = path.join(ABLATION_DIR, 'problems.example.json');
    if (!fs.existsSync(example)) throw new Error('找不到题库清单：' + file + '（也没有 problems.example.json）');
    file = example;
    isExample = true;
  }
  const baseDir = path.dirname(file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.problems || []);
  const problems = [];
  const skipped = [];
  for (const p of list) {
    if (!p || !p.id) continue;
    if (want.length && want.indexOf(String(p.id)) < 0 && want.indexOf('all') < 0) continue;
    // 题面有两种写法：① `statement` 给文件名/相对路径（statements/1800C.txt）；
    // ② `statement` 里直接内联整段题面正文（消融工作台写出的 problems.json 就是这种）。
    // 血泪教训（2026-10 消融报告，2241B/2267B）：只按文件名解析 → 内联题面的题一律解析成空串 →
    // 判分器靠题面正则做的"多解题"识别全部失效 → 这两题被判成 oracle-broken 整题排除，
    // 而它们其实是"答案不唯一"，正确解被字面比对误判成 WA。
    let statementFile = resolveFile(baseDir, p.statement || ('statements/' + p.id + '.txt'));
    let statement = statementFile ? fs.readFileSync(statementFile, 'utf8') : '';
    const inlineText = typeof p.statement === 'string' ? p.statement.trim() : '';
    // 判据：**落不到任何文件** 且 **看着像题面正文而不是文件名**（题面正文总有空白，文件名没有）。
    const looksLikePath = inlineText.length > 0 && inlineText.length < 200 && !/\s/.test(inlineText);
    if (!statement.trim() && inlineText && !looksLikePath) {
      statement = inlineText;
      statementFile = null;
    }
    const entry = {
      id: String(p.id),
      contestId: p.contestId || null,
      index: p.index || null,
      name: p.name || '',
      rating: p.rating || null,
      url: p.url || (p.contestId && p.index ? 'https://codeforces.com/contest/' + p.contestId + '/problem/' + p.index : ''),
      statement,
      statementFile,
      statementSha: statement ? env.sha256(statement) : null,
      samples: Array.isArray(p.samples) ? p.samples : [],
      oracle: p.oracle && p.oracle.file ? Object.assign({ lang: 'cpp' }, p.oracle, { file: resolveFile(baseDir, p.oracle.file) }) : null,
      gen: p.gen && p.gen.file ? Object.assign({ lang: 'cpp' }, p.gen, { file: resolveFile(baseDir, p.gen.file) }) : null
    };
    if (!statement.trim()) {
      skipped.push({ id: entry.id, reason: '缺题面文本：' + (p.statement || ('statements/' + entry.id + '.txt')) });
      problems.push(entry);
      continue;
    }
    problems.push(entry);
  }
  const limit = env.num(args.limit, 0);
  const selected = limit > 0 ? problems.slice(0, limit) : problems;
  return { file, baseDir, isExample, problems: selected, all: problems, skipped };
}

/**
 * 把题库条目里的三处资产路径（题面 / oracle / 生成器）解析成"本机真实存在的绝对路径"。
 * 为什么要这一步：`ablation/rejudge.js` 是**绕过 loadProblems 直接读题库文件**的（它要的只是 id→题
 * 的映射），所以路径解析必须自己做一遍。血泪教训（2026-10-07 另一台机器的 ui.zip）：对方写出的
 * `problems.json` 里全是 `C:\Users\<别人>\...` 的绝对路径，换机器解压后 211 条记录**全军覆没**成
 * `no-oracle`，而且一句报错都没有（"用时 0.0 分钟"）。resolveFile 的"末两段兜底"能把它救回来。
 */
function resolveEntryAssets(baseDir, entry) {
  if (!entry) return entry;
  const e = Object.assign({}, entry);
  if (e.statementFile) e.statementFile = resolveFile(baseDir, e.statementFile) || e.statementFile;
  if (e.oracle && e.oracle.file) e.oracle = Object.assign({}, e.oracle, { file: resolveFile(baseDir, e.oracle.file) || e.oracle.file });
  if (e.gen && e.gen.file) e.gen = Object.assign({}, e.gen, { file: resolveFile(baseDir, e.gen.file) || e.gen.file });
  return e;
}

module.exports = { loadProblems, resolveFile, resolveEntryAssets, ABLATION_DIR };
