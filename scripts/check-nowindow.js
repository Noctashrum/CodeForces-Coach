#!/usr/bin/env node
/**
 * 硬闸：**任何子进程都不能弹出窗口**。
 *
 * 事故（2026-10-08，用户第三次被整机黑屏卡死打断）：
 * 判分 / 对拍 / 探针在后台跑时，某个 `spawn` 没写 `windowsHide: true`。当父进程自己没有控制台
 * （DSH 后台作业、GUI 进程都是这种）时，Windows 会给这个子进程**新开一个控制台窗口** ——
 * 屏幕上就是一个卡住的黑框，用户以为机器死了。前两次是取题用的 Electron 可见窗口
 * （`CFCOACH_CF_HIDDEN_ONLY` 已把产品侧的默认关掉），这一次是控制台窗口。
 *
 * 所以这条检查写成脚本、进 `test:units`：以后任何人（包括我）写 `spawn/exec` 忘了
 * `windowsHide: true`，回归会直接红。故意要可见窗口的调用点必须显式写 `// nowindow-ok <理由>`。
 *
 * 用法：node scripts/check-nowindow.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'tmp', '.probe\\tmp', '.probe/tmp', 'build', 'release', 'pack']);
const CALL = /\b(spawn|spawnSync|exec|execFile|execFileSync|execSync)\s*\(/g;

function walk(dir, out) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walk(full, out);
    } else if (it.isFile() && it.name.endsWith('.js')) {
      if (full.includes('vendor')) continue; // 第三方压缩产物里的 exec( 是正则方法，不是子进程
      out.push(full);
    }
  }
  return out;
}

/** 取一个调用点到它的右括号（够用的括号计数，忽略字符串内的括号这种极端情况） */
function callText(src, start) {
  let depth = 0;
  let i = src.indexOf('(', start);
  const from = i;
  for (; i < src.length && i - from < 2000; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  return { text: src.slice(from, i + 1), end: i };
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

function main() {
  const files = walk(ROOT, []);
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(src))) {
      const name = m[1];
      const at = m.index;
      // 注释里的示例不算（例如 lib/sandbox.js 的 "直接传给 spawn({ env })"）
      const lineStart = src.lastIndexOf('\n', at) + 1;
      const before = src.slice(lineStart, at);
      if (/^\s*(\/\/|\*|\/\*)/.test(before)) continue;
      const prev = src.slice(Math.max(0, at - 3), at);
      // 方法调用（m.exec(...)、re.exec(...)）或函数定义不算
      if (/[.\w$]/.test(prev.slice(-1)) && prev.slice(-1) === '.') continue;
      if (new RegExp('(function|const|let|var)\\s+' + name + '\\s*$').test(src.slice(Math.max(0, at - 40), at))) continue;
      const { text } = callText(src, at);
      // 整条语句往后看 300 字符（多行 options 对象）
      const window = text + src.slice(at + text.length, at + text.length + 300);
      checked++;
      if (!/windowsHide\s*:\s*true/.test(window)) {
        if (/nowindow-ok/.test(window)) continue;
        bad.push({ file: path.relative(ROOT, file), line: lineOf(src, at), text: text.slice(0, 120).replace(/\s+/g, ' ') });
      }
    }
  }
  console.log('扫描 ' + files.length + ' 个 js 文件，检查 ' + checked + ' 处子进程调用');
  if (!bad.length) {
    console.log('✓ 全部带 windowsHide: true（不会弹控制台窗口）');
    return 0;
  }
  console.error('✗ ' + bad.length + ' 处子进程调用没写 windowsHide: true —— 会弹出黑色控制台窗口：\n');
  for (const b of bad) console.error('  ' + b.file + ':' + b.line + '  ' + b.text);
  console.error('\n修法：给 options 加 `windowsHide: true`；确实需要可见窗口的，写 `// nowindow-ok <理由>`。');
  return 1;
}

process.exit(main());
