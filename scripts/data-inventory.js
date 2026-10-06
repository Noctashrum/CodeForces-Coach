#!/usr/bin/env node
/**
 * data-inventory.js — 更新前后数一数：题目缓存与跑分数据还在不在
 *
 * 为什么需要它：`git pull` 只会动被跟踪的代码文件，题目缓存都在 .gitignore 的目录里，
 * 理论上碰不到。但"理论上"不是能拿去交差的证据 —— 尤其当三台机器同时跑测试、
 * 每人手里都有一份攒了很久的缓存题库时：更新前数一遍、更新后再数一遍，
 * 两份数字一样才叫"缓存还在"。
 *
 *   node scripts/data-inventory.js            # 数一遍并体检
 *   node scripts/data-inventory.js --json     # 机器可读（方便两台机器 diff）
 *
 * 只读：不写盘、不联网、不碰 API Key（只打印模型名，绝不打印密钥）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const asJson = process.argv.includes('--json');

const out = [];
const say = (line) => { if (!asJson) out.push(line); };

/** 应用的数据目录候选（与 electron/main.js:62-65 的判定一致，另加环境变量覆盖） */
function appDataCandidates() {
  const list = [];
  const push = (p, why) => { if (p && !list.some((x) => x.dir === p)) list.push({ dir: p, why }); };
  push(process.env.CHATBOX_DATA_DIR, '环境变量 CHATBOX_DATA_DIR');
  push(process.env.CFCOACH_APP_DATA, '环境变量 CFCOACH_APP_DATA');
  push(path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data'), '打包版（便携目录，exe 旁边）');
  push(path.join(ROOT, 'data'), '源码运行（npm start）');
  return list.filter((c) => fs.existsSync(c.dir));
}

function countFiles(dir, re) {
  try {
    return fs.readdirSync(dir).filter((f) => !re || re.test(f)).length;
  } catch (e) { return 0; }
}

function listJsonIds(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch (e) { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// ---------------------------------------------------------------- 应用数据目录
say('# 应用数据目录（模型配置 + 题面缓存 + 会话）');
const apps = [];
for (const c of appDataCandidates()) {
  const ids = listJsonIds(path.join(c.dir, 'cf-problems'));
  const cfg = readJson(path.join(c.dir, 'config.json'));
  const provider = cfg && Array.isArray(cfg.providers) && cfg.providers.length
    ? cfg.providers.find((p) => p.id === cfg.defaultProviderId) || cfg.providers[0] : null;
  const entry = {
    dir: c.dir,
    why: c.why,
    config: !!cfg,
    providerId: provider ? provider.id : null,
    baseUrl: provider ? provider.baseUrl : null,
    models: provider && Array.isArray(provider.models) ? provider.models : [],
    defaultModel: cfg ? cfg.defaultModel || '' : null,
    conversations: countFiles(path.join(c.dir, 'conversations')),
    cachedProblems: ids.length,
    cachedIds: ids
  };
  apps.push(entry);
  say('  ' + entry.dir + '   （' + c.why + '）');
  say('    题面缓存：' + entry.cachedProblems + ' 道' + (entry.cachedIds.length ? ' → ' + entry.cachedIds.join(' ') : ''));
  say('    会话：' + entry.conversations + ' 个｜模型配置：' + (entry.config ? '有（' + (entry.providerId || '?') + ' / '
    + (entry.models.join(', ') || '—') + '，默认 ' + (entry.defaultModel || '（空 → 取 models[0]）') + '）' : '没有'));
}
if (!apps.length) say('  ⚠️ 一个都没找到 —— 这台机器还没跑过应用，或者数据目录被删了');

// ------------------------------------------------------- Electron userData（登录态）
say('');
say('# Electron userData（CF 登录态；在仓库外面，pull 无关）');
const userData = process.env.CFCOACH_USER_DATA || path.join(os.homedir(), 'AppData', 'Roaming', 'codeforces-coach');
const partDir = path.join(userData, 'Partitions', 'cfcoach-fetch');
say('  ' + userData + ' → ' + (fs.existsSync(userData) ? (fs.existsSync(partDir) ? '存在（含 cfcoach-fetch 抓题分区）' : '存在（没有抓题分区）') : '不存在'));
say('  cf-diag.log：' + (fs.existsSync(path.join(userData, 'cf-diag.log')) ? '有' : '没有'));

// ---------------------------------------------------------------- 工作台跑分数据
say('');
say('# 工作台跑分数据（ablation/out/*，题库 + 尺子 + 生成器 + 记录）');
const outRoot = path.join(ROOT, 'ablation', 'out');
const stores = [];
if (fs.existsSync(outRoot)) {
  for (const name of fs.readdirSync(outRoot).sort()) {
    const dir = path.join(outRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const problemsFile = path.join(dir, 'problems.json');
    const problems = readJson(problemsFile);
    if (!Array.isArray(problems)) continue;
    // 校验用的是"素材还在不在"：oracle/gen 在 problems.json 里存的是**绝对路径**，
    // 仓库换盘/换目录名就会断 —— 这是更新后最值得先看的一行。
    let brokenOracle = [];
    let brokenGen = [];
    for (const p of problems) {
      if (p.oracle && p.oracle.file && !fs.existsSync(p.oracle.file)) brokenOracle.push(p.id);
      if (p.gen && p.gen.file && !fs.existsSync(p.gen.file)) brokenGen.push(p.id);
    }
    const recs = fs.existsSync(path.join(dir, 'records.jsonl'))
      ? fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    const vers = fs.existsSync(path.join(dir, 'verdicts.jsonl'))
      ? fs.readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    const entry = {
      dir: name, problems: problems.length,
      skipped: problems.filter((p) => p.skip === true).length,
      oracle: problems.filter((p) => p.oracle && p.oracle.file).length,
      gen: problems.filter((p) => p.gen && p.gen.file).length,
      records: recs, verdicts: vers,
      brokenOracle, brokenGen
    };
    stores.push(entry);
    say('  ' + name + '：题 ' + entry.problems + '（跳过 ' + entry.skipped + '）｜oracle ' + entry.oracle
      + '｜生成器 ' + entry.gen + '｜记录 ' + recs + '｜判分 ' + vers);
    if (brokenOracle.length) say('    ⚠️ oracle 文件找不到（题库里存的是绝对路径，换过目录就会断）：' + brokenOracle.join(' '));
    if (brokenGen.length) say('    ⚠️ 生成器文件找不到：' + brokenGen.join(' '));
  }
}
if (!stores.length) say('  （没有跑分批次，或还没建过题库）');

// ---------------------------------------------------------------- 打包备份残留
const backup = path.join(ROOT, '.pack-data-backup');
if (fs.existsSync(backup)) {
  say('');
  say('# ⚠️ 发现 .pack-data-backup/（上次打包备份没被恢复回去）');
  say('  ' + backup + ' → 里面有 ' + countFiles(path.join(backup, 'cf-problems')) + ' 道缓存题；'
    + '确认 dist 里的数据没问题后可以删，别在没恢复前删');
}

if (asJson) {
  console.log(JSON.stringify({
    host: os.hostname(), root: ROOT, appData: apps,
    userData: { dir: userData, partition: fs.existsSync(partDir), diagLog: fs.existsSync(path.join(userData, 'cf-diag.log')) },
    stores, packBackup: fs.existsSync(backup)
  }, null, 2));
} else {
  console.log(out.join('\n'));
  console.log('');
  console.log('提示：更新（git pull）前后各跑一次，两份输出里的「题面缓存 N 道」与「题 N」应当一模一样。');
  console.log('      想机器可读就用 --json，方便两台机器对 diff。');
}
