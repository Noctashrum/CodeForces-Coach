/* 临时工具：全新进程里连续抓同一份源码 3 次（看是不是首次冷启动才失败） */
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
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.slice(0, 200) }); } });
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
  const ids = ['392011083', '392039896', '392011083'];
  for (let i = 0; i < ids.length; i++) {
    const r = await get('http://127.0.0.1:' + port + '/api/review/source?contestId=2267&submissionId=' + ids[i]);
    console.log('第 ' + (i + 1) + ' 次（提交 ' + ids[i] + '）: '
      + (r.ok ? ('✓ ' + String(r.code || '').length + ' 字符，语言 ' + (r.lang || '?')) : ('✗ ' + (r.reason || JSON.stringify(r).slice(0, 140)))));
    await new Promise((res) => setTimeout(res, 3000));
  }
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
