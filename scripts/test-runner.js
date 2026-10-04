/**
 * test-runner.js — 本地运行器单元测试（不需要启动任何服务）
 * 覆盖：对拍通过 / 对拍发现不一致 / 编译错误 / 样例测试 / 超时
 */
'use strict';

const runner = require('../lib/runner');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}

const SOL_OK = `const fs = require('fs');
const d = fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);
let pos = 0; const t = d[pos++]; const out = [];
for (let c = 0; c < t; c++) {
  const n = d[pos++];
  const arr = d.slice(pos, pos + n); pos += n;
  let total = 0;
  arr.forEach(x => { total += x; });
  out.push(total);
}
console.log(out.join('\\n'));`;

const BRUTE_OK = `const fs = require('fs');
const d = fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);
let pos = 0; const t = d[pos++]; const out = [];
for (let c = 0; c < t; c++) {
  const n = d[pos++];
  const arr = d.slice(pos, pos + n); pos += n;
  let total = 0;
  for (const x of arr) total += x;
  out.push(total);
}
console.log(out.join('\\n'));`;

const SOL_WRONG = `const fs = require('fs');
const d = fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);
let pos = 0; const t = d[pos++]; const out = [];
for (let c = 0; c < t; c++) {
  const n = d[pos++];
  const arr = d.slice(pos, pos + n); pos += n;
  out.push(arr.length ? arr[0] : 0); // 错误：只返回第一个数
}
console.log(out.join('\\n'));`;

const GEN = `const n = 1 + Math.floor(Math.random() * 6);
const a = [];
for (let i = 0; i < n; i++) a.push(Math.floor(Math.random() * 20));
console.log('1\\n' + n + '\\n' + a.join(' '));`;

const SOL_TLE = `const fs = require('fs');
fs.readFileSync(0,'utf8');
while (true) { /* 死循环 */ }`;

const SOL_COMPILE_ERR = `int main() { return 0; }`; // 非法 JS（其实 js 下这是语法错误，会 RE）

async function main() {
  console.log('\n== 对拍：正解 vs 暴力（应通过） ==');
  const r1 = await runner.stressTest({
    solution: { lang: 'js', code: SOL_OK },
    brute: { lang: 'js', code: BRUTE_OK },
    gen: { lang: 'js', code: GEN },
    iterations: 40
  });
  check('对拍通过', r1.ok && r1.status === 'ok', r1);
  check('对拍组数', r1.iterations === 40, r1.iterations);

  console.log('\n== 对拍：错误正解（应发现不一致） ==');
  const r2 = await runner.stressTest({
    solution: { lang: 'js', code: SOL_WRONG },
    brute: { lang: 'js', code: BRUTE_OK },
    gen: { lang: 'js', code: GEN },
    iterations: 40
  });
  check('发现不一致', r2.ok && r2.status === 'mismatch', r2);
  check('返回出错样例', !!r2.input && r2.expected != null, r2.input);

  console.log('\n== 对拍：超时（应报 TLE） ==');
  const r3 = await runner.stressTest({
    solution: { lang: 'js', code: SOL_TLE },
    brute: { lang: 'js', code: BRUTE_OK },
    gen: { lang: 'js', code: GEN },
    iterations: 3,
    timeLimitMs: 800
  });
  check('正解超时被捕获', r3.ok && r3.status === 'error' && r3.which === 'solution', r3);

  console.log('\n== 样例测试 ==');
  const r4 = await runner.runSamples({
    lang: 'js',
    code: SOL_OK,
    samples: [
      { input: '1\n3\n1 2 3\n', output: '6\n' },
      { input: '1\n2\n7 8\n', output: '15\n' }
    ]
  });
  check('样例全部 AC', r4.ok && r4.allPass, r4);
  const r5 = await runner.runSamples({
    lang: 'js', code: SOL_WRONG,
    samples: [{ input: '1\n3\n1 2 3\n', output: '6\n' }]
  });
  check('样例检测 WA', r5.ok && !r5.allPass && r5.results[0].verdict === 'WA', r5);

  console.log('\n== 超时参数归一化（假 TLE 事故的回归） ==');
  check('normTimeLimit(0) 用内置默认值（不是 0 毫秒）', runner.normTimeLimit(0) === runner.RUN_TIMEOUT_MS, runner.normTimeLimit(0));
  check('normTimeLimit(undefined/NaN/负数) 同样回落', runner.normTimeLimit(undefined) === runner.RUN_TIMEOUT_MS
    && runner.normTimeLimit(NaN) === runner.RUN_TIMEOUT_MS && runner.normTimeLimit(-5) === runner.RUN_TIMEOUT_MS);
  check('normTimeLimit(800) 原样保留', runner.normTimeLimit(800) === 800);
  // 这条是"130ms 判 TLE"的直接回归：0 毫秒跑一个正常程序，必须 AC 而不是 TLE
  const rZ = await runner.runSamples({ lang: 'js', code: SOL_OK, samples: [{ input: '1\n3\n1 2 3\n', output: '6\n' }], timeLimitMs: 0 });
  check('timeLimitMs=0 不再制造假 TLE', rZ.ok && rZ.allPass && rZ.results[0].verdict === 'AC', rZ.results && rZ.results[0]);

  console.log('\n== 语言按本机事实选择（无 g++ 机器的回归） ==');
  check('没注入探测结果 → 一律当可用（保持老行为）',
    runner.pickLang('cpp', null).lang === 'cpp' && runner.pickLang('cpp', null).unavailable === false);
  check('请求可用语言 → 不改动',
    runner.pickLang('python', { cpp: false, python: true, js: true }).lang === 'python'
      && runner.pickLang('python', { cpp: false, python: true, js: true }).changed === false);
  const pk = runner.pickLang('cpp', { cpp: false, python: true, js: true });
  check('无 g++ 时退到 python 并标记 changed', pk.lang === 'python' && pk.changed === true && pk.requested === 'cpp', pk);
  const pk2 = runner.pickLang('cpp', { cpp: false, python: false, js: false });
  check('一个运行时都没有 → unavailable（绝不假装跑过）', pk2.unavailable === true, pk2);
  check('只有 Node 时退到 js', runner.pickLang('cpp', { cpp: false, python: false, js: true }).lang === 'js');

  console.log('\n== C++ 编译运行 ==');
  const runtimes = await runner.availableRuntimes();
  console.log('  运行环境:', JSON.stringify(runtimes));
  if (runtimes.cpp) {
    const CPP_SOL = `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long n, s = 0; while (cin >> n) { vector<int> a(n); for (auto &x : a) { cin >> x; s += x; } cout << s << "\\n"; s = 0; } return 0; }`;
    const r6 = await runner.runSamples({ lang: 'cpp', code: CPP_SOL, samples: [{ input: '2\n1 2\n', output: '3\n' }] });
    check('C++ 样例 AC', r6.ok && r6.allPass, r6);
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
