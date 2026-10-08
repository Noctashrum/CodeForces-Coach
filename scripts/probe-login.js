/**
 * probe-login.js — 验证"应用内浏览器登录"这条通道是否能真的建立登录态。
 *
 * 为什么要单独测：抓提交源码**必须登录**（CF 会回 "You are not allowed to view the requested page"），
 * 而登录态存在抓取会话分区（persist:cfcoach-fetch）里。这条通道如果不通，
 * "取不到源码"就永远修不好，所以它必须有独立的验证手段。
 *
 * 用法：
 *   node scripts/probe-login.js status     只检查当前是否已登录（不打开窗口）
 *   node scripts/probe-login.js open       打开登录窗口，等 120 秒让你登录，然后回报状态
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const action = process.argv[2] || 'status';

function post(url, body, ms) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.slice(0, 300) }); } });
    });
    req.on('error', reject);
    req.setTimeout(ms || 200000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

async function findPort(proc) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -OwningProcess ' + proc.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"', { windowsHide: true, encoding: 'utf8' });
      const p = parseInt(String(out).trim(), 10) || 0;
      if (p) return p;
    } catch (e) { /* 等 */ }
  }
  return 0;
}

(async () => {
  const proc = spawn(EXE, [], { windowsHide: true, cwd: path.dirname(EXE), stdio: 'ignore' });
  const port = await findPort(proc);
  if (!port) { console.error('拿不到端口'); proc.kill(); process.exit(2); }
  console.log('端口 ' + port);

  // 先看未登录时抓源码是什么结果（作为对照）
  const before = await post('http://127.0.0.1:' + port + '/api/review/source?contestId=2267&submissionId=392011083', {});
  console.log('登录前抓源码：' + (before && before.ok ? '成功' : '失败 → ' + (before && (before.reason || before.hint))));

  if (action === 'open') {
    console.log('\n打开登录窗口，给你 120 秒完成登录（窗口会显示在屏幕上）…');
    const r = await post('http://127.0.0.1:' + port + '/api/review/login', { waitMs: 120000 }, 200000);
    console.log('登录结果: ' + JSON.stringify(r));
  }

  // 再抓一次（同一进程内：cookie 至少应在内存里）
  const after = await post('http://127.0.0.1:' + port + '/api/review/source?contestId=2267&submissionId=392011083', {});
  console.log('登录后抓源码：' + (after && after.ok
    ? ('成功，源码 ' + String(after.code || '').length + ' 字符，语言 ' + (after.lang || '?'))
    : ('失败 → ' + (after && (after.reason || after.hint)))));

  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
