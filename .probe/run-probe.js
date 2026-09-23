'use strict';
/**
 * run-probe.js — 一键跑探针：拉起 mock-cf / mock-llm / server（隔离数据目录）→ 执行指定探针 → 清理。
 * 用法：node .probe/run-probe.js probe-parallel-stop.js [端口]
 *   （Windows 下 PowerShell 5.1 的 Start-Process 不支持 -Environment，所以用 Node 起服务最省事）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const probe = process.argv[2] || 'probe-parallel-stop.js';
const PORT = parseInt(process.argv[3] || '3214', 10);
const CF_PORT = 3998;
const LLM_PORT = 3999;
const DATA = path.join(ROOT, '.test-data', 'probe-' + PORT);

const kids = [];
function start(name, args, env) {
  const c = spawn(process.execPath, args, {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
    env: Object.assign({}, process.env, env || {})
  });
  c.on('exit', (code) => { if (code) console.log('[probe] ' + name + ' 退出 code=' + code); });
  kids.push(c);
  return c;
}
function stopAll() { kids.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } }); }
process.on('exit', stopAll);

async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/info'); if (r.ok) return true; } catch (e) { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  console.log('[probe] 隔离数据目录: ' + DATA);
  start('mock-cf', [path.join(ROOT, 'scripts', 'mock-cf.js')], { PORT: String(CF_PORT) });
  start('mock-llm', [path.join(ROOT, 'scripts', 'mock-llm.js')], { PORT: String(LLM_PORT) });
  start('server', [path.join(ROOT, 'server.js')], {
    PORT: String(PORT), CF_BASE: 'http://127.0.0.1:' + CF_PORT, CHATBOX_DATA_DIR: DATA
  });
  if (!await waitPort(PORT, 15000)) { console.error('[probe] server 没起来'); stopAll(); process.exit(1); }
  const child = spawn(process.execPath, [path.join(__dirname, probe), 'http://127.0.0.1:' + PORT], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true
  });
  const code = await new Promise((r) => child.on('exit', (c) => r(c == null ? 1 : c)));
  stopAll();
  process.exit(code);
})().catch((e) => { console.error('[probe] 异常: ' + ((e && e.stack) || e)); stopAll(); process.exit(1); });
