/* 临时工具：登录 → 抓源码，并开启诊断日志，看抓取那一刻到底发生了什么 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const DIAG = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codeforces-coach', 'cf-diag.log');

function post(url, body, ms) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
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
function get(url, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: ms || 150000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.slice(0, 300) }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  try { fs.rmSync(DIAG, { force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, { CFCOACH_DEBUG_EDITORIAL: '1' }),
    stdio: 'ignore'
  });
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -OwningProcess ' + proc.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"', { encoding: 'utf8' });
      port = parseInt(String(out).trim(), 10) || 0;
    } catch (e) { /* 等 */ }
  }
  console.log('端口 ' + port);

  const login = await post('http://127.0.0.1:' + port + '/api/review/login', { waitMs: 90000 }, 150000);
  console.log('登录: loggedIn=' + login.loggedIn + ' handle=' + login.handle);

  await new Promise((r) => setTimeout(r, 1500));
  const src = await get('http://127.0.0.1:' + port + '/api/review/source?contestId=2267&submissionId=392011083');
  console.log('抓源码: ' + JSON.stringify(src).slice(0, 300));

  try { proc.kill(); } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1200));
  console.log('\n===== 诊断日志 =====');
  if (fs.existsSync(DIAG)) console.log(fs.readFileSync(DIAG, 'utf8').split('\n').filter(Boolean).slice(-15).join('\n'));
  else console.log('(无日志)');
  process.exit(0);
})();
