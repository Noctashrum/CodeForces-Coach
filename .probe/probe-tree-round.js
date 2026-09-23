'use strict';
/**
 * probe-tree-round.js — 用**独立写的**暴力解 + 小数值生成器，交叉验证那轮 G 题的题解到底对不对
 * 用法：node .probe/probe-tree-round.js [数据目录] [会话ID]
 *
 * 结果判定：
 *   · 题解与独立暴力解在大量小数值随机数据上全部一致 → 题解是对的，那轮失败是"坏标尺"
 *   · 出现不一致 → 打印反例（这就是题解的真实 bug）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const CONV_ID = process.argv[3] || 'c_mucjghqi48eb44';
const runner = require(path.join(ROOT, 'lib', 'runner.js'));

(async () => {
  const wsDir = path.join(DATA, 'workspace', CONV_ID);
  const sol = fs.readFileSync(path.join(wsDir, 'sol.cpp'), 'utf8');
  const myBrute = fs.readFileSync(path.join(__dirname, 'tree-brute.cpp'), 'utf8');
  const myGen = fs.readFileSync(path.join(__dirname, 'tree-gen.py'), 'utf8');

  const arena = await runner.openArena({
    sol: { lang: 'cpp', code: sol },
    ref: { lang: 'cpp', code: myBrute },
    gen: { lang: 'python', code: myGen }
  });
  if (!arena.ok) { console.error('竞技场打不开: ' + arena.error); process.exit(1); }

  const samples = [{ input: '8\n1\n3\n7\n2\n0 3\n5 4\n1 2\n3\n0 2 3\n7 3 4\n1 2\n2 3\n3\n0 0 1\n5 2 2\n1 2\n2 3\n4\n1 2 3 4\n10 3 4 5\n1 2\n1 3\n1 4\n3\n0 1 3\n10 2 4\n1 2\n1 3\n5\n0 0 1 2 3\n12 6 9 3 4\n1 2\n1 3\n2 4\n3 5\n4\n0 999999999 999999999 999999999\n1000000000 1000000000 1000000000 1000000000\n1 2\n1 3\n1 4', output: '3\n7\n11\n6\n18\n12\n27\n3999999996' }];

  try {
    const rs = await arena.runSamples('sol', samples);
    console.log('题解 vs 官方样例: ' + rs.results.map((r) => r.verdict).join('/')
      + (rs.allPass ? ' ✅' : ' ❌ 实际输出 ' + JSON.stringify(rs.results[0].actual)));

    const configs = [
      { n: 4, v: 6, rounds: 120, tag: 'n≤4, 数值≤6' },
      { n: 6, v: 4, rounds: 80, tag: 'n≤6, 数值≤4' },
      { n: 3, v: 20, rounds: 60, tag: 'n≤3, 数值≤20' }
    ];
    for (const cfg of configs) {
      let bad = 0;
      let first = null;
      for (let i = 0; i < cfg.rounds; i++) {
        const g = await arena.genCase(cfg.n, 20000, cfg.v);
        if (!g.ok || !g.input.trim()) { console.log('  （生成器没出数据，跳过）'); break; }
        const cmp = await arena.compare(g.input, 'sol', 'ref');
        if (!cmp.same) {
          bad++;
          if (!first) first = { input: g.input, sol: cmp.a.output, ref: cmp.b.output };
        }
      }
      console.log('【' + cfg.tag + '】' + cfg.rounds + ' 组随机数据：'
        + (bad === 0 ? '题解与独立暴力解**全部一致** ✅' : bad + ' 组不一致 ❌'));
      if (first) {
        console.log('  反例输入:\n' + first.input);
        console.log('  题解输出: ' + JSON.stringify(String(first.sol).trim()));
        console.log('  独立暴力: ' + JSON.stringify(String(first.ref).trim()));
      }
    }

    // 大规模数据只检查"不崩、不超时"（大数值下没有可信暴力解可比，这与应用里的处理一致）
    const big = [
      '1', '200000',
      Array.from({ length: 200000 }, (_, i) => i % 1000000000).join(' '),
      Array.from({ length: 200000 }, () => 1000000000).join(' '),
      ...Array.from({ length: 199999 }, (_, i) => (i + 2) + ' ' + Math.max(1, Math.floor((i + 2) / 2)))
    ].join('\n');
    const rb = await arena.run('sol', big, 15000);
    console.log('大规模（n=2·10^5）冒烟: ' + (rb.ok ? 'ok ' + rb.timeMs + 'ms' : (rb.timedOut ? '超时' : 'ERR ' + rb.err)));
  } finally {
    arena.close();
  }
})().catch((e) => { console.error('异常: ' + ((e && e.stack) || e)); process.exit(1); });
