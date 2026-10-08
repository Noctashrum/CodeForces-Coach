/**
 * test-editorial-live.js — 真机联调：启动打包好的 exe，打它的本地 API，抓一次官方题解。
 *
 * 为什么需要这个脚本（而不是一串 PowerShell 命令）：
 *   反爬链路的排查需要"启动 → 等端口 → 发请求 → 看完整响应 → 读诊断日志"这一整套动作，
 *   写在命令行里既难改也容易出错（我就写错过变量赋值，白跑一轮）。
 *   放成脚本后每次实验只改参数。
 *
 * 用法：
 *   node scripts/test-editorial-live.js                     # 用 entryId 直连（默认 157126）
 *   node scripts/test-editorial-live.js 1567 C              # 走"题目页找 Tutorial 链接"
 *   node scripts/test-editorial-live.js --no-debug 157126   # 不开诊断日志
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

const args = process.argv.slice(2);
const noDebug = args.includes('--no-debug');
const rest = args.filter((a) => a !== '--no-debug');
const entryId = rest.length === 1 ? rest[0] : null;
const contestId = rest.length >= 2 ? rest[0] : null;
const index = rest.length >= 2 ? rest[1] : null;

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 200000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('解析响应失败: ' + d.slice(0, 200))); } });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

async function findPort(proc, timeoutMs) {
  const netstat = () => new Promise((resolve) => {
    const c = spawn('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -OwningProcess ${proc.pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(parseInt(String(out).trim(), 10) || 0));
  });
  const deadline = Date.now() + (timeoutMs || 90000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const p = await netstat();
    if (p) return p;
  }
  return 0;
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('找不到 exe：' + EXE + '（先 npm run pack）'); process.exit(2); }
  if (!noDebug) { try { fs.rmSync(DIAG, { force: true }); } catch (e) { /* ignore */ } }

  console.log('启动 ' + path.basename(EXE) + (noDebug ? '' : '（诊断日志：' + DIAG + '）'));
  const proc = spawn(EXE, [], { windowsHide: true,
    cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, noDebug ? {} : { CFCOACH_DEBUG_EDITORIAL: '1' }),
    detached: false, stdio: 'ignore'
  });
  const port = await findPort(proc);
  if (!port) { console.error('等不到应用监听端口'); try { proc.kill(); } catch (e) {} process.exit(2); }
  console.log('端口 ' + port);

  const q = entryId
    ? ('entryId=' + encodeURIComponent(entryId))
    : ('contestId=' + encodeURIComponent(contestId) + '&index=' + encodeURIComponent(index));
  const url = 'http://127.0.0.1:' + port + '/api/review/editorial?' + q;
  console.log('GET ' + url);
  const t0 = Date.now();
  let r = null;
  try { r = await getJson(url, 200000); } catch (e) { console.error('请求失败: ' + e.message); }
  const secs = Math.round((Date.now() - t0) / 100) / 10;

  console.log('\n===== 响应（' + secs + 's）=====');
  if (r) {
    console.log('ok=' + r.ok + '  reason=' + (r.reason || '-') + '  sliced=' + r.sliced
      + '  entryId=' + (r.entryId || '-') + '  正文长度=' + ((r.content || '').length));
    if (r.hint) console.log('hint: ' + r.hint);
    if (r.diag && r.diag.length) r.diag.forEach((d) => console.log('diag: ' + d));
    if (r.ok && r.content) {
      console.log('--- 正文前 800 字 ---');
      console.log(r.content.slice(0, 800));
    }
  }

  try { proc.kill(); } catch (e) { /* ignore */ }
  await new Promise((r2) => setTimeout(r2, 1500));
  if (!noDebug && fs.existsSync(DIAG)) {
    console.log('\n===== 诊断日志（尾部 20 行）=====');
    console.log(fs.readFileSync(DIAG, 'utf8').split('\n').filter(Boolean).slice(-20).join('\n'));
  } else if (!noDebug) {
    console.log('\n（没有诊断日志文件 —— 说明探针一次都没走到记录点）');
  }
  process.exit(r && r.ok ? 0 : 1);
})();
