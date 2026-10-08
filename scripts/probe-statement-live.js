/**
 * probe-statement-live.js — 真机验证「CF 取题面」这条链（爆拦截回归的复现工具）。
 *
 * 用法：
 *   node scripts/probe-statement-live.js 1800C 1900A 2267B
 *   node scripts/probe-statement-live.js --serve 1800C      # 只起应用并保持（调试用）
 *
 * 会启动打包好的 exe（用你真实的登录态与数据目录），逐个取题面，打印：
 *   ✓/✗ · 耗时 · 失败原因 · 是否命中反爬挑战 · 落地 URL
 * 同时把主进程的诊断日志（%APPDATA%\codeforces-coach\cf-diag.log）增量打出来。
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const DIAG = path.join(process.env.APPDATA || '', 'codeforces-coach', 'cf-diag.log');

const args = process.argv.slice(2).filter((a) => a !== '--serve');
const keepAlive = process.argv.includes('--serve');
if (!args.length) { console.error('用法: node scripts/probe-statement-live.js <题目号…>（如 1800C 1900A）'); process.exit(2); }

function parseRef(s) {
  const m = String(s).match(/^(\d{2,6})([A-Z]\d?)$/i);
  return m ? { contestId: m[1], index: m[2].toUpperCase() } : null;
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 180000 }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 200))); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function diagSize() {
  try { return fs.statSync(DIAG).size; } catch (e) { return 0; }
}
function diagTail(from) {
  try {
    const buf = fs.readFileSync(DIAG);
    return buf.slice(from).toString('utf8').trim();
  } catch (e) { return ''; }
}

(async () => {
  const proc = spawn(EXE, [], { windowsHide: true,
    cwd: path.dirname(EXE), stdio: 'ignore',
    env: Object.assign({}, process.env, { CFCOACH_DEBUG_EDITORIAL: '1' })
  });
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

  for (const ref of args) {
    const p = parseRef(ref);
    if (!p) { console.log('跳过（题号格式不对）: ' + ref); continue; }
    const mark = diagSize();
    const t0 = Date.now();
    let r = null;
    try {
      r = await getJson('http://127.0.0.1:' + port + '/api/cf/problem?contestId=' + p.contestId + '&index=' + p.index, 180000);
    } catch (e) { r = { error: e.message }; }
    const ms = Date.now() - t0;
    const ok = !!(r && r.statement && r.statement.length > 50);
    console.log((ok ? '✓' : '✗') + ' ' + ref + '：' + (ms / 1000).toFixed(1) + 's'
      + (ok ? ('  题面 ' + r.statement.length + ' 字符｜样例 ' + ((r.samples || []).length) + ' 组｜' + (r.title || ''))
        : ('  ' + JSON.stringify(r && (r.error || r.reason || r)).slice(0, 240))));
    const d = diagTail(mark);
    if (d) console.log('    [diag] ' + d.split('\n').map((l) => l.replace(/^\S+Z\s*/, '')).join('\n    [diag] '));
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!keepAlive) { try { proc.kill(); } catch (e) { /* ignore */ } }
  process.exit(0);
})();
