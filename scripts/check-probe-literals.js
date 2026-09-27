/**
 * check-probe-literals.js — 静态检查：_PROBE_ 之类的模板字面量里有没有"会提前结束字符串"的东西。
 *
 * 为什么需要（真实事故，踩了两次）：
 *   electron/main.js 里那些页面探针是**模板字面量**（反引号包围）。
 *   在它们**内部**的注释里写 Markdown 风格的反引号（比如 `.topic`），会直接结束模板字符串 ——
 *   后果是 `const PROBE_EDITORIAL_BODY` 无法初始化，运行时抛
 *   "Cannot access 'PROBE_EDITORIAL_BODY' before initialization"，
 *   而那一步的报错信息还会被 Electron 包装成没头没脑的 "Script failed to execute"。
 *   结果我误以为是 Cloudflare 反爬不过，白查了很久。
 *   同理 `${` 会被当成插值，也必须转义。
 *
 * 用法：node scripts/check-probe-literals.js   （建议挂进 npm test / 打包前检查）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILES = ['electron/main.js', 'lib/cf.js'];
let bad = 0;

for (const rel of FILES) {
  const file = path.join(__dirname, '..', rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');

  // 找所有 `const NAME = ` 后面紧跟反引号的模板字面量
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`/);
    if (!m) continue;
    const name = m[1];
    const startLine = i;
    // 从这一行开始拼接，直到找到"真正的结束反引号"（其后紧跟 ; 或行尾）
    let acc = lines[i].slice(lines[i].indexOf('`') + 1);
    let line = i;
    let closed = false;
    let innerBad = [];
    // 逐行扫描：既找结束，也检查内部裸反引号
    let scanning = true;
    let buf = acc;
    while (scanning) {
      // 在本行 buf 里找结束反引号：判定条件是"后面只剩 ; 或空白"
      let k = 0;
      let endPos = -1;
      while (k < buf.length) {
        if (buf[k] === '\\') { k += 2; continue; }
        if (buf[k] === '`') {
          const tail = buf.slice(k + 1).trim();
          if (tail === '' || tail === ';') { endPos = k; break; }
          // 内部裸反引号：记录（这是 bug）
          innerBad.push({ line: line + 1, text: buf.slice(Math.max(0, k - 30), k + 30) });
        }
        k++;
      }
      if (endPos >= 0) { closed = true; break; }
      line++;
      if (line >= lines.length) break;
      buf = lines[line];
      // `${` 检查
      const dm = buf.match(/(^|[^\\])\$\{/);
      if (dm) innerBad.push({ line: line + 1, text: '未转义的 ${：' + buf.trim().slice(0, 60) });
    }
    if (!closed) {
      console.log('✗ ' + rel + ':' + (startLine + 1) + '  ' + name + ' 模板字面量**没有正常结束**（可能内部有裸反引号）');
      bad++;
    }
    if (innerBad.length) {
      console.log('✗ ' + rel + ':' + (startLine + 1) + '  ' + name + ' 内部有 ' + innerBad.length + ' 处可疑内容（会导致模板提前结束）：');
      innerBad.slice(0, 5).forEach((b) => console.log('     第 ' + b.line + ' 行：' + JSON.stringify(b.text)));
      bad++;
    } else {
      // 再做一次"能不能求值"的实证检查
      const litStart = src.indexOf('`', src.indexOf(m[0]));
      let j = litStart + 1, end = -1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') {
          const tail = src.slice(j + 1, j + 4);
          if (tail.startsWith(';') || tail.startsWith('\n')) { end = j; break; }
        }
        j++;
      }
      if (end < 0) { console.log('✗ ' + rel + '  ' + name + ' 找不到结束反引号'); bad++; continue; }
      try {
        const v = eval(src.slice(litStart, end + 1));   // eslint-disable-line no-eval
        console.log('✓ ' + rel + ':' + (startLine + 1) + '  ' + name + '（可求值，长度 ' + String(v).length + '）');
      } catch (e) {
        console.log('✗ ' + rel + ':' + (startLine + 1) + '  ' + name + ' 无法求值：' + e.message);
        bad++;
      }
    }
  }
}

console.log(bad ? ('\n有 ' + bad + ' 处问题 —— 模板字面量内部不要用反引号/未转义的 ${') : '\n✅ 所有模板字面量都正常');
process.exitCode = bad ? 1 : 0;
