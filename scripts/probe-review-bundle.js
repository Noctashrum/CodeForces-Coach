/**
 * probe-review-bundle.js — 端到端验证「💬 放进对话框」用的那份材料（/api/review/bundle）。
 *
 * 为什么要单独验证：这条路以前**只装题解、完全不装源码**（用户反馈："复盘材料还是只装题解"），
 * 而后端修好之后光看代码看不出"到底装进去了几份代码"，必须真的跑一遍、数一数。
 *
 * 用法：
 *   node scripts/probe-review-bundle.js <handle> <contestId> [--no-source]
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');

const withSource = !process.argv.includes('--no-source');
const argv = process.argv.slice(2).filter((a) => a !== '--no-source');
const [handle, contestId] = argv;
if (!handle || !contestId) { console.error('用法: node scripts/probe-review-bundle.js <handle> <contestId> [--no-source]'); process.exit(2); }

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 300000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 200))); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  const proc = spawn(EXE, [], { windowsHide: true, cwd: path.dirname(EXE), stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -OwningProcess ' + proc.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"', { windowsHide: true, encoding: 'utf8' });
      port = parseInt(String(out).trim(), 10) || 0;
    } catch (e) { /* 等 */ }
  }
  if (!port) { console.error('拿不到端口'); proc.kill(); process.exit(2); }
  console.log('端口 ' + port + '，打包材料（含源码: ' + withSource + '）…\n');

  const t0 = Date.now();
  const q = '/api/review/bundle?handle=' + encodeURIComponent(handle)
    + '&contestId=' + encodeURIComponent(contestId) + '&source=' + (withSource ? '1' : '0');
  let r = null;
  try { r = await getJson('http://127.0.0.1:' + port + q); } catch (e) { r = { ok: false, reason: e.message }; }
  try { proc.kill(); } catch (e) { /* ignore */ }

  if (!r || !r.ok) { console.log('✗ 打包失败：' + ((r && (r.reason || r.error)) || '?')); process.exit(0); }
  const b = r.bundle || '';
  const count = (re) => (b.match(re) || []).length;
  console.log('✓ 打包成功（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）：' + b.length + ' 字符');
  console.log('  题解块        ' + count(/^### [A-Z]\d? 题解/gm));
  console.log('  源码块        ' + count(/^### [A-Z]\d? · /gm));
  console.log('    · 首次提交            ' + count(/· 首次提交（/g));
  console.log('    · 最后一次未通过      ' + count(/· 最后一次未通过（/g));
  console.log('    · 首次通过            ' + count(/· 首次通过（/g));
  console.log('    · 最后一发            ' + count(/· 最后一发（/g));
  console.log('  没取到的源码块 ' + count(/源码：\*\*没取到\*\*/g));
  process.exit(0);
})();
