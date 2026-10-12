'use strict';
/**
 * scripts/test-ide.js —— 内嵌 IDE（lib/ide.js + public/js/ide.js + 接线）的单测
 *
 * 用户诉求（原话）："在 coach 里面内嵌一个 ide，然后会带有一种像是代码补全的功能：
 * 用户如果写一半卡壳了，按一下按钮，后面会有半透明的代码提示这样"。
 *
 * 这里盯住的四件事：
 *  ① **喂给模型的材料只有"题面 + 学员自己写的代码"** —— 不读 workspace 里教练已验证的题解/暴力解
 *     （一键抄答案 + 自证污染），所以既有"行为断言"（buildMessages 里没有 sol 的内容），
 *     也有"源码断言"（lib/ide.js 只允许用 workspace.keyFor 取键，不许读它的文件）。
 *  ② 提示词与清洗：光标标记、超长代码裁剪、剥围栏/开场白/回显、行数与字符数封顶。
 *  ③ 代码状态落盘：一题一份、原子写、超限拒存、键从会话推出（前端不能自选键）。
 *  ④ 前端纯函数（幽灵文字怎么落、Tab 怎么插、行号怎么算）与接线（页面/按钮/脚本顺序/路由）——
 *     没有浏览器也要能证明"按按钮才调用、提示可接受可丢弃"。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ide = require('../lib/ide');
const runner = require('../lib/runner');
const cfIde = require('../public/js/ide.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    process.exitCode = 1;
    console.error('  \u2717 ' + name + '\n      ' + String(e && e.message).slice(0, 500));
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    process.exitCode = 1;
    console.error('  \u2717 ' + name + '\n      ' + String(e && e.message).slice(0, 500));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-test-'));
ide.setRoot(tmpRoot);

/* ==================== ① 题面上下文：只读会话本地字段 ==================== */

console.log('ide: 题面上下文（只读会话本地字段）');

const fixture = {
  id: 'c_probe',
  title: '会话标题',
  cfProblem: { contestId: 1800, index: 'C', title: 'Powering the Hero' },
  problemMeta: { rating: 1300, tags: ['greedy', 'sortings'], knowledge: ['贪心'], summary: '用优先队列取最大' },
  statementText: '你有一个英雄和一个牌堆……\n\n\n\n\n输入格式：\n第一行 n。\n',
  cfProblemSamples: [
    { input: '3\n1 2 3\n', output: '6\n' },
    { input: '1\n5\n', output: '5\n' },
    { input: '2\n0 0\n', output: '0\n' },
    { input: '4\n9 9 9 9\n', output: '36\n' }
  ],
  workspace: { sol: 'COACH_SOLUTION_SHOULD_NEVER_LEAK' }
};

ok('题号/难度/标签/样例都被取出来（样例最多 3 组）', () => {
  const p = ide.problemContextOf(fixture);
  assert.strictEqual(p.title, '1800C. Powering the Hero');
  assert.strictEqual(p.rating, 1300);
  assert.deepStrictEqual(p.tags, ['greedy', 'sortings']);
  assert.deepStrictEqual(p.knowledge, ['贪心']);
  assert.strictEqual(p.samples.length, 3, JSON.stringify(p.samples));
  assert.strictEqual(p.samples[0].output, '6\n');
});

ok('题面被保留但把 >=4 个连续换行压成 3 个（模型不需要大片空行）', () => {
  const p = ide.problemContextOf(fixture);
  assert.ok(p.statement.indexOf('英雄') > 0, p.statement);
  assert.ok(!/\n{4,}/.test(p.statement), '仍有 4 个以上连续换行');
});

ok('超长题面被截断且如实标注截断（不静默丢信息）', () => {
  const long = 'x'.repeat(20000);
  const p = ide.problemContextOf(Object.assign({}, fixture, { statementText: long }));
  assert.ok(p.statement.length < 7000, 'len=' + p.statement.length);
  assert.ok(/已截断，共 20000 字符/.test(p.statement), p.statement.slice(-60));
});

ok('没有题面的会话：hasProblemContext=false，但标题仍算素材', () => {
  assert.strictEqual(ide.hasProblemContext(ide.problemContextOf({ id: 'x' })), false);
  assert.strictEqual(ide.hasProblemContext(ide.problemContextOf({ cfProblem: { contestId: 1, index: 'A', title: 'T' } })), true);
});

ok('会话里没有 cfProblem 时退回 meta/title', () => {
  const p = ide.problemContextOf({ title: '裸会话', problemMeta: { title: '元数据标题' } });
  assert.strictEqual(p.title, '元数据标题');
});

/* ==================== ② 提示词：光标标记 / 裁剪 / 纪律 ==================== */

console.log('ide: 提示词（光标标记 / 裁剪 / 不喂教练的题解）');

ok('system 提示词：继续模式要求"只给要插入的片段"，提示模式要求"只给注释"', () => {
  const cont = ide.systemPromptOf('continue');
  const hint = ide.systemPromptOf('hint');
  assert.notStrictEqual(cont, hint);
  assert.ok(/不要.*markdown 围栏|围栏/.test(cont), cont);
  assert.ok(/片段|插入/.test(cont), cont);
  assert.ok(/注释/.test(hint) && /不要输出任何可运行的代码/.test(hint), hint);
  assert.ok(cont.indexOf('14 行') > 0 && cont.indexOf('900') > 0, '必须把上限写进提示词');
});

ok('buildMessages：光标标记出现且只出现一次，位置正好在 caret 处', () => {
  const code = 'int main() {\n  int n; cin >> n;\n';
  const caret = code.length - 1;
  const b = ide.buildMessages({ mode: 'continue', lang: 'cpp', code, caret, problem: ide.problemContextOf(fixture) });
  const content = b.messages[0].content;
  const fenceAt = content.indexOf('```cpp');
  const bodyAt = content.indexOf('\n', fenceAt) + 1;   // '```cpp\n' 之后就是代码本体
  const bodyEnd = content.indexOf('\n```', bodyAt);
  const marked = content.slice(bodyAt, bodyEnd);
  // 提示词里 CURSOR_MARK 会出现在三处（说明行 / 代码本体 / 任务行），
  // 但**代码本体里有且只有一处** —— 那才是模型真正看到的"从这里往下写"。
  assert.strictEqual(marked.split(ide.CURSOR_MARK).length - 1, 1, '代码本体里的标记数不对');
  assert.strictEqual(marked.indexOf(ide.CURSOR_MARK), caret, '标记不在 caret 处');
  assert.strictEqual(b.caret, caret);
  assert.strictEqual(b.clipped, false);
  assert.strictEqual(b.messages[0].role, 'user');
});

ok('buildMessages：题面进提示词，但**教练工作区里的题解一个字都不进**', () => {
  const b = ide.buildMessages({
    mode: 'continue', lang: 'cpp', code: 'int main(){}', caret: 12,
    problem: ide.problemContextOf(fixture)
  });
  const content = b.messages[0].content;
  assert.ok(content.indexOf('英雄') > 0, '题面没进去');
  assert.ok(content.indexOf('样例 1 输入') > 0, '样例没进去');
  assert.ok(content.indexOf('1300') > 0, 'rating 没进去');
  assert.strictEqual(content.indexOf('COACH_SOLUTION_SHOULD_NEVER_LEAK'), -1, '教练的题解泄漏进提示词了！');
});

ok('buildMessages：没有题面时如实说明"只能依据代码本身判断"', () => {
  const b = ide.buildMessages({ mode: 'continue', lang: 'python', code: 'print(1)', caret: 8, problem: {} });
  assert.ok(/未知/.test(b.messages[0].content), b.messages[0].content);
});

ok('超长代码只留光标附近（前面省略的部分如实标注）', () => {
  const code = 'A'.repeat(20000) + 'CARET' + 'B'.repeat(20000);
  const caret = 20000;
  const clip = ide.clipAroundCaret(code, caret);
  assert.ok(clip.omitted > 30000, JSON.stringify(clip.omitted));
  assert.ok(clip.text.length <= 8000 + 1200, 'len=' + clip.text.length);
  assert.strictEqual(clip.caret, 8000);
  const b = ide.buildMessages({ mode: 'continue', lang: 'cpp', code, caret, problem: {} });
  assert.strictEqual(b.clipped, true);
  assert.ok(/中间省略了 \d+ 个字符/.test(b.messages[0].content), b.messages[0].content.slice(0, 200));
  const content = b.messages[0].content;
  const bodyAt = content.indexOf('\n', content.indexOf('```cpp')) + 1;
  const marked = content.slice(bodyAt, content.indexOf('\n```', bodyAt));
  assert.strictEqual(marked.split(ide.CURSOR_MARK).length - 1, 1, '代码本体里的标记数不对');
});

ok('提示模式的任务描述与继续模式不同（不写代码）', () => {
  const cont = ide.buildMessages({ mode: 'continue', lang: 'cpp', code: 'int a;', caret: 6, problem: {} });
  const hint = ide.buildMessages({ mode: 'hint', lang: 'cpp', code: 'int a;', caret: 6, problem: {} });
  assert.ok(/插入的片段/.test(cont.messages[0].content));
  assert.ok(/不写代码|不要写代码/.test(hint.messages[0].content));
});

/* ==================== ③ 清洗模型输出 ==================== */

console.log('ide: 清洗模型输出（围栏 / 开场白 / 回显 / 封顶）');

ok('剥掉 markdown 围栏并记下 note', () => {
  const r = ide.cleanSuggestion('```cpp\n  cin >> n;\n```', { mode: 'continue', lang: 'cpp', code: '', caret: 0 });
  assert.strictEqual(r.text, '  cin >> n;');
  assert.ok(/围栏/.test(r.note), r.note);
});

ok('删掉"好的，这是补全："这类开场白', () => {
  const r = ide.cleanSuggestion('好的，这是补全：\n  return 0;\n}', { mode: 'continue', lang: 'cpp', code: '', caret: 0 });
  assert.strictEqual(r.text, '  return 0;\n}');
});

ok('模型把已有代码回显一遍时，重复的行被砍掉', () => {
  const code = 'int main(){\n  int a;\n';
  const r = ide.cleanSuggestion('  int a;\n  cin >> a;\n}', { mode: 'continue', lang: 'cpp', code, caret: code.length });
  assert.strictEqual(r.text, '  cin >> a;\n}', JSON.stringify(r.text));
});

ok('光标停在半行上：模型从行首重写时砍掉重复前缀', () => {
  const code = 'int main(){ int a = ';
  const r = ide.cleanSuggestion('int main(){ int a = 1;', { mode: 'continue', lang: 'cpp', code, caret: code.length });
  assert.strictEqual(r.text, '1;', JSON.stringify(r.text));
});

ok('行数封顶 14 行、字符封顶 900（并把"已截断"说出来）', () => {
  const many = new Array(30).fill('  x++;').join('\n');
  const r1 = ide.cleanSuggestion(many, { mode: 'continue', lang: 'cpp', code: '', caret: 0 });
  assert.strictEqual(r1.text.split('\n').length, 14);
  assert.strictEqual(r1.capped, true);
  const oneLine = 'y'.repeat(5000);
  const r2 = ide.cleanSuggestion(oneLine, { mode: 'continue', lang: 'cpp', code: '', caret: 0 });
  assert.ok(r2.text.length <= 900, 'len=' + r2.text.length);
  assert.strictEqual(r2.capped, true);
});

ok('空输出洗成空串（上层据此判"没有可用的补全"，不会插一段空气）', () => {
  assert.strictEqual(ide.cleanSuggestion('', { mode: 'continue', lang: 'cpp' }).text, '');
  assert.strictEqual(ide.cleanSuggestion('   \n\n  ', { mode: 'continue', lang: 'cpp' }).text, '');
});

ok('提示模式保留注释、不做"回显删除"', () => {
  const r = ide.cleanSuggestion('// 试试前缀和\n// 注意下标从 1 开始', { mode: 'hint', lang: 'cpp', code: '// 试试前缀和', caret: 8 });
  assert.strictEqual(r.text, '// 试试前缀和\n// 注意下标从 1 开始');
});

ok('语言归一化：只认 cpp / python；js 已从 IDE 去掉（回落到 cpp）', () => {
  assert.strictEqual(ide.langOf('C++'), 'cpp');
  assert.strictEqual(ide.langOf('g++'), 'cpp');
  assert.strictEqual(ide.langOf('PyPy'), 'python');
  assert.strictEqual(ide.langOf('python3'), 'python');
  // 学员明确要求去掉 JavaScript：老状态/老客户端送来 'js' 一律当 C++（不然会拿 node 去跑 C++ 代码）
  assert.strictEqual(ide.langOf('js'), 'cpp');
  assert.strictEqual(ide.langOf('JavaScript'), 'cpp');
  assert.strictEqual(ide.langOf('Node'), 'cpp');
  assert.strictEqual(ide.langOf('brainfuck'), 'cpp');
  assert.strictEqual(ide.commentPrefix('python'), '#');
  assert.strictEqual(ide.commentPrefix('cpp'), '//');
  assert.strictEqual(ide.langLabel('js'), 'C++23');
});

/* ==================== ④ 代码状态：一题一份 ==================== */

console.log('ide: 代码状态（一题一份 / 原子写 / 键由会话推出）');

ok('键从会话的题号推出，与 workspace 同口径；没有题就退回会话 id', () => {
  assert.strictEqual(ide.stateKeyOf(fixture), 'cf-1800C');
  assert.strictEqual(ide.stateKeyOf({ id: 'c_probe' }), 'c_probe');
  assert.strictEqual(ide.stateKeyOf(null), 'scratch');
});

ok('safeKey 挡掉目录穿越（前端不能自选键，但防御要成对）', () => {
  const k = ide.safeKey('../../etc/passwd');
  assert.ok(k.indexOf('/') < 0 && k.indexOf('\\') < 0, k);
  assert.strictEqual(ide.safeKey(''), 'scratch');
});

ok('保存 → 读取（语言与代码都在，文件落在 <root>/ide/<key>.json）', () => {
  const r = ide.saveState('cf-1800C', { lang: 'python', code: 'print(1)\n' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.file, path.join(tmpRoot, 'ide', 'cf-1800C.json'));
  const back = ide.loadState('cf-1800C');
  assert.strictEqual(back.lang, 'python');
  assert.strictEqual(back.code, 'print(1)\n');
  assert.ok(back.updatedAt > 0);
});

ok('没保存过的键读到空状态（不抛异常）', () => {
  const st = ide.loadState('cf-9999Z');
  assert.deepStrictEqual({ lang: st.lang, code: st.code, updatedAt: st.updatedAt }, { lang: 'cpp', code: '', updatedAt: 0 });
});

ok('损坏的 JSON 不会把 IDE 弄崩（当作空状态）', () => {
  const file = path.join(tmpRoot, 'ide', 'cf-broken.json');
  fs.writeFileSync(file, '{半截', 'utf8');
  const st = ide.loadState('cf-broken');
  assert.strictEqual(st.code, '');
});

ok('超过 20 万字符拒存，且如实给出原因', () => {
  const r = ide.saveState('cf-1800C', { lang: 'cpp', code: 'x'.repeat(200001) });
  assert.strictEqual(r.ok, false);
  assert.ok(/上限/.test(r.error), r.error);
  assert.strictEqual(ide.loadState('cf-1800C').code, 'print(1)\n', '拒存时不能把旧代码弄丢');
});

ok('keepCode：只改语言时不清空代码', () => {
  ide.saveState('cf-1800C', { lang: 'cpp', code: '', keepCode: true });
  assert.strictEqual(ide.loadState('cf-1800C').code, 'print(1)\n');
  assert.strictEqual(ide.loadState('cf-1800C').lang, 'cpp');
});

/* ==================== ⑤ 运行器：runOnce（IDE 自己填 stdin 跑一次） ==================== */

(async () => {
  console.log('ide: 运行器 runOnce（自己填 stdin 跑一次）');

  ok('runOnce 已导出，且空代码不会去启动进程', () => {
    assert.strictEqual(typeof runner.runOnce, 'function');
  });

  await okAsync('runOnce：空代码 → verdict=EMPTY', async () => {
    const r = await runner.runOnce({ lang: 'cpp', code: '   ', input: '' });
    assert.strictEqual(r.verdict, 'EMPTY');
    assert.strictEqual(r.ok, false);
  });

  const avail = await runner.availableRuntimes();

  await okAsync(avail.python ? 'runOnce：Python 真跑一次，自己的输入 → 自己的输出' : 'runOnce：跳过（本机没有 python）', async () => {
    if (!avail.python) return null;
    const r = await runner.runOnce({
      lang: 'python',
      code: 'import sys\ndata = sys.stdin.read().split()\nprint(int(data[0]) + int(data[1]))\n',
      input: '2 3\n'
    });
    assert.strictEqual(r.verdict, 'OK', JSON.stringify(r));
    assert.strictEqual(r.stdout.trim(), '5');
    assert.ok(r.timeMs >= 0);
    return null;
  });

  await okAsync(avail.python ? 'runOnce：程序自己报错 → verdict=RE 且 stderr 带回来' : 'runOnce：跳过（本机没有 python）', async () => {
    if (!avail.python) return null;
    const r = await runner.runOnce({ lang: 'python', code: 'raise SystemExit(3)\n', input: '' });
    assert.strictEqual(r.verdict, 'RE', JSON.stringify(r));
    assert.strictEqual(r.exitCode, 3);
    return null;
  });

  await okAsync(avail.cpp ? 'runOnce：C++ 编译失败 → verdict=CE（把编译器原话带回去）' : 'runOnce：跳过（本机没有 g++）', async () => {
    if (!avail.cpp) return null;
    const r = await runner.runOnce({ lang: 'cpp', code: 'int main(){ this is not cpp }', input: '' });
    assert.strictEqual(r.verdict, 'CE', JSON.stringify(r));
    assert.ok(/error/i.test(String(r.error)), r.error);
    return null;
  });

  /* ==================== ⑥ 前端纯函数（幽灵文字怎么落） ==================== */

  console.log('ide: 前端纯函数（幽灵文字 / 接受 / 行号 / 兜底）');

  ok('escapeHtml 挡住了注入（补全文本要按纯文本渲染）', () => {
    assert.strictEqual(cfIde.escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  });

  const fakeNoHl = null;   // 不注入 hljs：走"只转义"的兜底路径
  ok('renderLayerHtml：幽灵正好夹在"光标前"和"光标后"之间', () => {
    const html = cfIde.renderLayerHtml('abcdef', 3, 'XY', 'cpp', fakeNoHl);
    assert.strictEqual(html, 'abc<span class="ide-ghost">XY</span>def');
  });

  ok('renderLayerHtml：没有幽灵时就是纯高亮（不会残留空 span）', () => {
    assert.strictEqual(cfIde.renderLayerHtml('abc', 1, '', 'cpp', fakeNoHl), 'abc');
    assert.strictEqual(cfIde.renderLayerHtml('abc', 1, null, 'cpp', fakeNoHl), 'abc');
  });

  ok('renderLayerHtml：幽灵里的尖括号被转义（不会当 HTML 执行）', () => {
    const html = cfIde.renderLayerHtml('a', 1, '<b>hi</b>', 'cpp', fakeNoHl);
    assert.strictEqual(html, 'a<span class="ide-ghost">&lt;b&gt;hi&lt;/b&gt;</span>');
  });

  const fakeHl = {
    getLanguage: (n) => (n === 'cpp' ? {} : null),
    highlight: (code) => ({ value: '<span class="hljs-keyword">' + code + '</span>' })
  };
  ok('highlightToHtml：语言注册了就用高亮，没注册就只转义（不猜语言）', () => {
    assert.strictEqual(cfIde.highlightToHtml('int', 'cpp', fakeHl), '<span class="hljs-keyword">int</span>');
    let called = false;
    const spy = { getLanguage: () => null, highlight: () => { called = true; return { value: 'x' }; } };
    assert.strictEqual(cfIde.highlightToHtml('int', 'cpp', spy), 'int');
    assert.strictEqual(called, false, '没注册的语言不该调用 highlight');
  });

  ok('highlightToHtml：真的 hljs 包里 cpp/python 都注册了（不然编辑器一片白）', () => {
    const real = require('../public/vendor/hljs/highlight.min.js');
    const H = real && real.default ? real.default : real;
    assert.strictEqual(!!H.getLanguage('cpp'), true);
    assert.strictEqual(!!H.getLanguage('python'), true);
    const html = cfIde.highlightToHtml('int main(){ return 0; }', 'cpp', H);
    assert.ok(/<span class="hljs-/.test(html), html.slice(0, 120));
  });

  ok('acceptSuggestion：开头/中间/结尾插都对，光标落在插入内容之后', () => {
    assert.deepStrictEqual(cfIde.acceptSuggestion('abc', 0, 'X'), { code: 'Xabc', caret: 1 });
    assert.deepStrictEqual(cfIde.acceptSuggestion('abc', 1, 'XY'), { code: 'aXYbc', caret: 3 });
    assert.deepStrictEqual(cfIde.acceptSuggestion('abc', 3, 'Z'), { code: 'abcZ', caret: 4 });
  });

  ok('acceptSuggestion：越界/负数光标被夹紧（浏览器给的 selectionStart 可能超范围）', () => {
    assert.deepStrictEqual(cfIde.acceptSuggestion('abc', 99, 'Z'), { code: 'abcZ', caret: 4 });
    assert.deepStrictEqual(cfIde.acceptSuggestion('abc', -5, 'Z'), { code: 'Zabc', caret: 1 });
  });

  ok('lineNumbers：行号从 1 开始，空文件也有 1 行', () => {
    assert.deepStrictEqual(cfIde.lineNumbers(1), ['1']);
    assert.deepStrictEqual(cfIde.lineNumbers(3), ['1', '2', '3']);
    assert.deepStrictEqual(cfIde.lineNumbers(0), ['1']);
  });

  ok('capOutput：超长输出截断并标记（界面别被一兆输出卡死）', () => {
    assert.deepStrictEqual(cfIde.capOutput('abc', 10), { text: 'abc', truncated: false });
    const big = cfIde.capOutput('x'.repeat(20), 10);
    assert.strictEqual(big.text.length, 10);
    assert.strictEqual(big.truncated, true);
  });

  ok('verdictText：6 种判词都有中文说法', () => {
    assert.strictEqual(cfIde.verdictText('OK'), '运行成功');
    assert.strictEqual(cfIde.verdictText('TLE'), '超时');
    assert.strictEqual(cfIde.verdictText('RE'), '运行错误');
    assert.strictEqual(cfIde.verdictText('CE'), '编译失败');
    assert.strictEqual(cfIde.verdictText('EMPTY'), '代码为空');
    assert.ok(cfIde.verdictText('???').length > 0);
  });

  ok('前端语言表：只有 C++23 与 Python 3（JavaScript 已删除）', () => {
    const vals = cfIde.LANGS.map((l) => l.v);
    assert.deepStrictEqual(vals, ['cpp', 'python'], JSON.stringify(vals));
    assert.ok(!/js|javascript/i.test(cfIde.LANGS.map((l) => l.v + l.label).join(' ')), '语言表里还有 JS');
    assert.strictEqual(cfIde.langOf('js'), 'cpp');
    assert.strictEqual(cfIde.langOf('javascript'), 'cpp');
    assert.strictEqual(cfIde.langOf('node'), 'cpp');
    assert.strictEqual(cfIde.hljsName('python'), 'python');
    assert.strictEqual(cfIde.hljsName('js'), 'cpp');
    assert.strictEqual(cfIde.langLabel('python'), 'Python 3');
  });

  ok('右侧讲题报告：内容键（同内容不重建 iframe / 图文与文字区分开）', () => {
    const doc = { id: 'm1', html: '<p>hi</p>' };
    assert.strictEqual(cfIde.reportKeyOf(doc), cfIde.reportKeyOf({ id: 'm1', html: '<p>hi</p>' }));
    assert.notStrictEqual(cfIde.reportKeyOf(doc), cfIde.reportKeyOf({ id: 'm1', html: '<p>hi2</p>' }));
    assert.notStrictEqual(cfIde.reportKeyOf(doc), cfIde.reportKeyOf({ id: 'm1', text: '<p>hi</p>' }));
    assert.notStrictEqual(cfIde.reportKeyOf(doc), cfIde.reportKeyOf({ id: 'm2', html: '<p>hi</p>' }));
    assert.strictEqual(cfIde.reportKeyOf(null), '');
    assert.strictEqual(cfIde.reportKeyOf(undefined), '');
    assert.strictEqual(cfIde.hashString(''), cfIde.hashString(''));
    assert.notStrictEqual(cfIde.hashString('a'), cfIde.hashString('b'));
    assert.strictEqual(typeof cfIde.setReport, 'function', '没导出 setReport，app.js 推不进讲解');
  });

  /* ==================== ⑦ 接线与纪律（源码级断言） ==================== */

  console.log('ide: 接线与纪律（源码级断言）');

  const srcIde = read('lib/ide.js');
  const srcClient = read('public/js/ide.js');
  const srcServer = read('server.js');
  const srcApp = read('public/js/app.js');
  const srcHtml = read('public/index.html');
  const srcCss = read('public/styles.css');

  ok('lib/ide.js 只用 workspace.keyFor 取键，绝不读工作区文件（题解不许进提示词）', () => {
    assert.ok(/workspace\.keyFor\(/.test(srcIde), '应复用 workspace 的键口径');
    assert.ok(!/workspace\.(readFile|readSolFile|summary|cacheVerified|listFiles|readCache)/.test(srcIde),
      'lib/ide.js 读了工作区文件 —— 那会把教练的题解喂进补全');
    assert.ok(!/\bsol\.(cpp|py)\b/.test(srcIde), '提到了 sol.cpp/py，可疑');
  });

  ok('lib/ide.js 不发网络请求、不起子进程（调用与运行都在 server.js 的边界上）', () => {
    assert.ok(!/\bfetch\(/.test(srcIde), 'lib/ide.js 不该自己发请求');
    assert.ok(!/child_process|spawn\(/.test(srcIde), 'lib/ide.js 不该自己起进程');
  });

  ok('server.js：四条 IDE 路由齐全', () => {
    ['GET', 'POST'].forEach(() => {});
    assert.ok(/method === 'GET' && p === '\/api\/ide'/.test(srcServer), 'GET /api/ide 没有');
    assert.ok(/p === '\/api\/ide\/save'/.test(srcServer), 'save 没有');
    assert.ok(/p === '\/api\/ide\/complete'/.test(srcServer), 'complete 没有');
    assert.ok(/p === '\/api\/ide\/run'/.test(srcServer), 'run 没有');
  });

  ok('server.js：补全走 callAgentLLM + 低温度 + 只在角色 solution 上取模型', () => {
    const block = srcServer.slice(srcServer.indexOf("p === '/api/ide/complete'"), srcServer.indexOf("p === '/api/ide/run'"));
    assert.ok(/callAgentLLM\(\{/.test(block), '没走统一的模型调用封装');
    assert.ok(/temperature: 0\.1/.test(block), '温度没压低');
    assert.ok(/resolveAgentTarget\(cfg0, provider, model0, IDE_ROLE\)/.test(block), '没走角色模型');
    assert.ok(/req\.on\('close'/.test(block), '客户端走了不掐调用 → 白烧 token');
  });

  ok('server.js：运行走 runner.runOnce，IDE 路由里不自己 spawn', () => {
    const block = srcServer.slice(srcServer.indexOf("p === '/api/ide/run'"), srcServer.indexOf('/* ---- 算法教练：Codeforces / 运行环境 ---- */'));
    assert.ok(/runner\.runOnce\(/.test(block), '没走统一的运行器');
    assert.ok(!/spawn/.test(block), 'IDE 路由里出现了 spawn —— 必须走 lib/runner.js（windowsHide 统一出口）');
  });

  ok('前端：只有两个按钮会触发模型调用（不做随打字的自动补全）', () => {
    const calls = (srcClient.match(/complete\(/g) || []).length;
    assert.strictEqual(calls, 3, 'complete( 出现 ' + calls + ' 次（应为 1 处定义 + 2 处按钮）');
    assert.ok(/btnComplete\.addEventListener\('click', function \(\) \{ complete\('continue'\); \}\)/.test(srcClient), '「补全」按钮没接上');
    assert.ok(/btnHint\.addEventListener\('click', function \(\) \{ complete\('hint'\); \}\)/.test(srcClient), '「提示」按钮没接上');
    const inputHandler = srcClient.slice(srcClient.indexOf("addEventListener('input'"), srcClient.indexOf("addEventListener('scroll'"));
    assert.ok(inputHandler.indexOf('complete(') < 0, 'input 事件里竟然调用了补全 —— 那是随打字自动补全，烧钱');
  });

  ok('前端：Tab 接受 / Esc 与继续打字丢弃（幽灵只是建议）', () => {
    assert.ok(/e\.key === 'Tab' && st\.ghost/.test(srcClient), 'Tab 接受没实现');
    assert.ok(/e\.key === 'Escape' && st\.ghost/.test(srcClient), 'Esc 丢弃没实现');
    assert.ok(/acceptGhost\(\)/.test(srcClient) && /dismissGhost\(\)/.test(srcClient));
  });

  ok('前端：三层对齐的样式钩子在（高亮层/输入层共用 .ide-layer、幽灵 .ide-ghost）', () => {
    assert.ok(/class="ide-hl ide-layer hljs"/.test(srcClient), '高亮层缺 hljs 类（拿不到主题配色）或 ide-layer');
    assert.ok(/class="ide-input ide-layer"/.test(srcClient), '输入层缺 ide-layer');
    assert.ok(/\.ide-layer \{/.test(srcCss), '样式里没有 .ide-layer');
    assert.ok(/\.ide-ghost \{/.test(srcCss), '样式里没有 .ide-ghost');
    const cssIdx = srcCss.indexOf('IDE 页（写代码');
    assert.ok(cssIdx > 0, '样式里没有 IDE 段');
    const ideCss = srcCss.slice(cssIdx);
    assert.ok(!/background:\s*#/.test(ideCss), 'IDE 样式里写死了背景色 —— 换主题会错');
    assert.ok(/white-space: pre/.test(ideCss), '三层必须都不折行（white-space: pre）才对齐');
  });

  ok('index.html：导航按钮 / 页面容器 / 脚本顺序（ide.js 在 app.js 之前）', () => {
    assert.ok(/id="btn-ide"/.test(srcHtml), '侧边栏没有 IDE 按钮');
    assert.ok(/id="page-ide"/.test(srcHtml), '没有 #page-ide 容器');
    const iIde = srcHtml.indexOf('/js/ide.js');
    const iApp = srcHtml.indexOf('/js/app.js');
    assert.ok(iIde > 0 && iApp > iIde, 'ide.js 必须排在 app.js 之前');
  });

  ok('app.js：右侧讲解跟着会话/文档同步（只读已有讲解，不额外调模型）', () => {
    assert.ok(/function ideReportOf\(\)/.test(srcApp), '没有 ideReportOf');
    assert.ok(/m\.richDoc\) return \{ id: m\.id/.test(srcApp), '图文文档优先没实现');
    assert.ok(/function syncIdeReport\(\)/.test(srcApp) && /window\.CFIde\.setReport\(/.test(srcApp), '没把讲解推给 CFIde');
    assert.ok(/report: ideReportOf\(\)/.test(srcApp), 'openIdePage 没带 report');
    assert.ok(/bindRichDocs\(view\);\s*\n\s*syncIdeReport\(\);/.test(srcApp), 'renderMessages 里没同步讲解');
    assert.ok(/renderMessages\(\);\s*\n\s*syncIdeReport\(\);/.test(srcApp), 'richDoc 事件里没同步讲解');
  });

  ok('前端 + 样式：右侧讲解栏的 DOM 钩子与隔离（sandbox iframe 填满整栏）', () => {
    assert.ok(/data-ide-report-body/.test(srcClient) && /class="ide-report"/.test(srcClient), '客户端缺讲解栏 DOM');
    assert.ok(/data-ide-report-toggle/.test(srcClient), '缺"收起/展开讲解"按钮');
    assert.ok(/iframe\.setAttribute\('sandbox', 'allow-scripts'\)/.test(srcClient), '讲解 iframe 没有 sandbox');
    assert.ok(/iframe\.srcdoc = rep\.html/.test(srcClient), '图文文档没走 srcdoc');
    assert.ok(/window\.MD\.renderMarkdown\(/.test(srcClient), '文字讲解没走 Markdown 渲染');
    assert.ok(/localStorage/.test(srcClient), '收起状态没记住（REPORT_LS_KEY）');
    assert.ok(/\.ide-cols \{/.test(srcCss) && /\.ide-report \{/.test(srcCss) && /\.ide-report-frame \{/.test(srcCss), '样式缺讲解栏');
    assert.ok(/\.ide-wrap\.report-collapsed \.ide-report \{ display: none; \}/.test(srcCss), '收起样式没写');
  });

  ok('lib/ide.js：语言表里没有 js（服务端也跟着回落到 cpp）', () => {
    assert.ok(!/js: 'JavaScript/i.test(srcIde), 'lib/ide.js 还有 JS 语言标签');
    assert.ok(!/LANG_FENCE[^\n]*js/.test(srcIde), 'LANG_FENCE 里还有 js');
    assert.ok(!/return 'js'/.test(srcIde), "langOf 还会返回 'js'");
  });

  ok('app.js：注册 ide 页、跟着当前题走、离开时先保存', () => {
    assert.ok(/ide: '.*IDE'/.test(srcApp), 'VIEW_TITLES 没有 ide');
    assert.ok(/'library', 'ide'/.test(srcApp) || /'ide'/.test(srcApp.slice(srcApp.indexOf('const PAGES'), srcApp.indexOf('const PAGES') + 200)), 'PAGES 没有 ide');
    assert.ok(/function openIdePage\(\)/.test(srcApp) && /window\.CFIde\.open\(/.test(srcApp), 'IDE 页没接上');
    assert.ok(/\$\('#btn-ide'\)\.addEventListener/.test(srcApp), '按钮没绑');
    assert.ok(/state\.view === 'ide' && view !== 'ide'[\s\S]{0,80}CFIde\.close\(\)/.test(srcApp), '离开 IDE 页时没保存');
    assert.ok(/syncIdePage\(\);/.test(srcApp), '切题时没同步 IDE');
  });

  ok('AGENTS.md 写进了纪律（后来的人不许改回去）', () => {
    const agents = read('AGENTS.md');
    assert.ok(/只看「题面 \+ 你自己写的代码」|只看「题面/.test(agents), '没有"补全只看题面+自己的代码"');
    assert.ok(/不读工作区里教练的题解|绝不读.*题解/.test(agents), '没有"不读教练题解"');
    assert.ok(/不做随打字的自动补全/.test(agents), '没有"不自动补全"');
    assert.ok(/lib\/runner\.js/.test(agents), '没有"运行必须走 lib/runner.js"');
    assert.ok(/只有 C\+\+ \/ Python 两种语言/.test(agents), '没有"只有 C++/Python 两种语言"');
    assert.ok(/右侧[讲解]*栏只展示教练已经讲过的东西|讲解栏只展示/.test(agents), '没有"讲解栏只展示已有讲解"');
  });

  ok('check-sync 的 FILES 收录了两个新文件（否则 check:pack 会骂）', () => {
    const sync = read('scripts/check-sync.js');
    assert.ok(/'lib\/ide\.js'/.test(sync), 'lib/ide.js 没进 FILES');
    assert.ok(/'public\/js\/ide\.js'/.test(sync), 'public/js/ide.js 没进 FILES');
  });

  ok('package.json：test:ide 在，且已挂进 test:units', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(/scripts\/test-ide\.js/.test(pkg.scripts['test:ide'] || ''), '少了 test:ide');
    assert.ok(/scripts\/test-ide\.js/.test(pkg.scripts['test:units'] || ''), 'test:units 链上没有 test-ide');
  });

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }

  console.log('\nide: ' + pass + ' 项通过' + (fail ? ' / ' + fail + ' 项失败' : ' / 0 失败'));
  if (fail) process.exitCode = 1;
})();
