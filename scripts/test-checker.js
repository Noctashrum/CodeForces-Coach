'use strict';
/**
 * scripts/test-checker.js —— 产品侧 checker（`lib/checker.js`）的单测
 *
 * 为什么需要它：多解题（题面允许"输出任意合法答案"）以前只有一条路——停下并标成
 * `multi-answer`（"本地判不了"）。现在要给它们一把**有背书的尺子**（本地 checker），
 * 而"有背书"的操作定义就是这里的断言：**checker 必须先把官方样例的答案判成 AC**，
 * 否则不采信（回落到原来的"判不了"）。
 *
 * 覆盖：查找顺序 / 编译（.cpp，有 g++ 才跑）/ 退出码约定（0=AC、1=WA、2=PE、其它含 3=FAIL=没结论）/
 *       超时与跑挂都不许算 WA / 自检（含"没有样例就不信"）/ `judgeSol` 的三态 /
 *       与 `lib/workspace.js` 的配合（checker 放子目录 ⇒ `clearScratch()` 清不掉它）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ck = require('../lib/checker');
const ws = require('../lib/workspace');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); return; }
  fail++;
  process.exitCode = 1;
  console.error('  \u2717 ' + name + (extra ? '\n      ' + String(extra).slice(0, 400) : ''));
}
async function okAsync(name, fn) {
  try { const v = await fn(); pass++; console.log('  \u2713 ' + name); return v; }
  catch (e) { fail++; process.exitCode = 1; console.error('  \u2717 ' + name + '\n      ' + String((e && e.message) || e).slice(0, 400)); return null; }
}

/* ---------------- 夹具：几种 checker ---------------- */

/** 正常 checker：题面 = "打印 1..n 的任意排列"；只看候选输出是不是一个合法排列 */
const PERM_PY = [
  'import sys',
  'def main():',
  '    a = sys.argv[1:]',
  '    inp = open(a[0], encoding="utf-8", errors="replace").read().split()',
  '    out = open(a[1], encoding="utf-8", errors="replace").read().split()',
  '    n = int(inp[0])',
  '    if len(out) != n:',
  '        print("expected %d numbers, got %d" % (n, len(out)))',
  '        return 1',
  '    if sorted(int(x) for x in out) != list(range(1, n + 1)):',
  '        print("not a permutation of 1..%d" % n)',
  '        return 1',
  '    return 0',
  'sys.exit(main())',
  ''
].join('\n');

/** 永远判 WA 的坏 checker（自检必须把它拦下） */
const ALWAYS_WA_PY = 'import sys\nprint("nope")\nsys.exit(1)\n';
/** 退出码 2（PE） */
const PE_PY = 'import sys\nsys.exit(2)\n';
/** 退出码 3（testlib FAIL：checker 自己没给出结论，典型场景是 jury 不是最优） */
const UNDECIDED_PY = 'import sys\nprint("FAIL: jury output is too short (test 4)")\nsys.exit(3)\n';
/** 卡死不退（必须被判成"超时"，绝不能算候选 WA） */
const HANG_PY = 'import time\nprint("starting", flush=True)\ntime.sleep(30)\n';

const PERM_CPP = [
  '#include <bits/stdc++.h>',
  'int main(int argc, char** argv) {',
  '  if (argc < 3) return 3;',
  '  std::ifstream fi(argv[1]); std::ifstream fo(argv[2]);',
  '  int n = 0; fi >> n;',
  '  std::vector<int> v; int x = 0;',
  '  while (fo >> x) v.push_back(x);',
  '  if ((int)v.size() != n) { std::cout << "expected " << n << " numbers\\n"; return 1; }',
  '  std::vector<int> s = v; std::sort(s.begin(), s.end());',
  '  for (int i = 0; i < n; i++) if (s[i] != i + 1) { std::cout << "not a permutation\\n"; return 1; }',
  '  return 0;',
  '}',
  ''
].join('\n');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfcoach-checker-test-'));
function writeFixture(rel, text) {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}
const samples = [
  { input: '3\n', output: '1 2 3\n' },
  { input: '4\n', output: '4 3 2 1\n' }   // 多解题：官方样例也只是其中一个合法答案
];

(async function main() {
  console.log('checker: 多解题的本地判据（查找 / 编译 / 退出码 / 自检）');

  /* ---------- 1. 查找 ---------- */
  const dirA = path.join(tmpRoot, 'ws-a');
  writeFixture('ws-a/checker/checker.py', PERM_PY);
  const rA = ck.resolve(dirA, '2451A');
  ok('resolve：认出 <工作区>/checker/checker.py', !!rA && rA.lang === 'python' && rA.source === 'workspace-checker',
    JSON.stringify(rA));
  ok('resolve：空目录返回 null', ck.resolve(path.join(tmpRoot, 'ws-empty'), '2451A') === null);
  writeFixture('ws-empty/.keep', '');

  const dirB = path.join(tmpRoot, 'ws-b');
  writeFixture('ws-b/checker/2451B.cpp', PERM_CPP);
  const rB = ck.resolve(dirB, '2451B');
  ok('resolve：认 <题号>.cpp（lang=cpp）', !!rB && rB.lang === 'cpp' && /2451B\.cpp$/.test(rB.file), JSON.stringify(rB));
  writeFixture('ws-b/checker/2451B.py', '');   // 0 字节：不许被当成可用 checker
  const rB2 = ck.resolve(dirB, '2451B');
  ok('resolve：跳过 0 字节的文件', !!rB2 && rB2.lang === 'cpp', JSON.stringify(rB2));

  const dirC = path.join(tmpRoot, 'ws-c');
  writeFixture('ws-c/checker.py', PERM_PY);
  const rC = ck.resolve(dirC, '2451C');
  ok('resolve：也认工作区顶层的 checker.py', !!rC && rC.source === 'workspace', JSON.stringify(rC));

  /* ---------- 2. 编译 ---------- */
  const builtPy = await okAsync('build：python 直接用（不编译）', async () => {
    const b = await ck.build(rA);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.exe, rA.file);
    return b;
  });

  const hasGpp = spawnSync('g++', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  if (hasGpp) {
    await okAsync('build：.cpp 编译成功并缓存（第二次 cached=true）', async () => {
      const b1 = await ck.build(rB);
      assert.strictEqual(b1.ok, true, b1.error);
      assert.ok(fs.existsSync(b1.exe));
      const b2 = await ck.build(rB);
      assert.strictEqual(b2.cached, true);
      return b2;
    });
    await okAsync('build + runOnce：编译出来的 .exe 能真判', async () => {
      const b = await ck.build(rB);
      const r = await ck.runOnce(b, { input: '3\n', participant: '3 1 2\n', jury: '3 1 2\n' });
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.ac, true, JSON.stringify(r));
      return r;
    });
  } else {
    console.log('  \u2013 跳过 .cpp 编译两条（本机没有 g++）');
  }
  const badBuild = await ck.build({ file: path.join(tmpRoot, 'nope.cpp'), lang: 'cpp', mtimeMs: 0 });
  ok('build：源码不存在时给出可读的编译失败信息（而不是抛异常）', badBuild.ok === false && /编译失败|起不来/.test(badBuild.error),
    JSON.stringify(badBuild));

  /* ---------- 3. 退出码约定 ---------- */
  await okAsync('runOnce：合法但文本不同的答案 → AC（多解题的关键）', async () => {
    const r = await ck.runOnce(builtPy, { input: '4\n', participant: '2 4 3 1\n', jury: '1 2 3 4\n' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.ac, true, JSON.stringify(r));
    assert.strictEqual(r.exit, 0);
    return r;
  });
  await okAsync('runOnce：不合法答案 → WA（带判词）', async () => {
    const r = await ck.runOnce(builtPy, { input: '3\n', participant: '1 1 2\n', jury: '1 2 3\n' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.ac, false);
    assert.strictEqual(r.verdict, 'WA');
    assert.ok(/not a permutation/.test(r.detail), r.detail);
    return r;
  });
  const peBuilt = await ck.build({ file: writeFixture('ws-pe/checker.py', PE_PY), lang: 'python' });
  await okAsync('runOnce：exit 2 → PE（也是"候选不合法"，但不是 WA）', async () => {
    const r = await ck.runOnce(peBuilt, { input: '1\n', participant: 'x\n', jury: 'x\n' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.verdict, 'PE');
    return r;
  });
  const unBuilt = await ck.build({ file: writeFixture('ws-un/checker.py', UNDECIDED_PY), lang: 'python' });
  const un = await ck.runOnce(unBuilt, { input: '1\n', participant: 'x\n', jury: 'x\n' });
  ok('runOnce：exit 3（testlib FAIL）→ 不是 WA，而是"checker 没给出结论"',
    un.ok === false && /没给出可用结论/.test(un.error) && un.verdict === undefined, JSON.stringify(un));
  const hangBuilt = await ck.build({ file: writeFixture('ws-hang/checker.py', HANG_PY), lang: 'python' });
  const hg = await ck.runOnce(hangBuilt, { input: '1\n', participant: 'x\n', jury: 'x\n' }, 1200);
  ok('runOnce：卡死的 checker → 超时，不许算候选 WA',
    hg.ok === false && /超时|信号/.test(hg.error) && hg.ac === undefined, JSON.stringify(hg));
  const miss = await ck.runOnce({ ok: true, exe: path.join(tmpRoot, 'no-such-checker.py') }, { input: '', participant: '', jury: '' });
  ok('runOnce：checker 文件不存在 → 直接报清楚（不花一次 spawn、不抛异常）',
    miss.ok === false && /不存在/.test(miss.error), JSON.stringify(miss));

  /* ---------- 4. 自检（判据的判据） ---------- */
  await okAsync('selfTest：官方样例的答案必须被判 AC → trusted', async () => {
    const t = await ck.selfTest(builtPy, samples);
    assert.strictEqual(t.trusted, true, JSON.stringify(t));
    assert.strictEqual(t.tested, 2);
    return t;
  });
  await okAsync('selfTest：永远判 WA 的 checker → 不可信（并列出矛盾证据）', async () => {
    const waBuilt = await ck.build({ file: writeFixture('ws-wa/checker.py', ALWAYS_WA_PY), lang: 'python' });
    const t = await ck.selfTest(waBuilt, samples);
    assert.strictEqual(t.trusted, false);
    assert.ok(t.failures && t.failures.length === 2, JSON.stringify(t));
    assert.ok(/官方答案判成 WA/.test(t.failures[0].why), t.failures[0].why);
    return t;
  });
  await okAsync('selfTest：没有官方样例 → 产品侧按不可信处理（严格不花代价）', async () => {
    const t = await ck.selfTest(builtPy, []);
    assert.strictEqual(t.trusted, false);
    assert.ok(/官方样例/.test(t.note || ''), JSON.stringify(t));
    return t;
  });

  /* ---------- 5. judgeSol 的三态 ---------- */
  await okAsync('judgeSol：两边都合法（只是答案不同）→ legal=true，不构成题解错的证据', async () => {
    const j = await ck.judgeSol(builtPy, { input: '4\n', participant: '4 3 2 1\n', jury: '1 2 3 4\n' });
    assert.strictEqual(j.ok, true, j.error);
    assert.strictEqual(j.legal, true, JSON.stringify(j));
    return j;
  });
  await okAsync('judgeSol：题解输出不合法 → legal=false + WA 判词（交给仲裁/修题解）', async () => {
    const j = await ck.judgeSol(builtPy, { input: '3\n', participant: '1 1 3\n', jury: '1 2 3\n' });
    assert.strictEqual(j.ok, true, j.error);
    assert.strictEqual(j.legal, false);
    assert.strictEqual(j.verdict, 'WA');
    return j;
  });
  await okAsync('judgeSol：checker 没结论（exit 3）→ ok=false，调用方必须回落"判不了"', async () => {
    const j = await ck.judgeSol(unBuilt, { input: '1\n', participant: 'x\n', jury: 'y\n' });
    assert.strictEqual(j.ok, false);
    assert.ok(/没给出可用结论/.test(j.error), j.error);
    return j;
  });

  /* ---------- 6. prepare 一次到位 ---------- */
  await okAsync('prepare：查找 → 编译 → 自检 一次完成（trusted=true）', async () => {
    const p = await ck.prepare(dirA, '2451A', samples);
    assert.strictEqual(p.ok, true, p.error);
    assert.strictEqual(p.trusted, true, JSON.stringify(p.test));
    return p;
  });

  /* ---------- 7. 与工作区的配合：子目录里的 checker 不会被 clearScratch 清掉 ---------- */
  await okAsync('workspace：checker/ 子目录能在 clearScratch 之后活下来（一份 checker 只花一次调用）', async () => {
    const dataDir = path.join(tmpRoot, 'appdata');
    ws.setRoot(dataDir);
    const key = 'cf-2451Z';
    ws.writeFile(key, 'sol.py', 'print(1)\n');
    ws.writeFile(key, 'fail.txt', '1\n');
    const dir = ws.convDir(key);
    fs.mkdirSync(path.join(dir, 'checker'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'checker', 'checker.py'), PERM_PY, 'utf8');
    ws.clearScratch(key);
    assert.strictEqual(fs.existsSync(path.join(dir, 'fail.txt')), false, '临时文件应该被清掉');
    assert.strictEqual(fs.existsSync(path.join(dir, 'sol.py')), true, '题解必须保留');
    assert.ok(ck.resolve(dir, '2451Z'), '子目录里的 checker 必须还在');
    return null;
  });

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }

  console.log('\nchecker: ' + pass + ' 项通过' + (fail ? ' / ' + fail + ' 项失败' : ' / 0 失败'));
  if (fail) process.exitCode = 1;
})();
