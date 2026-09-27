/* 临时工具：打印 /api/review/source 的完整响应 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');

function get(url, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: ms || 150000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  const proc = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -OwningProcess ' + proc.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"', { encoding: 'utf8' });
      port = parseInt(String(out).trim(), 10) || 0;
    } catch (e) { /* 等 */ }
  }
  console.log('端口 ' + port);
  const r = await get('http://127.0.0.1:' + port + '/api/review/source?contestId=2267&submissionId=392011083');
  console.log('HTTP ' + r.status);
  console.log(r.body.slice(0, 900));
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
