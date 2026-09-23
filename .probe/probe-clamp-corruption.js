'use strict';
/**
 * probe-clamp-corruption.js — 复现"机械数值缩放把数据改坏"的事故（真实 gen.py，只读）
 * 用法：node .probe/probe-clamp-corruption.js [工作区目录] [档位]
 *
 * 做法：用该题真实的 gen.py 生成一组数据 → 打印原文 → 再套 clampValues → 打印缩放后 →
 * 直接看"哪些字段被改坏了"（例如长度必须等于 n 的二进制串被当成数字改成了 16）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WS = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data', 'workspace', 'cf-2259F');
const TIER = parseInt(process.argv[3] || '8', 10);
const runner = require(path.join(ROOT, 'lib', 'runner.js'));

const genPath = path.join(WS, 'gen.py');
if (!fs.existsSync(genPath)) { console.error('找不到 ' + genPath); process.exit(1); }
const raw = spawnSync('python', [genPath, String(TIER)], { encoding: 'utf8' });
if (raw.error) { console.error('python3 跑不起来: ' + raw.error.message); process.exit(1); }
const data = String(raw.stdout || '');
const clamped = runner.clampValues(data, TIER);
console.log('==== gen.py 原始输出（档位 ' + TIER + '）====');
console.log(data.slice(0, 600));
console.log('==== 机械缩放后 ====');
console.log(clamped.text.slice(0, 600));
console.log('==== 结论 ====');
console.log('changed=' + clamped.info.changed + ' maxBefore=' + clamped.info.maxBefore + ' maxAfter=' + clamped.info.maxAfter);
const before = data.trim().split(/\s+/);
const after = clamped.text.trim().split(/\s+/);
console.log('token 数：' + before.length + ' → ' + after.length + (before.length === after.length ? '（数量一致，所以"行数/字段数"看不出问题）' : '（数量变了）'));
let shown = 0;
for (let i = 0; i < before.length && shown < 12; i++) {
  if (before[i] !== after[i]) { console.log('  第 ' + (i + 1) + ' 个 token: ' + JSON.stringify(before[i]) + ' → ' + JSON.stringify(after[i])); shown++; }
}
