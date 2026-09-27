/**
 * probe-review-session.js — 端到端验证"装复盘材料"：题解 + **多份源码** + 自动开会话。
 *
 * 用法：
 *   node scripts/probe-review-session.js <handle> <contestId> [--no-source]
 *
 * 输出每题装到了什么，以及最终材料里各类内容的条数（题解 / 首次提交 / 最后一次未通过 / 首次通过）。
 */
'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const CONV_DIR = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data', 'conversations');

const argv = process.argv.slice(2).filter((a) => a !== '--no-source');
const withSource = !process.argv.includes('--no-source');
const [handle, contestId] = argv;
if (!handle || !contestId) { console.error('用法: node scripts/probe-review-session.js <handle> <contestId> [--no-source]'); process.exit(2); }

function post(url, body, ms) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const evs = raw.split('\n').filter((l) => l.startsWith('data:'))
          .map((l) => { try { return JSON.parse(l.slice(5)); } catch (e) { return null; } })
          .filter(Boolean);
        resolve(evs);
      });
    });
    req.on('error', reject);
    req.setTimeout(ms || 240000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
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
  if (!port) { console.error('拿不到端口'); proc.kill(); process.exit(2); }
  console.log('端口 ' + port + '，开始装材料（含源码: ' + withSource + '）…\n');

  const t0 = Date.now();
  const evs = await post('http://127.0.0.1:' + port + '/api/review/session',
    { handle, contestId, includeSource: withSource }, 300000);
  let convId = null;
  for (const e of evs) {
    if (e.type === 'item' && e.state === 'done') {
      console.log('  题 ' + e.index + '：' + e.message + '  [editorial=' + e.editorial + ' source=' + e.source + ']');
    } else if (e.type === 'done') {
      convId = e.conversationId;
      console.log('\n完成（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）：会话 ' + convId
        + ' | 题解到手 ' + e.editorialOk + ' | 无题解 ' + e.editorialNone);
    } else if (e.type === 'error') {
      console.log('错误：' + e.message);
    }
  }
  try { proc.kill(); } catch (e) { /* ignore */ }

  if (convId && fs.existsSync(path.join(CONV_DIR, convId + '.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, convId + '.json'), 'utf8'));
    const s = c.statementText || '';
    const count = (re) => (s.match(re) || []).length;
    console.log('\n===== 材料统计 =====');
    console.log('  材料长度        ' + s.length + ' 字符');
    console.log('  官方题解块      ' + count(/官方题解（来自/g));
    console.log('  源码块          ' + count(/选手源码 · /g));
    console.log('    · 首次提交    ' + count(/首次提交/g));
    console.log('    · 最后一次未通过 ' + count(/最后一次未通过/g));
    console.log('    · 首次通过    ' + count(/首次通过/g));
    // 只数"本题源码确实没取到"的告警行；直接用 /没取到/ 会把材料开头那句
    // "只有材料里明确写着没有找到 / 没取到的东西才需要你处理"也算进去（假阳性）。
    console.log('  源码没取到      ' + count(/选手源码：\*\*没取到\*\*/g));
  }
  process.exit(0);
})();
