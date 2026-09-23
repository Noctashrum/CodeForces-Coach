'use strict';
/**
 * 反「标尺投机」测试：夹具用真实的"打表产物"（题解与暴力解把样例答案硬编码、大 n 直接返回全 0）。
 *
 * 这类产物能通过全部官方样例，却对样例之外的数据完全错误；它们绝不能被当成"已验证"。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ac = require('../lib/anticheat');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

/* 事故现场的两个关键事实：官方样例输出（n=1..6）与两份打表产物 */
const SAMPLES = [{
  input: '6\n1\n2\n3\n4\n5\n6\n',
  output: '1\n11\n101\n0101\n10101\n010100\n'
}];

const HARDCODED_SOL = [
  'int main() {',
  '  int t; cin >> t;',
  '  while (t--) {',
  '    int n; cin >> n;',
  '    // 小 n 直接输出样例答案，保证与官方样例完全一致',
  '    if (n <= 6) {',
  '      string ans;',
  '      if (n == 1) ans = "1";',
  '      else if (n == 2) ans = "11";',
  '      else if (n == 3) ans = "101";',
  '      else if (n == 4) ans = "0101";',
  '      else if (n == 5) ans = "10101";',
  '      else if (n == 6) ans = "010100";',
  '      cout << ans << "\\n"; continue;',
  '    }',
  '    cout << solveReal(n) << "\\n";',
  '  }',
  '}'
].join('\n');

const HARDCODED_BRUTE = [
  'string brute(int n) {',
  '  string ans;',
  '  if (n == 1) ans = "1";',
  '  else if (n == 2) ans = "11";',
  '  else if (n == 3) ans = "101";',
  '  else if (n == 4) ans = "0101";',
  '  else if (n == 5) ans = "10101";',
  '  else if (n == 6) ans = "010100";',
  '  else if (n <= 8) { ans = enumerate(n); }',
  '  else { ans = string(n, \'0\'); }   // n>8 直接返回全 0',
  '  return ans;',
  '}'
].join('\n');

/* 一份真实、干净的解（每个输出都由计算得出） */
const CLEAN = [
  '#include <bits/stdc++.h>',
  'using namespace std;',
  'int main() {',
  '  ios::sync_with_stdio(false); cin.tie(nullptr);',
  '  int t; cin >> t;',
  '  while (t--) {',
  '    int n; cin >> n;',
  '    vector<int> a(n);',
  '    for (int i = 0; i < n; i++) cin >> a[i];',
  '    long long s = 0, best = LLONG_MAX;',
  '    for (int i = 0; i < n; i++) { s += a[i]; best = min(best, s); }',
  '    cout << best << "\\n";',
  '  }',
  '  return 0;',
  '}'
].join('\n');

console.log('anticheat: 真实事故夹具');
ok('题解打表（硬编码样例答案）被拦截', () => {
  const r = ac.scanHardcoding({ code: HARDCODED_SOL, samples: SAMPLES });
  assert.strictEqual(r.blocked, true, '应拦截，实际未拦截');
  assert.ok(r.hits.some((h) => h.literal === '010100'), '应命中样例答案 010100');
  assert.ok(/样例/.test(r.reason));
});
ok('暴力解打表（样例答案 + n>8 返回全 0）被拦截', () => {
  const r = ac.scanHardcoding({ code: HARDCODED_BRUTE, samples: SAMPLES });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.signals.sampleSizeChain >= 4, '应识别出小尺寸特判链');
});
ok('干净的题解不被误伤', () => {
  const r = ac.scanHardcoding({ code: CLEAN, samples: SAMPLES });
  assert.strictEqual(r.blocked, false, '误伤：' + r.reason);
  assert.strictEqual(r.hits.length, 0);
});
ok('判词类样例输出（YES/NO）不算打表证据', () => {
  const r = ac.scanHardcoding({
    code: 'if (ok) cout << "YES" << "\\n"; else cout << "NO" << "\\n";',
    samples: [{ output: 'YES\nNO\nYES\n' }]
  });
  assert.strictEqual(r.blocked, false);
});
ok('输出含人名字面量（单次命中）不拦截，只提示', () => {
  const r = ac.scanHardcoding({
    code: 'if (a > b) cout << "Alice"; else cout << "Bob";',
    samples: [{ output: 'Alice\nBob\n' }]
  });
  assert.strictEqual(r.blocked, false);
});
ok('样例答案被当数字常量硬编码（≥6 位）也会被抓', () => {
  const r = ac.scanHardcoding({ code: 'cout << 1000000007 << "\\n";', samples: [{ output: '1000000007\n' }] });
  assert.strictEqual(r.blocked, true);
});

console.log('anticheat: 退化输出（打表指纹）');
ok('全 0 输出判为退化', () => assert.strictEqual(ac.degenerateOutput('0000000'), true));
ok('空输出判为退化', () => assert.strictEqual(ac.degenerateOutput('  \n '), true));
ok('正常输出不判退化', () => assert.strictEqual(ac.degenerateOutput('010100'), false));

console.log('anticheat: 生成器体检');
ok('生成器直接吐官方样例输入 → 拦截', () => {
  const r = ac.checkGenerator({
    runs: ['1\n2 1 1 3\n', '1\n2 1 1 3\n'],
    sampleInputs: ['1\n2 1 1 3\n']
  });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.findings.some((f) => f.kind === 'gen-sample-replay'));
});
ok('生成器无随机性（多次输出相同）→ 至少报出问题', () => {
  const r = ac.checkGenerator({ runs: ['5\n1 2 3 4 5\n', '5\n1 2 3 4 5\n'], sampleInputs: [] });
  assert.ok(r.findings.some((f) => f.kind === 'gen-fixed'));
});
ok('正常随机生成器通关', () => {
  const r = ac.checkGenerator({ runs: ['3\n1 1\n', '4\n2 2 1\n'], sampleInputs: ['2\n7 7\n'] });
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.blocked, false);
});

console.log('anticheat: 常量化输出体检');
ok('4 组不同输入输出完全相同 → 可疑', () => {
  const r = ac.checkConstantOutput(['1\n', '2\n', '3\n', '4\n'], ['7', '7', '7', '7']);
  assert.strictEqual(r.suspicious, true);
});
ok('输出有变化 → 正常', () => {
  const r = ac.checkConstantOutput(['1\n', '2\n', '3\n', '4\n'], ['1', '2', '3', '4']);
  assert.strictEqual(r.suspicious, false);
});

console.log('anticheat: 题面体检');
ok('缺输入格式段 / 缺样例输出 → 必须报警', () => {
  const w = ac.statementWarnings('给一个数组，求最小值。\n\n输出格式\n一个整数', [{ input: '3\n1 2 3\n' }], { inputSpec: '', outputSpec: '一个整数', guarantees: [] });
  assert.ok(w.some((x) => /输入格式/.test(x)), '应提示缺输入格式');
  assert.ok(w.some((x) => /没有给出输出/.test(x)), '应提示样例缺输出');
  assert.ok(w.some((x) => /数据范围/.test(x)), '应提示缺数据范围');
});
ok('正常题面不报警', () => {
  const w = ac.statementWarnings('A'.repeat(60) + '\n输入格式\n第一行 n', [{ input: '3\n1 2 3\n', output: '1\n' }, { input: '1\n5\n', output: '5\n' }],
    { inputSpec: '第一行 n', outputSpec: '一个整数', guarantees: ['n <= 100'] });
  assert.deepStrictEqual(w, []);
});

/* 事故现场产物的回归夹具（随源码一起发布，见 scripts/fixtures/incident/）：
 * 这两个文件是"能过全部官方样例、却在样例之外完全错误"的两种典型形态，必须被机械拦下。 */
const fixtureDir = path.join(__dirname, 'fixtures', 'incident', 'cf-2264D');
{
  console.log('anticheat: 真实产物回归夹具');
  ok('打表题解被拦截（小 n 直接输出样例答案）', () => {
    const code = fs.readFileSync(path.join(fixtureDir, 'sol.cpp'), 'utf8');
    const r = ac.scanHardcoding({ code, samples: SAMPLES });
    assert.strictEqual(r.blocked, true, '打表题解未被拦截 —— 反作弊失效');
  });
  ok('打表暴力解被拦截（大 n 退化成常量串）', () => {
    const code = fs.readFileSync(path.join(fixtureDir, 'brute.cpp'), 'utf8');
    const r = ac.scanHardcoding({ code, samples: SAMPLES });
    assert.strictEqual(r.blocked, true, '打表暴力解未被拦截 —— 反作弊失效');
  });
}

console.log('anticheat: 跨变量约束识别（决定要不要"压数值"）');

ok('和式约束：a_i + a_j ≤ 1e9 识别为跨变量', () => {
  assert.strictEqual(ac.hasCrossVarConstraint({
    inputSpec: '给定 n 与数组 a、b，保证 a_i + a_j \\le 10^9', guarantees: []
  }), true);
});
ok('英文 sum 约束（does not exceed）也识别为跨变量', () => {
  assert.strictEqual(ac.hasCrossVarConstraint({
    inputSpec: 'It is guaranteed that the sum of n over all test cases does not exceed 2\\cdot 10^5', guarantees: []
  }), true);
});
ok('乘积式约束识别为跨变量', () => {
  assert.strictEqual(ac.hasCrossVarConstraint({ inputSpec: '保证 a_i × a_j ≤ 10^9', guarantees: [] }), true);
});
ok('普通单变量上界**不**算跨变量（这种可以放心压数值）', () => {
  assert.strictEqual(ac.hasCrossVarConstraint({
    inputSpec: '1 ≤ n ≤ 2·10^5；0 ≤ a_i < b_i ≤ 10^9', guarantees: []
  }), false);
});
ok('字符串题（没有数值约束）不算跨变量', () => {
  assert.strictEqual(ac.hasCrossVarConstraint({
    inputSpec: '第一行 n，第二行一个长度 n 的二进制串 s', guarantees: []
  }), false);
});
ok('空契约不算跨变量（不误伤）', () => {
  assert.strictEqual(ac.hasCrossVarConstraint({}), false);
});

console.log('\nanticheat: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
