/**
 * run-e2e.js — 一键端到端测试（自动拉起 mock 服务与隔离数据目录的 server，跑完自动清理）
 * 用法：node scripts/run-e2e.js
 *
 * 为什么需要它：test-e2e.js 会反复写配置 / 建会话 / 归档 / 导入导出，
 * 必须跑在独立的 CHATBOX_DATA_DIR 上，否则会覆盖用户真实数据（历史教训）。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.test-data', 'e2e');
const PORT = 3210;
const CF_PORT = 3998;
const LLM_PORT = 3999;

const children = [];

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: 'ignore',
    windowsHide: true
  });
  child.on('exit', (code) => {
    if (!stopping) console.log('[e2e] ' + name + ' 提前退出，code=' + code);
  });
  children.push({ name, child });
  return child;
}

let stopping = false;
function stopAll() {
  stopping = true;
  for (const { child } of children) {
    try { child.kill(); } catch (e) { /* ignore */ }
  }
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/info');
      if (r.ok) {
        const j = await r.json();
        // 身份校验：必须是「我们启动的、用隔离数据目录」的那个 server，
        // 否则说明端口被别的实例占用（会把测试数据写进用户真实数据目录）
        return { ok: true, dataDir: j.dataDir, version: j.version };
      }
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false };
}

function findFreePort(start) {
  const net = require('net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findFreePort(start + 1)));
    srv.once('listening', () => { srv.close(() => resolve(start)); });
    srv.listen(start, '127.0.0.1');
  });
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[e2e] 隔离数据目录: ' + DATA_DIR);

  // 先跑秒级的单测（真实事故夹具）：挡住"三份产物抱团说谎""讲解编码/结构""粘贴题面/信息卡"这几类回归
  for (const t of ['test-anticheat.js', 'test-explaindoc.js', 'test-statement.js', 'test-pricing.js', 'test-parallel.js', 'test-agentruns.js']) {
    const ac = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', t)], {
      cwd: ROOT, stdio: 'inherit', windowsHide: true
    });
    if (ac.status !== 0) {
      console.error('[e2e] ' + t + ' 未通过，已中止（先修它再看端到端）');
      process.exit(ac.status == null ? 1 : ac.status);
    }
  }

  // 先用一个空闲端口，避免撞上残留 server（历史上撞过一次，测试写脏了真实数据）
  const port = await findFreePort(PORT);
  if (port !== PORT) console.log('[e2e] ' + PORT + ' 被占用，改用端口 ' + port);

  start('mock-cf', [path.join(ROOT, 'scripts', 'mock-cf.js')], { PORT: String(CF_PORT) });
  start('mock-llm', [path.join(ROOT, 'scripts', 'mock-llm.js')], { PORT: String(LLM_PORT) });
  start('server', [path.join(ROOT, 'server.js')], {
    PORT: String(port),
    CF_BASE: 'http://127.0.0.1:' + CF_PORT,
    CHATBOX_DATA_DIR: DATA_DIR
  });

  const ready = await waitPort(port, 15000);
  if (!ready.ok) {
    console.error('[e2e] server 未能在 15 秒内启动');
    stopAll();
    process.exit(1);
  }
  if (path.resolve(ready.dataDir) !== path.resolve(DATA_DIR)) {
    console.error('[e2e] 端口 ' + port + ' 上的 server 数据目录是 ' + ready.dataDir
      + '，不是隔离目录 ' + DATA_DIR + '；已中止（避免写脏真实数据）');
    stopAll();
    process.exit(1);
  }
  console.log('[e2e] server 就绪 v' + ready.version + ' @ http://127.0.0.1:' + port);

  const test = spawn(process.execPath, [path.join(ROOT, 'scripts', 'test-e2e.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: Object.assign({}, process.env, {
      E2E_BASE: 'http://127.0.0.1:' + port,
      E2E_MOCK: 'http://127.0.0.1:' + LLM_PORT + '/v1'
    })
  });
  const code = await new Promise((resolve) => test.on('exit', (c) => resolve(c == null ? 1 : c)));
  stopAll();
  console.log('[e2e] 结束，退出码: ' + code);
  process.exit(code);
}

process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('exit', stopAll);

main().catch((e) => {
  console.error('[e2e] 运行失败: ' + (e && e.stack || e));
  stopAll();
  process.exit(1);
});
