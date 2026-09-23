'use strict';
/**
 * Agent 工作台事件归属测试（public/js/agentruns.js）。
 *
 * 为什么必须测：题解 / 暴力 / 生成器是**并发**跑的，谁先结束不确定。
 * 曾经的实现按"最后一个还在跑的条目"匹配事件 —— 并发下 A 的结束会被算到 B 头上，
 * 界面上就表现为"两个 Agent 显示 0 秒完成、其实还在等另一个"，看起来像并行没生效。
 */
const assert = require('assert');
const AR = require('../public/js/agentruns');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const ev = (type, role, extra) => Object.assign({ type, role, label: role }, extra || {});

console.log('agentruns: 并发下的事件归属');

ok('三个 Agent 同时开跑：都保持"进行中"（不能互相关掉）', () => {
  const list = [];
  AR.start(list, ev('agentStart', 'solution'));
  AR.start(list, ev('agentStart', 'brute'));
  AR.start(list, ev('agentStart', 'gen'));
  assert.strictEqual(list.length, 3);
  assert.strictEqual(list.filter((r) => r.open).length, 3, JSON.stringify(list.map((r) => [r.role, r.open])));
});

ok('最快结束的那个（gen）只关掉自己', () => {
  const list = [];
  ['solution', 'brute', 'gen'].forEach((r) => AR.start(list, ev('agentStart', r)));
  AR.end(list, ev('agentEnd', 'gen', { ms: 900, ok: true }));
  const by = {};
  list.forEach((r) => { by[r.role] = r; });
  assert.strictEqual(by.gen.open, false);
  assert.strictEqual(by.gen.ms, 900);
  assert.strictEqual(by.solution.open, true);
  assert.strictEqual(by.brute.open, true);
});

ok('中间结束的那个（brute）也只关掉自己（这是"0 秒完成"事故的核心）', () => {
  const list = [];
  ['solution', 'brute', 'gen'].forEach((r) => AR.start(list, ev('agentStart', r)));
  AR.end(list, ev('agentEnd', 'brute', { ms: 1800, ok: true }));
  const by = {};
  list.forEach((r) => { by[r.role] = r; });
  assert.strictEqual(by.brute.ms, 1800);
  assert.strictEqual(by.brute.open, false);
  assert.strictEqual(by.gen.open, true, 'gen 不该被 brute 的结束牵连');
  assert.strictEqual(by.solution.open, true, 'solution 不该被 brute 的结束牵连');
});

ok('并发时的增量各归其主（不会全部堆到最后一条上）', () => {
  const list = [];
  ['solution', 'brute', 'gen'].forEach((r) => AR.start(list, ev('agentStart', r)));
  AR.append(list, ev('agentDelta', 'gen', { text: 'gen 的输出' }));
  AR.append(list, ev('agentReasoning', 'solution', { text: 'solution 的思考' }));
  const by = {};
  list.forEach((r) => { by[r.role] = r; });
  assert.strictEqual(by.gen.text, 'gen 的输出');
  assert.strictEqual(by.solution.reasoning, 'solution 的思考');
  assert.strictEqual(by.brute.text, '', 'brute 不该收到别人的输出');
  assert.strictEqual(by.solution.text, '', 'solution 不该收到别人的输出');
});

ok('同一角色重跑（修题解 / 反打表重写）会新开一条，旧的那条被关掉', () => {
  const list = [];
  AR.start(list, ev('agentStart', 'solution'));
  AR.end(list, ev('agentEnd', 'solution', { ms: 1000, ok: true }));
  AR.start(list, ev('agentStart', 'solution', { label: '修题解' }));
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].open, false);
  assert.strictEqual(list[1].open, true);
  // 增量应当落到**新的**那条上
  AR.append(list, { type: 'agentDelta', role: 'solution', label: '修题解', text: '新一版' });
  assert.strictEqual(list[1].text, '新一版');
  assert.strictEqual(list[0].text, '');
});

ok('先结束后增量（乱序到达）不会新建条目，而是落到那条已结束的记录上', () => {
  const list = [];
  AR.start(list, ev('agentStart', 'brute'));
  AR.end(list, ev('agentEnd', 'brute', { ms: 10, ok: true }));
  AR.append(list, ev('agentDelta', 'brute', { text: '迟到的尾巴' }));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].text, '迟到的尾巴');
});

ok('未知角色的增量会补一条记录（不至于丢内容）', () => {
  const list = [];
  AR.append(list, ev('agentDelta', 'witness', { text: 'x' }));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].role, 'witness');
});

ok('closeAll：流结束时全部收尾（工作台不再显示"实时"）', () => {
  const list = [];
  ['solution', 'brute', 'gen'].forEach((r) => AR.start(list, ev('agentStart', r)));
  AR.closeAll(list, null, Date.now() + 1234);
  assert.strictEqual(list.filter((r) => r.open).length, 0);
});

ok('closeAll 给"没等到 agentEnd 的运行"补上真实耗时（否则显示成 0s 完成）', () => {
  const list = [];
  AR.start(list, ev('agentStart', 'solution'));
  const at = list[0].at;
  AR.closeAll(list, null, at + 2500);
  assert.strictEqual(list[0].ms, 2500, JSON.stringify(list[0]));
  assert.strictEqual(list[0].ok, false);
});

ok('closeAll 把"被停止的运行"标成已中断（不是"失败"——用户点停止不是 Agent 出错）', () => {
  const list = [];
  AR.start(list, ev('agentStart', 'solution'));
  AR.start(list, ev('agentStart', 'brute'));
  AR.end(list, ev('agentEnd', 'brute', { ms: 1500, ok: true }));
  AR.closeAll(list, null, Date.now() + 800);
  const by = {};
  list.forEach((r) => { by[r.role] = r; });
  assert.strictEqual(by.solution.interrupted, true);
  assert.strictEqual(by.brute.interrupted, undefined, '正常结束的那条不该被标成中断');
});

ok('closeAll 不会覆盖已经拿到的真实耗时', () => {
  const list = [];
  AR.start(list, ev('agentStart', 'brute'));
  AR.end(list, ev('agentEnd', 'brute', { ms: 1800, ok: true }));
  AR.closeAll(list, null, Date.now() + 9999);
  assert.strictEqual(list[0].ms, 1800);
  assert.strictEqual(list[0].ok, true);
});

ok('closeAll(list, role) 只收尾指定角色（停止时其他角色不受影响）', () => {
  const list = [];
  ['solution', 'brute', 'gen'].forEach((r) => AR.start(list, ev('agentStart', r)));
  AR.closeAll(list, 'brute');
  const by = {};
  list.forEach((r) => { by[r.role] = r; });
  assert.strictEqual(by.brute.open, false);
  assert.strictEqual(by.solution.open, true);
  assert.strictEqual(by.gen.open, true);
});

ok('列表长度有上限（长会话不会无限增长）', () => {
  const list = [];
  for (let i = 0; i < 20; i++) AR.start(list, ev('agentStart', 'solution', { label: 'r' + i }));
  assert.ok(list.length <= 12, list.length);
});

console.log('\nagentruns: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
