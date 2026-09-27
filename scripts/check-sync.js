/**
 * check-sync.js — 对比"仓库源码"与"打包产物里的副本"是否一致。
 *
 * 为什么需要：`npm run pack` 只是复制目录，最容易出的错就是
 * "源码改好了、用户手里的 exe 还是旧的"。本项目真踩过（用户点按钮没反应，
 * 因为 exe 里的 review.js 是改动前的版本）。
 * verify-pack.js 查"关键代码在不在"，这个脚本查"每个文件的字节是否一致"——
 * 两者互补：前者防遗漏，后者防忘记重新打包。
 *
 * 用法：node scripts/check-sync.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'resources', 'app');

/** 需要"源码与包内一致"的文件（打包时被排除的目录不在其列） */
const FILES = [
  'server.js',
  // 注意：**package.json 不在此列**。@electron/packager 打包时会重写它
  // （补 main/name 等），所以包内版本与源码必然不同，比对它只会得到假告警。
  'lib/skills.js', 'lib/tools.js', 'lib/agentloop.js', 'lib/llm.js',
  'lib/cfreview.js', 'lib/harness.js', 'lib/richdoc.js', 'lib/cf.js', 'lib/runner.js',
  'lib/workspace.js', 'lib/explaindoc.js', 'lib/anticheat.js', 'lib/statement.js',
  'lib/profile.js', 'lib/pricing.js', 'lib/sandbox.js',
  'public/index.html', 'public/styles.css', 'public/js/app.js', 'public/js/review.js',
  'public/js/md.js', 'public/js/agentruns.js',
  'electron/main.js', 'electron/preload.js',
  'skills/_coach.md',
  'skills/cf-fetch/SKILL.md', 'skills/cf-verify/SKILL.md', 'skills/cf-explain/SKILL.md',
  'skills/cf-debug/SKILL.md', 'skills/cf-review/SKILL.md', 'skills/cf-doc/SKILL.md',
  'skills/cf-doc/DESIGN.md'
];

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

const missing = [];
const stale = [];
let same = 0;
for (const rel of FILES) {
  const src = path.join(ROOT, rel);
  const dst = path.join(APP, rel);
  if (!fs.existsSync(dst)) { missing.push(rel); continue; }
  if (!fs.existsSync(src)) { stale.push(rel + '（源码里已不存在）'); continue; }
  const a = sha(fs.readFileSync(src));
  const b = sha(fs.readFileSync(dst));
  if (a === b) same++;
  else stale.push(rel + '（源码 ' + a + ' ≠ 包内 ' + b + '）');
}

console.log('一致性核对：' + FILES.length + ' 个文件');
console.log('  一致 ' + same + ' 个');
if (missing.length) console.log('  包内缺失 ' + missing.length + ' 个：\n    ' + missing.join('\n    '));
if (stale.length) console.log('  包内是旧版本 ' + stale.length + ' 个：\n    ' + stale.join('\n    '));
if (!missing.length && !stale.length) console.log('\n✅ 打包产物与源码完全一致');
else console.log('\n⚠️ 请重新运行 npm run pack');
process.exitCode = (missing.length || stale.length) ? 1 : 0;
