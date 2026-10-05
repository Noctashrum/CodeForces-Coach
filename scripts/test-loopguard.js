'use strict';
/**
 * 死循环特征检测（lib/loopguard.js）的单测。
 *
 * 为什么需要这个模块：原来的止血手段是"掐表 + 掐次数"（12 步 / 20 分钟 / 3 轮），
 * 用户复盘指出两件事：① 那些数值是凭感觉硬写的；② **上限会教模型作弊**（预算一紧，
 * 最优策略就变成打表 / 交最笨的版本），正确的停手条件是"这一轮有没有新信息"。
 *
 * ⚠️ 第二版修正（用户 2026-10 当场指出）：「我提醒一下，你的连续N次没刷新的N可又是一个魔法数字」
 *    —— 第一版把 `minRepeat=2 / stallRounds=2` 写进守卫，只是把"猜一个够用的上限"从分钟数换成了
 *    轮数。所以这里钉死的第三件事是：**模块里不许有任何阈值**，判据只能是
 *      · 集合成员关系（这个产物/这条失败信息之前出现过没有）
 *      · 相邻相等（这一轮和紧邻的上一轮是不是同一个东西）
 *    并且健康的迭代（每轮都在换东西、失败信息在变）→ **绝不能**被误判成死循环。
 */
const assert = require('assert');
const lg = require('../lib/loopguard');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('loopguard: 死循环特征检测（无阈值）');

/* ---------- 1. 签名工具本身 ---------- */

ok('hashSig：同样输入同签名、不同输入不同签名（长度也参与，不吃 "ab" vs "ba" 的碰撞）', () => {
  assert.strictEqual(lg.hashSig('abc'), lg.hashSig('abc'));
  assert.notStrictEqual(lg.hashSig('abc'), lg.hashSig('abd'));
  assert.notStrictEqual(lg.hashSig('ab'), lg.hashSig('ba'));
  assert.strictEqual(lg.hashSig(null), lg.hashSig(''));
  assert.strictEqual(lg.hashSig(undefined), lg.hashSig(''));
});

ok('codeSig：只改缩进/空行/整行注释/换行符 → 签名不变（"假重写"必须被认出来）', () => {
  const a = 'int main(){\n    // 统计前缀和\n    int s = 0;\n\n    return s;\n}';
  const b = 'int main(){\r\nint s = 0;\r\nreturn s;\r\n}';
  assert.strictEqual(lg.codeSig(a), lg.codeSig(b));
  // #（python）/ *（块注释续行）/ -- 也要被当作整行注释丢掉
  assert.strictEqual(lg.codeSig('# 说明\nx = 1'), lg.codeSig('x = 1'));
  assert.strictEqual(lg.codeSig(' * 续行\nx = 1'), lg.codeSig('x = 1'));
  assert.strictEqual(lg.codeSig('-- 说明\nx = 1'), lg.codeSig('x = 1'));
  assert.strictEqual(lg.codeSig(null), lg.codeSig(''));
});

ok('codeSig：真实的代码改动必须换签名（不能把"改了逻辑"当重复）', () => {
  assert.notStrictEqual(lg.codeSig('int s = 0;'), lg.codeSig('int s = 1;'));
  assert.notStrictEqual(lg.codeSig('for (int i = 0; i < n; i++) {}'), lg.codeSig('for (int i = 1; i < n; i++) {}'));
  assert.notStrictEqual(lg.codeSig('x = 1'), lg.codeSig('x = 1\nprint(x)'));
});

ok('signature：数组/单值等价、顺序敏感、分隔符避免"拼接歧义"', () => {
  assert.strictEqual(lg.signature(['a']), lg.signature('a'));
  assert.strictEqual(lg.signature(['a', 'b']), lg.signature(['a', 'b']));
  assert.notStrictEqual(lg.signature(['a', 'b']), lg.signature(['b', 'a']));
  assert.notStrictEqual(lg.signature(['a', 'b']), lg.signature(['ab']));
  assert.strictEqual(lg.signature([null, undefined]), lg.signature(['', '']));
});

/* ---------- 2. 模块里不许有阈值（这是上一版踩过的坑，必须由测试守住） ---------- */

ok('无阈值：**代码里**不许再出现 minRepeat / stallRounds / maxMarks / score 这类参数名', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/loopguard.js'), 'utf8');
  // 注释里记录"上一版曾用 minRepeat/stallRounds"是允许的（历史教训要留着），但真代码里不许有
  const code = src.split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');
  ['minRepeat', 'stallRounds', 'maxMarks', 'score'].forEach((bad) => {
    assert.ok(code.indexOf(bad) < 0, 'loopguard.js 的代码里又出现了阈值式参数：' + bad);
  });
});

ok('无阈值：守卫不接受任何数字配置项（传进去也只是被忽略，行为不随数字变）', () => {
  const a = lg.createGuard({ label: 'x', minRepeat: 1, stallRounds: 1, maxMarks: 1 });
  const b = lg.createGuard({ label: 'x', minRepeat: 9, stallRounds: 9, maxMarks: 9 });
  const seq = [{ sig: 'A', evidence: 'e1' }, { sig: 'B', evidence: 'e2' }, { sig: 'A', evidence: 'e1' }];
  const trace = (g) => seq.map((r) => g.note(r).kind);
  const ta = trace(a);
  const tb = trace(b);
  assert.deepStrictEqual(ta, tb, '行为不能随数字配置项改变');
  assert.deepStrictEqual(ta, ['ok', 'ok', 'oscillate']);
});

/* ---------- 3. repeat / oscillate：同一个产物又交了一遍 ---------- */

ok('repeat：同一个签名第二次出现就停手，原因写清"同一个东西"', () => {
  const g = lg.createGuard({ label: '暴力解重写' });
  const first = g.note({ sig: 'sig-x', tag: 'WA/2' });
  assert.strictEqual(first.action, 'ok');
  assert.strictEqual(g.stopped, null);
  const second = g.note({ sig: 'sig-x', tag: 'WA/2' });
  assert.strictEqual(second.action, 'stop');
  assert.strictEqual(second.kind, 'repeat');
  assert.ok(second.reason.indexOf('暴力解重写') === 0, second.reason);
  assert.ok(second.reason.includes('一模一样'), second.reason);
  assert.ok(second.reason.includes('sig-x'), second.reason);
  assert.ok(g.stopped && g.stopped.kind === 'repeat');
});

ok('repeat：停手是幂等的（调用方可以放心反复查询/继续喂记录）', () => {
  const g = lg.createGuard({});
  g.note({ sig: 'a' });
  const stop1 = g.note({ sig: 'a' });
  const stop2 = g.note({ sig: 'b' });
  const stop3 = g.note({ sig: 'a' });
  assert.strictEqual(stop2, stop1);
  assert.strictEqual(stop3, stop1);
  assert.strictEqual(g.stopped, stop1);
});

ok('oscillate：A→B→A 判成"在两个版本之间来回震荡"（不是普通 repeat，原因要能看出来）', () => {
  const g = lg.createGuard({ label: '题解重写' });
  assert.strictEqual(g.note({ sig: 'A' }).action, 'ok');
  assert.strictEqual(g.note({ sig: 'B' }).action, 'ok');
  const third = g.note({ sig: 'A' });
  assert.strictEqual(third.action, 'stop');
  assert.strictEqual(third.kind, 'oscillate');
  assert.ok(third.reason.includes('来回震荡'), third.reason);
  assert.ok(third.reason.includes('A→B→A'), third.reason);
});

ok('oscillate：A→B→C→A（周期 3）同样认得出来，且不误报成震荡', () => {
  const g = lg.createGuard({});
  g.note({ sig: 'A' }); g.note({ sig: 'B' }); g.note({ sig: 'C' });
  const fourth = g.note({ sig: 'A' });
  assert.strictEqual(fourth.action, 'stop');
  assert.strictEqual(fourth.kind, 'repeat', '周期 3 不是"两个版本之间来回"，应算普通重复');
});

/* ---------- 4. no-new-info：换了代码但失败信息一条不差地重来 ---------- */

ok('no-new-info：代码每轮都不一样、但失败信息完全相同 → 第二次就停（不再掷骰子）', () => {
  const g = lg.createGuard({ label: '题解重写' });
  const mism = (tier) => lg.signature(['mismatch', '', String(tier)]);
  const r1 = g.note({ sig: lg.codeSig('print(1)'), evidence: mism(4), tag: 'mismatch/tier4' });
  const r2 = g.note({ sig: lg.codeSig('print(2)'), evidence: mism(4), tag: 'mismatch/tier4' });
  assert.strictEqual(r1.action, 'ok');
  assert.strictEqual(r2.action, 'stop');
  assert.strictEqual(r2.kind, 'no-new-info');
  assert.ok(r2.reason.includes('完全相同'), r2.reason);
  assert.ok(r2.reason.includes('没有带回任何新东西'), r2.reason);
});

ok('no-new-info：失败换了一档 / 换了一种死法就算新信息，必须继续放行', () => {
  const g = lg.createGuard({});
  const step = (tier, status) => g.note({
    sig: lg.codeSig('v' + tier + status),
    evidence: lg.signature([status, '', String(tier)]),
    tag: status + '/tier' + tier
  });
  assert.strictEqual(step(4, 'mismatch').action, 'ok');   // 起步：tier4 输出不一致
  assert.strictEqual(step(6, 'mismatch').action, 'ok');   // 修好了 tier4，爬到 tier6 —— 新信息
  assert.strictEqual(step(6, 'error').action, 'ok');      // 同档但换了死法（RE/TLE）—— 新信息
  assert.strictEqual(g.stopped, null);
});

ok('no-new-info：不给 evidence 时只看产物（老调用方式不受影响）', () => {
  const g = lg.createGuard({});
  for (let i = 0; i < 8; i++) assert.strictEqual(g.note({ sig: 'v' + i }).action, 'ok');
  assert.strictEqual(g.stopped, null);
});

/* ---------- 5. 健康迭代绝不能被误判 ---------- */

ok('健康迭代：每轮都换新产物 + 新失败信息 → 一直放行（多少轮都不停）', () => {
  const g = lg.createGuard({ label: '题解重写' });
  for (let i = 0; i < 12; i++) {
    const r = g.note({ sig: lg.codeSig('attempt ' + i), evidence: lg.signature(['mismatch', 'case' + i, '4']), tag: 'mismatch/tier4' });
    assert.strictEqual(r.action, 'ok', '第 ' + (i + 1) + ' 轮不该停：' + r.reason);
  }
  assert.strictEqual(g.stopped, null);
});

ok('健康迭代：分数在变好（样例 1/3 → 2/3 → 3/3 的等价证据变化）→ 不停手', () => {
  const g = lg.createGuard({});
  ['WA/TLE/TLE', 'AC/TLE/TLE', 'AC/AC/TLE', 'AC/AC/AC'].forEach((vec, i) => {
    const r = g.note({ sig: lg.codeSig('brute v' + i), evidence: lg.signature([vec]), tag: vec });
    assert.strictEqual(r.action, 'ok', vec + ' 是进展，不该停：' + r.reason);
  });
});

/* ---------- 6. 端到端：两个真实回路的形状 ---------- */

ok('真实形状①：题解每轮产出的代码都不同、但一直同一个失败 → 第二轮就停（就是那条"零变化"的路）', () => {
  const g = lg.createGuard({ label: '题解重写' });
  const ev = lg.signature(['mismatch', '', '4']);
  assert.strictEqual(g.note({ sig: lg.codeSig('print(1)'), evidence: ev }).action, 'ok');
  const second = g.note({ sig: lg.codeSig('print(2)'), evidence: ev });
  assert.strictEqual(second.action, 'stop');
  assert.strictEqual(second.kind, 'no-new-info');
  assert.ok(second.reason.startsWith('题解重写第 2 次'), second.reason);
});

ok('真实形状②：暴力解每次重写吐出同一份代码 → 第二次就停（不烧到 maxBruteFix 次数上限）', () => {
  const g = lg.createGuard({ label: '暴力解重写' });
  const same = 'for a in range(n):\n    for b in range(n):\n        pass';
  const vec = lg.signature(['WA/WA', '0:WA,1:WA']);
  assert.strictEqual(g.note({ sig: lg.codeSig(same), evidence: vec, tag: 'WA/WA' }).action, 'ok');
  const second = g.note({ sig: lg.codeSig(same + '\n// 改了个注释'), evidence: vec, tag: 'WA/WA' });
  assert.strictEqual(second.action, 'stop');
  assert.strictEqual(second.kind, 'repeat', '代码签名相同（注释不算改动）→ 走 repeat');
});

ok('marks：只用于写报告，按轮次记录，不截断（没有 maxMarks 这种魔法数字）', () => {
  const g = lg.createGuard({});
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'].forEach((s) => g.note({ sig: s, evidence: 'e' + s, tag: s }));
  const m = g.marks();
  assert.strictEqual(m.length, 7);
  assert.deepStrictEqual(m.map((x) => x.sig), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.strictEqual(m[0].tag, 'a');
  // 停手记录里带上当时的全部痕迹，便于写"为什么停"
  const g2 = lg.createGuard({ label: 'L' });
  g2.note({ sig: 'x' });
  const st = g2.note({ sig: 'x' });
  assert.strictEqual(st.marks.length, 2);
  assert.strictEqual(st.attempts, 2);
});

ok('labels：不同调用方的停手原因要能区分（暴力解重写 / 题解重写）', () => {
  const g = lg.createGuard({ label: '暴力解重写' });
  g.note({ sig: 'z' });
  assert.ok(g.note({ sig: 'z' }).reason.startsWith('暴力解重写第 2 次'));
});

console.log('loopguard: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
