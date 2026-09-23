/**
 * cf-dump.js — 诊断脚本：用 Electron 内嵌浏览器通道抓取 CF 题面页并把原始 HTML 落盘
 * 用法：node scripts/cf-dump.js <URL 或 1800C 形式的编号>
 * 产物：.cf-dump/*.html（供离线调试解析器）
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = process.argv[2] || '';
if (!arg) {
  console.error('用法: node scripts/cf-dump.js <URL|1800C>');
  process.exit(1);
}
const dumpDir = path.join(ROOT, '.cf-dump');
// CHATBOX_SMOKE=1 会跳过单实例锁：用户的应用正在运行时也能做诊断抓取
const env = Object.assign({}, process.env, { CHATBOX_CF_DUMP: dumpDir, CHATBOX_SMOKE: '1' });
const m = arg.match(/^(\d+)\s*([A-Za-z][0-9]?)$/);
if (m) env.CHATBOX_CF_API_TEST = arg;
else env.CHATBOX_CF_TEST = arg;

const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT], {
  cwd: ROOT, env, stdio: 'inherit', windowsHide: true
});
child.on('exit', (code) => {
  console.log('[cf-dump] 退出码 ' + code + '，产物目录: ' + dumpDir);
  process.exit(code == null ? 1 : code);
});
