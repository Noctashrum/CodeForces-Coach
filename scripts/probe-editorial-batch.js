/**
 * probe-editorial-batch.js — 逐题跑一次真实抓取，看**哪一题取得到、哪一题取不到、失败原因是什么**。
 *
 * 为什么需要：用户反馈"有时候取不到题解或源码"，但单个 case 的成功/失败说明不了问题 ——
 * 需要一次把一场比赛的题全跑一遍，才能看出是"某类题必然失败"还是"偶发"。
 *
 * 用法：
 *   node scripts/probe-editorial-batch.js 2267 A B C D E F1 F2 G
 *   node scripts/probe-editorial-batch.js 2267 --delay 8000 A B     # 每题之间多等一会
 *
 * 注意：会真的访问 Codeforces，逐题间隔有节流（默认 5 秒），别开太快否则会被限流。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const DIAG = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codeforces-coach', 'cf-diag.log');

const argv = process.argv.slice(2);
const delayIdx = argv.indexOf('--delay');
const delayMs = delayIdx >= 0 ? (parseInt(argv[delayIdx + 1], 10) || 5000) : 5000;
// ⚠️ 不带 --delay 时 delayIdx = -1，若直接写 `i !== delayIdx + 1` 会把下标 0（比赛号）也过滤掉，
// 于是 contestId 变成第一个题号、报"参数不合法"（曾经踩过）。
const rest = argv.filter((a, i) => a !== '--delay' && (delayIdx < 0 || i !== delayIdx + 1));
const contestId = rest[0];
const indexes = rest.slice(1);
if (!contestId || !indexes.length) {
  console.error('用法: node scripts/probe-editorial-batch.js <contestId> [--delay ms] <index...>');
  process.exit(2);
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 120000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 120))); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  const proc = spawn(EXE, [], { windowsHide: true, cwd: path.dirname(EXE), env: Object.assign({}, process.env), stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = require('child_process').execSync(
        'powershell -NoProfile -Command "(Get-NetTCPConnection -OwningProcess ' + proc.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"',
        { encoding: 'utf8' });
      port = parseInt(String(out).trim(), 10) || 0;
    } catch (e) { /* 等 */ }
  }
  if (!port) { console.error('拿不到端口'); proc.kill(); process.exit(2); }
  console.log('端口 ' + port + '，逐题间隔 ' + delayMs + 'ms\n');

  const rows = [];
  for (const idx of indexes) {
    const t0 = Date.now();
    let r = null;
    try {
      r = await getJson('http://127.0.0.1:' + port + '/api/review/editorial?contestId=' + contestId + '&index=' + idx, 180000);
    } catch (e) { r = { ok: false, reason: 'request-error', hint: e.message }; }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    rows.push({
      index: idx,
      ok: !!(r && r.ok),
      reason: (r && r.reason) || '',
      sliced: r && r.sliced,
      len: r && r.content ? r.content.length : 0,
      entryId: (r && r.entryId) || '',
      head: r && r.content ? r.content.split('\n').filter((l) => l.trim()).slice(0, 2).join(' / ').slice(0, 90) : ''
    });
    console.log(String(idx).padEnd(4) + (r && r.ok ? '✓' : '✗') + '  ' + secs + 's  '
      + 'len=' + String(rows[rows.length - 1].len).padStart(6)
      + '  sliced=' + String(r && r.sliced)
      + (r && r.ok ? '' : '  reason=' + ((r && r.reason) || '?') + '  hint=' + ((r && r.hint) || '').slice(0, 70))
      + (r && r.ok ? '  ' + rows[rows.length - 1].head : ''));
    if (idx !== indexes[indexes.length - 1]) await new Promise((res) => setTimeout(res, delayMs));
  }

  console.log('\n===== 汇总 =====');
  const okN = rows.filter((x) => x.ok).length;
  console.log('成功 ' + okN + ' / ' + rows.length);
  rows.filter((x) => !x.ok).forEach((x) => console.log('  失败 ' + x.index + '：' + x.reason + ' — ' + x.hint));
  const lens = rows.filter((x) => x.ok).map((x) => x.len);
  if (lens.length) console.log('成功题正文长度：' + lens.join(', ') + '（差异过大说明切分不稳定）');

  try { proc.kill(); } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1200));
  if (fs.existsSync(DIAG)) {
    console.log('\n===== 诊断日志（尾部 12 行）=====');
    console.log(fs.readFileSync(DIAG, 'utf8').split('\n').filter(Boolean).slice(-12).join('\n'));
  }
  process.exit(okN === rows.length ? 0 : 1);
})();
