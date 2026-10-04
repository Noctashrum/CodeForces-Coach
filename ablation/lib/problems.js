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
  return fs.existsSync(abs) ? abs : null;
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
    let statementFile = resolveFile(baseDir, p.statement || ('statements/' + p.id + '.txt'));
    const statement = statementFile ? fs.readFileSync(statementFile, 'utf8') : '';
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

module.exports = { loadProblems, resolveFile, ABLATION_DIR };
