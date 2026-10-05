/**
 * 命令行诊断包：`node scripts/diag.js --out 诊断包.txt`
 *
 * 为什么要有这个脚本（而不只是界面上的按钮）：
 *   "另一台电脑上的 cfcoach 出问题了"最常见的两种形态是
 *     ① 界面能开、但某次抓题/某次对话不对 → 界面里点「导出诊断包」；
 *     ② **界面根本起不来**（配置错、端口占用、打包缺文件）→ 只能命令行。
 *   两条路必须产出同一份东西，所以两边都调 lib/diagbundle.js。
 *
 * 用法：
 *   node scripts/diag.js                       # 写到 <数据目录>/diag/cfcoach-diag-<时间>.txt
 *   node scripts/diag.js --out 诊断包.txt       # 写到指定文件
 *   node scripts/diag.js --print               # 直接打到标准输出（便于重定向/复制）
 *   node scripts/diag.js --data-dir D:\...\data # 指定数据目录（默认自动探测）
 *   node scripts/diag.js --ablation-out <跑分目录>  # 指定跑分目录（默认自动找 ablation/out/ui）
 *
 * 隐私：lib/diagbundle.js 会把 API key / cookie / 邮箱 / 系统用户名一律打码；
 * 本脚本只负责"选目录、写文件、打印清单"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const diag = require('../lib/diagbundle');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const a = { out: null, dataDir: null, userDataDir: null, ablationOut: null, print: false, quiet: false };
  const args = argv || process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const next = () => args[++i];
    if (k === '--out' || k === '-o') a.out = next();
    else if (k === '--data-dir') a.dataDir = next();
    else if (k === '--user-data-dir') a.userDataDir = next();
    else if (k === '--ablation-out') a.ablationOut = next();
    else if (k === '--print') a.print = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (!a.out && !k.startsWith('-')) a.out = k;
  }
  return a;
}

function usage() {
  return [
    'cf-coach 诊断包',
    '',
    '用法：node scripts/diag.js [--out 文件] [--print] [--data-dir 目录] [--ablation-out 目录]',
    '',
    '不带 --out 时写到 <数据目录>/diag/cfcoach-diag-<时间>.txt。',
    '内容包括：环境 / 模型配置（已脱敏）/ 日志 / 题面缓存台账 / 工作区验证状态 /',
    '          最近几个会话的尾部消息 / 跑分与消融记录。',
    '完整解题代码与完整题面正文不进包（回答只留前 600 字符、工具结果只留前 300 字符）；',
    'API key、cookie、邮箱、系统用户名都会打码，直接发出去即可（不放心也可以先自己扫一眼）。'
  ].join('\n');
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.help) { console.log(usage()); return 0; }

  const dataDir = a.dataDir ? path.resolve(a.dataDir) : diag.pickDataDir(ROOT);
  const opts = {
    dataDir,
    userDataDir: a.userDataDir || undefined,
    rootDir: ROOT,
    ablationOut: a.ablationOut || undefined,
    appVersion: (function () {
      try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return null; }
    })(),
    packed: false   // 命令行侧永远是"开发版"
  };

  if (a.print) {
    const r = diag.collect(opts);
    process.stdout.write(r.text);
    if (!a.quiet) process.stderr.write('\n[诊断包] ' + r.bytes + ' 字节，段落：' + r.sections.map((s) => s.name).join(' / ') + '\n');
    return 0;
  }

  const r = diag.write(Object.assign({}, opts, a.out ? { file: path.resolve(a.out) } : {}));
  if (!a.quiet) {
    const lines = [];
    lines.push('诊断包已生成');
    lines.push('  文件        ：' + r.file + '（' + diag.bytes(r.bytes) + '）');
    lines.push('  数据目录    ：' + (r.dataDir || '（没找到）'));
    lines.push('  用户数据目录：' + (diag.defaultUserDataDir() || '—'));
    lines.push('  段落        ：');
    for (const s of r.sections) lines.push('    - ' + s.name + '：' + s.chars + ' 字符' + (s.truncated ? '（已截断）' : ''));
    if (r.warnings.length) {
      lines.push('  提醒        ：');
      for (const w of r.warnings) lines.push('    ! ' + w);
    }
    lines.push('');
    lines.push('把这份 .txt 文件发出去即可：API key / cookie / 邮箱 / 系统用户名都已打码；');
    lines.push('完整解题代码与完整题面正文不在包里（只留回答与工具结果的片段）。发之前你也可以自己扫一眼。');
    console.log(lines.join('\n'));
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error('诊断包生成失败：' + ((e && e.stack) || e));
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, ROOT };
