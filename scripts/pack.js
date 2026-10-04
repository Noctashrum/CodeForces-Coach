/**
 * pack.js — 便携打包脚本（@electron/packager）
 * 产物：dist/CFCoach-win32-x64/ 目录，双击 CFCoach.exe 运行，
 * 数据保存在 exe 旁边的 data/ 目录，整个文件夹拷贝即迁移。
 * 用法：npm run pack
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

/** 递归复制目录（Node 16.7+ 的 cpSync 足够） */
function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * 找本机已下载的 Electron 压缩包（@electron/get 的缓存），用于**离线打包**。
 * 为什么需要：打包时 packager 会去 GitHub 取校验和，企业网/杀软做 TLS 拦截时
 * 直接 `unable to verify the first certificate` 失败；而二进制其实早就在本地缓存里。
 */
function findElectronZip(version) {
  const name = 'electron-v' + version + '-win32-x64.zip';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [
    path.join(ROOT, '.electron-cache'),
    path.join(localAppData, 'electron', 'Cache')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, name))) return path.join(root, name);
    let subs = [];
    try { subs = fs.readdirSync(root); } catch (e) { subs = []; }
    for (const d of subs) {
      const p = path.join(root, d, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

async function main() {
  let packager;
  try {
    const mod = require('@electron/packager');
    packager = typeof mod === 'function' ? mod : (mod.packager || mod.default);
  } catch (e) {
    console.error('未安装 @electron/packager，请先执行: npm install --save-dev @electron/packager');
    process.exit(1);
  }
  const out = path.join(ROOT, 'dist');
  // 关键：@electron/packager 的 overwrite 会删掉整个输出目录，
  // 而便携版的用户数据（配置 API Key、会话、信息卡）就存在 exe 旁的 data/ 里，
  // 所以先把 data/ 备份出来，打包完再放回去——重新打包绝不能丢用户数据。
  const appDir = path.join(out, 'CFCoach-win32-x64');
  const userData = path.join(appDir, 'data');
  const backup = path.join(ROOT, '.pack-data-backup');
  const hasData = fs.existsSync(userData);
  if (hasData) {
    copyDir(userData, backup);
    console.log('已备份原有数据目录: ' + userData + '（打包后原样恢复）');
  }
  // 离线优先：本地已有 Electron 包就直接指定，绝不为了取校验和去走网络
  let electronZipDir = '';
  try {
    const electronVersion = require('electron/package.json').version;
    const zip = findElectronZip(electronVersion);
    if (zip) {
      const cacheDir = path.join(ROOT, '.electron-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const dest = path.join(cacheDir, path.basename(zip));
      const fresh = fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(zip).size;
      if (!fresh) {
        try { fs.linkSync(zip, dest); } catch (e) { fs.copyFileSync(zip, dest); }
      }
      electronZipDir = cacheDir;
      console.log('使用本地 Electron 包（离线打包）: ' + path.basename(zip));
    } else {
      console.log('本地没有 Electron 包缓存，将尝试联网下载（可能因证书拦截失败）');
    }
  } catch (e) { /* 拿不到版本就按默认流程 */ }

  const appPaths = await packager(Object.assign({
    dir: ROOT,
    out: out,
    name: 'CFCoach',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: false,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    prune: true,
    // 双击 exe **不要**弹出控制台窗口：这是个纯桌面软件，日志走应用内的工作台/决策轨迹，
    // 不需要也不该让用户看到一个黑终端。显式声明子系统为 GUI（打包器默认值就是这个，
    // 但在这里写明意图，避免以后有人"为了看日志"把它改成 Console: true）。
    win32metadata: { Console: false },
    ignore: [
      /^\/data($|\/)/,
      /^\/dist($|\/)/,
      /^\/\.test-data($|\/)/,
      /^\/\.pack-data-backup($|\/)/,
      /^\/\.electron-cache($|\/)/,
      /^\/\.npm-cache($|\/)/,
      /^\/scripts($|\/)/,
      /^\/docs($|\/)/,
      /^\/ablation($|\/)/,
      /^\/\.edge-tmp($|\/)/,
      /^\/node_modules\/\.cache($|\/)/,
      /^\/README\.md$/,
      /^\/\.gitignore$/,
      /^\/smoke\.png$/,
      /^\/\.dom[\s\S]*$/,
      /^\/\.conv-id\.txt$/,
      /^\/\.req\.json$/,
      /^\/\.resp\.sse$/,
      /^\/\.probe($|\/)/,
      /^\/\.chat\d*\.txt$/,
      /^\/\.last-answer\.md$/,
      /^\/\.debug-[\w.-]+\.js$/
    ]
  }, electronZipDir ? { electronZipDir: electronZipDir } : {}));
  if (hasData) {
    copyDir(backup, userData);
    fs.rmSync(backup, { recursive: true, force: true });
    console.log('已恢复用户数据目录（配置 / 会话 / 信息卡未受影响）');
  }
  console.log('打包完成:');
  appPaths.forEach((p) => console.log('  ' + p));
  console.log('运行: ' + path.join(out, 'CFCoach-win32-x64', 'CFCoach.exe'));
}

main().catch((e) => {
  console.error('打包失败:', (e && e.message) || e);
  // 数据安全第一：打包失败也必须保证 exe 旁的 data/ 还在（用户数据宁可多留一份）
  const userData = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
  const backup = path.join(ROOT, '.pack-data-backup');
  try {
    if (!fs.existsSync(userData) && fs.existsSync(backup)) {
      copyDir(backup, userData);
      console.error('已从备份恢复用户数据: ' + userData);
    }
  } catch (err) {
    console.error('恢复用户数据失败（备份仍在 .pack-data-backup，请手动复制回 data/）: ' + err.message);
  }
  process.exit(1);
});
