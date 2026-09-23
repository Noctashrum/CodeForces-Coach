/**
 * run-smoke.js — 桌面版冒烟测试入口（Node 包装，可靠捕获 GUI 进程输出）
 * 用法：node scripts/run-smoke.js [--packaged]
 *   - 无参数：测试开发模式（node_modules/electron + 项目目录）
 *   - --packaged：测试打包产物 dist/CFCoach-win32-x64/CFCoach.exe
 * 校验点：页面渲染、全屏覆盖层点击穿透、真实点击「新建对话」、零页面报错、截图
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const packaged = process.argv.includes('--packaged');

const electronExe = packaged
  ? path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe')
  : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const appArg = packaged ? [] : [ROOT];

// 关键：冒烟测试必须用隔离的数据目录，绝不能碰用户真实数据
// （打包版的真实数据就在 exe 旁的 data/，早期版本曾被测试覆盖）
const testData = path.join(ROOT, '.test-data', packaged ? 'smoke-packaged' : 'smoke-dev');
fs.rmSync(testData, { recursive: true, force: true });
fs.mkdirSync(testData, { recursive: true });

console.log('[smoke] 目标: ' + electronExe + (packaged ? '' : ' ' + ROOT));
console.log('[smoke] 测试数据目录: ' + testData);
const child = spawn(electronExe, appArg, {
  env: Object.assign({}, process.env, { CHATBOX_SMOKE: '1', CHATBOX_DATA_DIR: testData }),
  stdio: 'inherit',
  windowsHide: false
});

// 冒烟里有一段"并发工作台"要跑真实 SSE：需要本地 mock 上游（LLM 3999）与 CF 题面（3998）
const mocks = [
  { name: 'mock-cf', file: 'mock-cf.js', port: 3998 },
  { name: 'mock-llm', file: 'mock-llm.js', port: 3999 }
].map((m) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', m.file)], {
    env: Object.assign({}, process.env, { PORT: String(m.port) }),
    stdio: 'ignore',
    windowsHide: true
  });
  return c;
});
function stopMocks() {
  mocks.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } });
}
process.on('exit', stopMocks);

child.on('exit', (code) => {
  stopMocks();
  console.log('[smoke] 子进程退出码: ' + code);
  process.exit(code == null ? 1 : code);
});
child.on('error', (e) => {
  stopMocks();
  console.error('[smoke] 启动失败: ' + e.message);
  process.exit(1);
});
