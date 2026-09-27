/**
 * patch-runner-compare.js — 把 runner.js 里"直接比字符串"的判定换成 compareOutputs（先归一化再判等）。
 *
 * 为什么要改：等值比对会制造假失败（YES/Yes、空格 vs 换行、浮点尾数差）——
 * 判定说"你错了"，其实它对；模型于是无限重写（真实反馈："是你的判据在制造假失败"）。
 * 顺带把 kind（layout/case/precision）带出来，好让上层**给失败分类**：格式类便宜处理，真差异才重写。
 *
 * 用法：node .probe/patch-runner-compare.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'lib', 'runner.js');
let s = fs.readFileSync(file, 'utf8');
let n = 0;

// ① 样例判定：AC 记为 kind==='same'|'layout'|'case'|'precision'（等价即通过），并带上 formatDiff
s = s.split("else verdict = normalizeOutput(r.output) === normalizeOutput(s.output) ? 'AC' : 'WA';")
  .join("else {\n"
    + "        const cmp = (s.output == null) ? { ok: true, kind: 'same' } : compareOutputs(r.output, s.output);\n"
    + "        verdict = cmp.ok ? 'AC' : 'WA';\n"
    + "        // 等价但形态不同（空白布局/大小写/浮点尾数）→ 不算错，但记下来，方便上层给出准确的格式反馈\n"
    + "        if (cmp.ok && cmp.kind !== 'same') formatDiff = cmp.kind;\n"
    + "      }");
n += (s.match(/const cmp = \(s\.output == null\)/g) || []).length;

// ② 对拍里的一致判定
s = s.split('if (normalizeOutput(bi.output) !== normalizeOutput(si.output)) {')
  .join('if (!compareOutputs(bi.output, si.output).ok) {');
s = s.split('const same = a.ok && b.ok && normalizeOutput(a.output) === normalizeOutput(b.output);')
  .join('const same = a.ok && b.ok && compareOutputs(a.output, b.output).ok;');

// ③ 导出 compareOutputs（上层要给失败分类）
s = s.replace('module.exports = {\n  runSamples,', 'module.exports = {\n  runSamples, compareOutputs, normalizeOutput,');

fs.writeFileSync(file, s);
console.log('替换完成');
