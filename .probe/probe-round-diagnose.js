'use strict';
/**
 * probe-round-diagnose.js — 逐份产物地诊断一轮：题面 / 样例 / sol / brute / gen 到底谁错了
 * 用法：node .probe/probe-round-diagnose.js [数据目录] [会话ID] [规模]
 *
 * 全部只读（不改你的数据），用的是应用自己的竞技场（编译 + 运行 + 对拍）：
 *   ① 题面的输入/输出格式段 + 官方样例（先确认样例本身解析对不对）；
 *   ② sol / brute 各自跑官方样例 → 谁过谁不过；
 *   ③ gen 造一组数据 → 打印它（看格式是否符合题面），再让 sol/brute 各跑一遍；
 *   ④ 回放工作区里记下的反例；
 *   ⑤ 打印三份源码，便于人工判断是谁的锅。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data');
const CONV_ID = process.argv[3] || '';
const SIZE = parseInt(process.argv[4] || '8', 10);
const runner = require(path.join(ROOT, 'lib', 'runner.js'));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
  return String(c || '');
}
function listConvs() {
  const dirs = [path.join(DATA, 'conversations'), path.join(DATA, 'archive')];
  const out = [];
  dirs.forEach((d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).filter((f) => f.endsWith('.json')).forEach((f) => {
      const j = readJson(path.join(d, f));
      if (j) out.push(j);
    });
  });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

(async () => {
  const convs = listConvs();
  const conv = CONV_ID ? convs.find((c) => c.id === CONV_ID) : convs[0];
  if (!conv) { console.error('找不到会话'); process.exit(1); }
  const key = (conv.cfProblem && conv.cfProblem.contestId)
    ? 'cf-' + conv.cfProblem.contestId + String(conv.cfProblem.index).toUpperCase() : conv.id;
  const wsDir = path.join(DATA, 'workspace', key);
  const meta = readJson(path.join(wsDir, 'meta.json')) || {};
  const rd = (n) => (fs.existsSync(path.join(wsDir, n)) ? fs.readFileSync(path.join(wsDir, n), 'utf8') : '');
  const sol = rd('sol.cpp') || rd('sol.py');
  const brute = rd('brute.cpp') || rd('brute.py');
  const gen = rd('gen.py');
  const userMsg = textOf((conv.messages.find((m) => m.role === 'user') || {}).content);

  console.log('会话 ' + conv.id + ' · 工作区 ' + key + ' · 题面 ' + userMsg.length + ' 字 · 来源 '
    + (conv.cfProblem ? 'CF 取题' : '粘贴题面'));
  console.log('验证记录: ' + JSON.stringify({
    status: (meta.verification || {}).status, reason: (meta.verification || {}).reason,
    iterations: (meta.verification || {}).iterations, bruteFrozen: (meta.verification || {}).bruteFrozen,
    solRewrites: (meta.verification || {}).solRewrites, samples: (meta.verification || {}).samples,
    samplesSource: (meta.verification || {}).samplesSource
  }));
  console.log('轨迹: ' + (meta.trajectory || []).map((t) => t.kind).join(' → '));
  (meta.trajectory || []).forEach((t) => console.log('  · [' + t.kind + '] ' + String(t.note || '').slice(0, 200)));

  const seg = (name, next) => {
    const i = userMsg.indexOf(name);
    if (i < 0) return '';
    const j = next ? userMsg.indexOf(next, i + name.length) : -1;
    return userMsg.slice(i, j > 0 ? j : i + 700);
  };
  console.log('\n==== 题面：输入格式 ====\n' + (seg('输入格式', '输出格式') || '（题面里没有「输入格式」段）'));
  console.log('\n==== 题面：输出格式 ====\n' + (seg('输出格式', '样例') || '（题面里没有「输出格式」段）'));

  const samples = (conv.cfProblemSamples || []).length ? conv.cfProblemSamples : (meta.samples || []);
  console.log('\n==== 官方样例（' + samples.length + ' 组） ====');
  samples.forEach((s, i) => {
    console.log('样例 ' + (i + 1) + ' 输入: ' + JSON.stringify(String(s.input || '')).slice(0, 240));
    console.log('样例 ' + (i + 1) + ' 输出: ' + JSON.stringify(String(s.output || '')).slice(0, 160));
  });

  const arena = await runner.openArena({
    sol: { lang: 'cpp', code: sol },
    brute: { lang: 'cpp', code: brute },
    gen: { lang: 'python', code: gen }
  });
  if (!arena.ok) { console.error('\n竞技场打不开: ' + arena.error); process.exit(1); }
  try {
    if (samples.length) {
      console.log('\n==== 官方样例上分别跑 ====');
      for (const who of ['sol', 'brute']) {
        const rs = await arena.runSamples(who, samples);
        const r = (rs.results || [])[0] || {};
        console.log(who + ': ' + r.verdict + ' 输出=' + JSON.stringify(String(r.actual || '').trim().slice(0, 160))
          + (r.verdict === 'AC' ? ' ✅' : ' ❌ ' + String(r.err || '').slice(0, 140)));
      }
    }
    console.log('\n==== 生成器（规模 ' + SIZE + '） ====');
    const g = await arena.genCase(SIZE, 20000);
    console.log(g.ok ? ('输出（' + String(g.input || '').length + ' 字）:\n' + String(g.input || '').slice(0, 500))
      : ('❌ 生成器失败: ' + g.err));
    if (g.ok) {
      const cmp = await arena.compare(g.input, 'sol', 'brute');
      console.log('题解: ' + (cmp.a.ok ? JSON.stringify(String(cmp.a.output).trim().slice(0, 200)) : 'ERR ' + cmp.a.err + (cmp.a.timedOut ? '（超时）' : ''))
        + '  [' + cmp.a.timeMs + 'ms]');
      console.log('暴力: ' + (cmp.b.ok ? JSON.stringify(String(cmp.b.output).trim().slice(0, 200)) : 'ERR ' + cmp.b.err + (cmp.b.timedOut ? '（超时）' : ''))
        + '  [' + cmp.b.timeMs + 'ms]');
      console.log('一致? ' + (cmp.same ? '✅ 一致' : '❌ 不一致'));
    }
    const fc = (meta.minimalCase && meta.minimalCase.input) || meta.failCase || '';
    if (fc) {
      console.log('\n==== 反例回放 ====');
      console.log('输入: ' + JSON.stringify(String(fc)).slice(0, 400));
      const cmp = await arena.compare(fc, 'sol', 'brute');
      console.log('题解 → ' + (cmp.a.ok ? JSON.stringify(String(cmp.a.output).trim().slice(0, 200)) : 'ERR ' + cmp.a.err + (cmp.a.timedOut ? '（超时）' : '')));
      console.log('暴力 → ' + (cmp.b.ok ? JSON.stringify(String(cmp.b.output).trim().slice(0, 200)) : 'ERR ' + cmp.b.err + (cmp.b.timedOut ? '（超时）' : '')));
      if (meta.minimalCase) console.log('记录里 from=' + meta.minimalCase.from + ' expected=' + JSON.stringify(String(meta.minimalCase.expected || '')).slice(0, 120));
      // 反例是否合法？规模检查
      console.log('反例第一行长这样: ' + JSON.stringify(String(fc).split(/\r?\n/)[0]));
    }
  } finally {
    arena.close();
  }

  console.log('\n==== 生成器源码 ====\n' + gen.slice(0, 1500));
  console.log('\n==== 暴力解源码 ====\n' + brute.slice(0, 2500));
  console.log('\n==== 题解源码 ====\n' + sol.slice(0, 2500));
})().catch((e) => { console.error('诊断异常: ' + ((e && e.stack) || e)); process.exit(1); });
