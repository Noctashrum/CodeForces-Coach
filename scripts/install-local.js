/**
 * install-local.js — 把打包产物装到"能正常运行"的普通用户目录，并保持快捷方式同步。
 *
 * 为什么要这个脚本（不是可有可无的便利功能）：
 *   有些目录树带受限的 ACL（能力 SID `S-1-4-…`、`Everyone:(DENY)(DC)` 这类 ACE，
 *   沙箱/加固环境常见）。Chromium 的 AppContainer 子进程在那样的树下**起不来**：
 *   Electron 会在 JS 跑起来之前就以 `STATUS_BREAKPOINT`（exit `-2147483645` /
 *   `0x80000003`）静默死掉——没有窗口、没有报错、没有日志。同一份产物复制到普通
 *   用户目录就能正常启动（2026-10-11 实测）。
 *
 * 所以：**dist/ 是产物，不是运行位置**。要跑就 `npm run pack && npm run install:local`。
 *
 * 数据安全：便携版的数据（对话 / IDE 代码 / 题库缓存）在 exe 旁的 data/。
 * 这个脚本**默认不动目标 data/**（只有目标还没有 data 时才把源 data 搬过去），
 * 要用 dist 里的 data 覆盖目标，得显式 `--with-data`。
 *
 * 用法：
 *   node scripts/install-local.js                 # 装到 %LOCALAPPDATA%\Programs\cf-coach
 *   node scripts/install-local.js --dry-run       # 只报告要做什么，不写盘
 *   node scripts/install-local.js --dir=D:\cfcoach
 *   node scripts/install-local.js --with-data     # 连 data 一起覆盖（慎用）
 *   node scripts/install-local.js --no-shortcut   # 不动桌面快捷方式
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SRC = path.join(ROOT, 'dist', 'CFCoach-win32-x64');

function parseArgs(argv) {
  const out = { dir: '', src: DEFAULT_SRC, withData: false, shortcut: true, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--dir=')) out.dir = a.slice(6);
    else if (a.startsWith('--src=')) out.src = a.slice(6);
    else if (a === '--with-data') out.withData = true;
    else if (a === '--no-shortcut') out.shortcut = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/install-local.js [--dir=<目录>] [--src=<产物目录>] [--with-data] [--no-shortcut] [--dry-run]');
      process.exit(0);
    } else {
      console.error('没见过的参数: ' + a + '（--help 看用法）');
      process.exit(1);
    }
  }
  if (!out.dir) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    out.dir = path.join(local, 'Programs', 'cf-coach');
  }
  return out;
}

/** 递归复制（Node 18 的 cpSync 足够；比 spawn robocopy 少一个子进程） */
function copyTree(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (s) => (typeof filter === 'function' ? filter(s) : true),
  });
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(p).size; } catch (err) { /* ignore */ } }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 目标 exe 被占用吗（正在运行的教练）—— 用 open r+ 探测，不启子进程 */
function isLocked(exe) {
  if (!fs.existsSync(exe)) return false;
  try {
    const fd = fs.openSync(exe, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
  }
}

/** 桌面快捷方式：把指向 CFCoach.exe 的都改成新位置，并保证有一个 CF Coach.lnk */
function fixShortcut(exe, workDir) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$ws=New-Object -ComObject WScript.Shell",
    "$desk=[Environment]::GetFolderPath('Desktop')",
    "$hit=0",
    "foreach($f in Get-ChildItem -Path $desk -Filter *.lnk -ErrorAction SilentlyContinue){",
    "  try{ $sc=$ws.CreateShortcut($f.FullName) }catch{ continue }",
    "  if($sc.TargetPath -and ([IO.Path]::GetFileName($sc.TargetPath) -ieq 'CFCoach.exe')){",
    "    $sc.TargetPath='" + exe.replace(/'/g, "''") + "';",
    "    $sc.WorkingDirectory='" + workDir.replace(/'/g, "''") + "';",
    "    $sc.Save(); $hit++; Write-Output ('repointed: ' + $f.Name) } }",
    "if($hit -eq 0){",
    "  $main=Join-Path $desk 'CF Coach.lnk'",
    "  $sc=$ws.CreateShortcut($main); $sc.TargetPath='" + exe.replace(/'/g, "''") + "'; $sc.WorkingDirectory='" + workDir.replace(/'/g, "''") + "'; $sc.Description='CF Coach'; $sc.Save(); Write-Output 'created: CF Coach.lnk'",
    "} else { Write-Output ('ok: 桌面已有 ' + $hit + ' 个指向教练的快捷方式，都改到新位置了') }",
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, // nowindow-ok 这是后台完成快捷方式改写的辅助进程，绝不能弹窗（AGENTS §0）
    encoding: 'utf8',
  });
  if (r.status === 0) {
    String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).forEach((s) => console.log('  快捷方式 ' + s));
  } else {
    console.log('  快捷方式没改成（可以手动改指向 ' + exe + '）：' + String(r.stderr || '').trim().split('\n')[0]);
  }
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const src = path.resolve(opt.src);
  const dest = path.resolve(opt.dir);
  const srcExe = path.join(src, 'CFCoach.exe');
  const destExe = path.join(dest, 'CFCoach.exe');

  console.log('源（打包产物）: ' + src);
  console.log('目标（运行位置）: ' + dest);

  if (!fs.existsSync(srcExe)) {
    console.error('✗ 源里没有 CFCoach.exe，先 npm run pack');
    process.exit(1);
  }
  if (src === dest) {
    console.error('✗ 源和目标是同一个目录；这个脚本要的就是"装到别处去跑"');
    process.exit(1);
  }
  if (isLocked(destExe)) {
    console.error('✗ 目标位置的教练正在运行（exe 被占用）。先关掉它再同步。');
    process.exit(1);
  }

  const srcData = path.join(src, 'data');
  const destData = path.join(dest, 'data');
  const destHasData = fs.existsSync(destData);
  const srcStat = dirStats(src);
  console.log('  源规模: ' + srcStat.files + ' 文件 / ' + (srcStat.bytes / 1048576).toFixed(0) + ' MB');
  console.log('  目标 data/: ' + (destHasData ? '已存在（默认不动它）' : '不存在（首次安装，会把源 data 搬过去）'));

  if (opt.dryRun) {
    console.log('（--dry-run：什么都没写）');
    console.log('会做：同步产物到 ' + dest + (destHasData && !opt.withData ? '（跳过 data）' : '（含 data）'));
    if (opt.shortcut) console.log('会做：把桌面上指向 CFCoach.exe 的快捷方式改到 ' + destExe);
    process.exit(0);
  }

  // 1) 同步产物。排除 data 的两种情况：
  //    · 目标已有 data 且没加 --with-data → 保住用户数据
  //    · 加 --with-data → 连 data 一起覆盖
  const keepDestData = destHasData && !opt.withData;
  const dataPrefix = path.resolve(srcData) + path.sep;
  const filter = keepDestData
    ? (p) => path.resolve(p) !== path.resolve(srcData) && !(path.resolve(p) + path.sep).startsWith(dataPrefix)
    : undefined;

  console.log('  正在同步（' + (keepDestData ? '跳过 data/，保留目标数据' : '包含 data/') + '）…');
  const t0 = Date.now();
  try {
    copyTree(src, dest, filter);
  } catch (e) {
    console.error('✗ 同步失败: ' + ((e && e.message) || e));
    console.error('  如果是 EBUSY/EPERM，多半是教练还开着（或杀软正在扫），关掉重跑。');
    process.exit(1);
  }
  const copied = dirStats(dest);
  console.log('  完成：' + copied.files + ' 文件 / ' + (copied.bytes / 1048576).toFixed(0) + ' MB，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // 2) 关键自检：目标位置真的能启动吗（用 --no-sandbox 之外的默认方式判断不了，
  //    这里只做"文件到位 + exe 可读"的静态检查，启动验证由 .probe/startup-plain.js 做）
  if (!fs.existsSync(destExe)) {
    console.error('✗ 同步完了却找不到 ' + destExe);
    process.exit(1);
  }
  const size = fs.statSync(destExe).size;
  let readable = false;
  try { fs.accessSync(destExe, fs.constants.R_OK); readable = true; } catch (e) { readable = false; }
  console.log('  自检：' + destExe + '（' + (size / 1048576).toFixed(0) + ' MB，可读 ' + (readable ? '✓' : '✗') + '）');

  // 3) 快捷方式
  if (opt.shortcut) fixShortcut(destExe, dest);

  console.log('\n✅ 装好了：' + destExe);
  console.log('   双击桌面快捷方式即可。看到"Windows 已保护你的电脑"就点 更多信息 → 仍要运行（exe 未签名）。');
  console.log('   想先验证这个位置能不能起得来：node .probe/startup-plain.js --exe="' + destExe + '"');
}

main();
