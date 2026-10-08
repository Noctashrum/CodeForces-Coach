/**
 * probe-source-live.js — 真机测试"抓提交源码"这条链路，打印**真实失败原因**。
 *
 * 用法：node scripts/probe-source-live.js 2267 392011083 392039896
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const [contestId, ...ids] = process.argv.slice(2);
if (!contestId || !ids.length) { console.error('用法: node scripts/probe-source-live.js <contestId> <submissionId...>'); process.exit(2); }

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 120000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 150))); } });
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
  console.log('端口 ' + port + '\n');

  for (const id of ids) {
    const t0 = Date.now();
    let r = null;
    try {
      r = await getJson('http://127.0.0.1:' + port + '/api/review/source?contestId=' + contestId + '&submissionId=' + id, 180000);
    } catch (e) { r = { ok: false, reason: 'request-error', hint: e.message }; }
    console.log('提交 ' + id + '：' + (((Date.now() - t0) / 1000).toFixed(1)) + 's  '
      + (r && r.ok ? ('✓ 源码 ' + (r.code || '').length + ' 字符，语言 ' + (r.lang || '?') + '，方式 ' + (r.via || '?'))
        : ('✗ reason=' + ((r && r.reason) || '?') + '  hint=' + ((r && r.hint) || ''))));
    if (r && r.ok) console.log('    首行: ' + String(r.code).split('\n').find((l) => l.trim()).slice(0, 80));
    await new Promise((res) => setTimeout(res, 4000));
  }
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
