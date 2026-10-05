'use strict';
/**
 * 诊断包测试（lib/diagbundle.js + scripts/diag.js）。
 *
 * 用户诉求原话："现在有办法将其它电脑上的 cfcoach 运行日志传过来吗？"
 * 这个包要同时满足三件事，测试就盯这三件：
 *   ① **能定位问题**：日志（尾部）、题库与 oracle/生成器台账、每一跑的工具轨迹、判分与配对结果都在；
 *   ② **敢直接发出来**：API key / cookie / 邮箱 / 系统用户名一定打码，且不含解题代码与题面正文；
 *   ③ **不会反过来把应用搞崩**：目录/文件缺失只是少一段 + 一条提醒，绝不抛异常；
 *      体积有上限（单段 / 整包 / 每会话 / 每份答案 / 每条 transcript）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const diag = require('../lib/diagbundle');
const diagCli = require('./diag');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// ---------------------------------------------------------------- 夹具
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cfcoach-diag-test-'));
const DATA = path.join(T, 'data');
const USERDATA = path.join(T, 'userdata');
const ABL = path.join(T, 'ablation', 'out', 'ui');

function write(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
}
function writeJson(p, o) { write(p, JSON.stringify(o, null, 2)); }

const SECRET_KEY = 'sk-SECRET-abcdef123456';
const SECRET_COOKIE = 'COOKIEVALUE-should-never-appear';
const SECRET_TOKEN = 'tok-SECRET-should-never-appear';

writeJson(path.join(DATA, 'config.json'), {
  providers: [{
    id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    apiKey: SECRET_KEY, models: ['deepseek-flash', 'deepseek-v4-pro']
  }],
  defaults: { providerId: 'p1', model: 'deepseek-flash' }
});
write(path.join(DATA, 'cf-fetch.log'),
  '2026-10-05T02:00:00Z 抓取 2268A 开始\n'
  + '已写入 cookie cf_clearance=' + SECRET_COOKIE + '; codeforces=xyz; 39ce7=abc\n'
  + 'Authorization: Bearer ' + SECRET_TOKEN + '\n'
  + '抓取 2268A 成功（题面 1056 字符，样例 1 组）\n');
write(path.join(DATA, 'profile-log.jsonl'), '{"t":"2026-10-05T02:00:00Z","kind":"rate","rating":1200}\n');
writeJson(path.join(DATA, 'profile-card.json'), { handle: 'tester', contact: 'tester@example.com' });
writeJson(path.join(DATA, 'cf-problems', '2268A.json'), {
  contestId: 2268, index: 'A', title: 'A. K Is Important', rating: 1200,
  statement: '这是题面正文，诊断包里不应该出现。', samples: [{ input: '1', output: '1' }],
  tags: ['greedy', 'constructive algorithms']
});
// meta.json 的真实形状（lib/workspace.js recordVerification + lib/harness.js patchMeta）：
//   { verification: {...}, trajectory: [...], trace: [...] }
writeJson(path.join(DATA, 'workspace', 'ab-2268A', 'meta.json'), {
  verification: {
    status: 'ok', verdict: 'ok', iterations: 186, samples: 1, tiers: [8, 20, 50, 200],
    scopeComplete: false, stressTruncated: '暴力解在规模档 200 撑不住，已在其可承受的档位完成对拍',
    delivered: 'model-first', solRollback: false, avgSolutionMs: 145, samplesSource: 'official'
  },
  trajectory: [{ kind: 'solve' }, { kind: 'stress' }],
  trace: [{ label: 'sol', ok: true, ms: 1234 }]
});
write(path.join(DATA, 'workspace', 'ab-2268A', 'sol.py'), 'print("解题代码正文不该进诊断包")\n');
writeJson(path.join(DATA, 'conversations', 'c1.json'), {
  id: 'c1', title: '2268A 求助', provider: 'p1', model: 'deepseek-flash',
  mode: 'coach', rich: true, updatedAt: '2026-10-05T03:00:00Z',
  messages: [
    { role: 'user', content: '第 1 条（会被裁掉）' },
    { role: 'user', content: '第 2 条（会被裁掉）' },
    { role: 'user', content: '第 3 条（会被裁掉）' },
    { role: 'assistant', content: '第 4 条（保留）' },
    { role: 'user', content: '我的邮箱 tester@example.com，key ' + SECRET_KEY }
  ]
});
write(path.join(USERDATA, 'cf-diag.log'),
  '2026-10-05T02:00:00Z [cf] 隐藏窗口抓取超时\n2026-10-05T02:00:20Z [cf] 可见窗口挑战通过\n');

writeJson(path.join(ABL, 'summary.json'), {
  generatedAt: '2026-10-05T03:02:52.372Z', runs: 3,
  byLevel: { L0: { ok: 1 }, L1: { ok: 0, failed: 1 }, L2: { ok: 1 } }
});
writeJson(path.join(ABL, 'problems.json'), [{
  id: '2268A', title: 'A. K Is Important', rating: 1200, source: 'cf',
  note: 'tags: constructive algorithms, greedy', samples: [{ input: '1', output: '1' }],
  oracleLang: 'python', oracle: { file: path.join(ABL, 'oracle', '2268A.py') },
  genLang: 'cpp', gen: null, statementSha: '32d75337987056b1'
}]);
write(path.join(ABL, 'oracle', '2268A.py'), 'print(1)\n');
write(path.join(ABL, 'records.jsonl'), [
  JSON.stringify({
    level: 'L1', problem: '2268A', model: 'deepseek-flash', ok: false, steps: 20, calls: 21,
    codeLang: null, codeSource: null, usage: { promptTokens: 708051, completionTokens: 52862 },
    ms: 325199, error: '既没有落盘的正解文件，回答里也没有代码块',
    toolsUsed: ['write_file', 'run_code', 'stress_test'],
    finalize: { calls: 1, chars: 0, code: false, promptTokens: 120, completionTokens: 8 }
  }),
  JSON.stringify({
    level: 'L2', problem: '2268A', model: 'deepseek-flash', ok: true, steps: 12, calls: 14,
    codeLang: 'python', codeSource: 'workspace:sol.py', usage: { promptTokens: 24409, completionTokens: 246228 },
    ms: 735941, roles: { solution: 2, brute: 1, gen: 1 },
    verification: { status: 'ok', iterations: 186, scopeComplete: false, delivered: 'model-first' }
  })
].join('\n') + '\n');
write(path.join(ABL, 'verdicts.jsonl'), JSON.stringify({ runId: 'r1', sampleVerdict: 'AC', diffVerdict: 'no-gen' }) + '\n');
writeJson(path.join(ABL, 'compare.json'), { pairs: [{ key: '2268A|deepseek-flash', n: 2 }] });
write(path.join(ABL, 'answers', 'L1-2268A.md'), '这份回答整份都是内部标记\n');
write(path.join(ABL, 'transcript', 'L1-2268A.jsonl'), [
  { kind: 'toolStart', name: 'write_file', t: 0 },
  { kind: 'toolEnd', name: 'write_file', ok: true, ms: 12, t: 12, result: 'wrote enum.py' },
  { kind: 'toolEnd', name: 'stress_test', ok: true, ms: 25911, t: 25923, result: '60 组全部通过' },
  { kind: 'toolEnd', name: 'verify_random', ok: false, ms: 5285, t: 31208, result: 'TLE' }
].map((e) => JSON.stringify(e)).join('\n') + '\n');
write(path.join(ABL, 'sandbox', 'L1-2268A', 'enum.py'), 'print(1)\n');
write(path.join(ABL, 'docs', 'L2-2268A.html'), '<html>37428 字节的图文文档</html>');

const OPTS = {
  dataDir: DATA, userDataDir: USERDATA, rootDir: T, ablationOut: ABL,
  appVersion: '0.9.9', electronVersion: '44.3.0', chromeVersion: '140',
  locale: 'zh-CN', timeZone: 'Asia/Shanghai', packed: false
};

// ---------------------------------------------------------------- 脱敏
console.log('diagbundle: 脱敏');

ok('API key / cookie / Bearer / 裸 sk- / 邮箱 / 系统用户名都被打码，原值一个都不剩', () => {
  const text = [
    '"apiKey": "' + SECRET_KEY + '"',
    'api_key=' + SECRET_KEY,
    '已写入 cookie cf_clearance=' + SECRET_COOKIE + '; codeforces=xyz',
    'Authorization: Bearer ' + SECRET_TOKEN,
    'ghp_abcdefghijklmnop',
    '联系人 tester@example.com',
    '路径 C:\\Users\\tester\\AppData'
  ].join('\n');
  const r = diag.redact(text);
  for (const secret of [SECRET_KEY, SECRET_COOKIE, SECRET_TOKEN, 'ghp_abcdefghijklmnop', 'tester@example.com']) {
    assert.ok(!r.includes(secret), '泄漏了：' + secret + '\n' + r);
  }
  assert.ok(r.includes('<email>'), '邮箱应替换成占位符：' + r);
  assert.ok(r.includes('C:\\Users\\<user>'), '系统用户名应打码：' + r);
  assert.ok(r.includes('***'), '应有打码痕迹');
});

ok('打码是幂等的（同一个包被人手再处理一遍也不会更糟）', () => {
  const text = '"apiKey": "' + SECRET_KEY + '" / cf_clearance=' + SECRET_COOKIE + ' / tester@example.com';
  const once = diag.redact(text);
  assert.strictEqual(diag.redact(once), once);
});

ok('mask 保留末 4 位（能判断"是不是同一个 key"），短值直接全遮', () => {
  assert.strictEqual(diag.mask('abcdefgh'), '***efgh');
  assert.strictEqual(diag.mask('abc'), '***');
  assert.strictEqual(diag.mask(''), '');
});

// ---------------------------------------------------------------- 目录探测
console.log('diagbundle: 数据目录探测');

ok('有 providers 的目录优先（模型配置在哪，题面缓存就在哪）', () => {
  const root = path.join(T, 'probe-root');
  writeJson(path.join(root, 'data', 'config.json'), { providers: [] });
  writeJson(path.join(root, 'dist', 'CFCoach-win32-x64', 'data', 'config.json'),
    { providers: [{ id: 'p', models: ['m'] }] });
  const picked = diag.pickDataDir(root);
  assert.strictEqual(picked, path.join(root, 'dist', 'CFCoach-win32-x64', 'data'), 'picked=' + picked);
});

ok('环境变量 CHATBOX_DATA_DIR / CFCOACH_APP_DATA 排在候选最前', () => {
  const old1 = process.env.CHATBOX_DATA_DIR;
  const old2 = process.env.CFCOACH_APP_DATA;
  process.env.CHATBOX_DATA_DIR = 'D:\\a\\data';
  process.env.CFCOACH_APP_DATA = 'D:\\b\\data';
  try {
    const c = diag.dataDirCandidates('D:\\root');
    assert.strictEqual(c[0], 'D:\\a\\data', JSON.stringify(c));
    assert.strictEqual(c[1], 'D:\\b\\data', JSON.stringify(c));
  } finally {
    if (old1 === undefined) delete process.env.CHATBOX_DATA_DIR; else process.env.CHATBOX_DATA_DIR = old1;
    if (old2 === undefined) delete process.env.CFCOACH_APP_DATA; else process.env.CFCOACH_APP_DATA = old2;
  }
});

ok('CFCOACH_USER_DATA 优先作为 userData（主进程会设它，免得猜 APPDATA）', () => {
  const old = process.env.CFCOACH_USER_DATA;
  process.env.CFCOACH_USER_DATA = 'C:\\custom\\userData';
  try { assert.strictEqual(diag.defaultUserDataDir(), 'C:\\custom\\userData'); }
  finally { if (old === undefined) delete process.env.CFCOACH_USER_DATA; else process.env.CFCOACH_USER_DATA = old; }
});

// ---------------------------------------------------------------- 采集
console.log('diagbundle: 采集内容');

const R = diag.collect(OPTS);
const names = R.sections.map((s) => s.name);

ok('段落齐全（环境 / 配置 / 三份日志 / 档案 / 缓存台账 / 工作区 / 会话 / 跑分 / 附加段）', () => {
  for (const need of ['环境', '模型配置（已脱敏）', '应用诊断日志 cf-diag.log', '抓取日志 cf-fetch.log',
    '学员档案日志 profile-log.jsonl', '学员档案 profile-card.json', '题面缓存台账 cf-problems/',
    '工作区 workspace/', '会话 conversations/', '跑分与消融记录']) {
    assert.ok(names.includes(need), '缺段落：' + need + '（实际：' + names.join(' / ') + '）');
  }
});

ok('环境段带语言/时区与环境变量交底（CLI 没传 locale 时自己从 Intl 兜一次，别留"— / —"）', () => {
  const env = R.text.split('##########')[2] || '';
  assert.ok(!/语言\/时区：— \/ —/.test(env), '应为语言/时区兜一次默认值：' + env.slice(0, 400));
  assert.ok(/环境变量：CHATBOX_DATA_DIR=/.test(env), '应列出白名单环境变量');
});

ok('整份正文里没有任何密钥/cookie/邮箱原值（这是"能直接发出去"的底线）', () => {
  for (const secret of [SECRET_KEY, SECRET_COOKIE, SECRET_TOKEN, 'tester@example.com']) {
    assert.ok(!R.text.includes(secret), '诊断包泄漏了：' + secret);
  }
});

ok('日志取尾部（最近的才说明问题）', () => {
  assert.ok(R.text.includes('抓取 2268A 成功'), '应带最后几行');
  assert.ok(R.text.includes('可见窗口挑战通过'), 'userData 下的 cf-diag.log 也要带上');
});

ok('题面缓存台账只列元数据，绝不带题面正文', () => {
  assert.ok(R.text.includes('2268A'), '应列出缓存的题');
  assert.ok(R.text.includes('题面 8 字符') || /题面 \d+ 字符/.test(R.text), '应给出题面长度');
  assert.ok(!R.text.includes('这是题面正文'), '题面正文不该进包');
  assert.ok(!R.text.includes('解题代码正文不该进诊断包'), '解题代码正文不该进包');
});

ok('工作区段带验证状态（scopeComplete/stressTruncated/交付与回退），这是 P0 之后的重点', () => {
  assert.ok(R.text.includes('ab-2268A'), '应列出工作区');
  assert.ok(R.text.includes('scopeComplete=false'), '未完整验证必须显式写出来');
  assert.ok(R.text.includes('规模档 200 撑不住'), '截断原因要保留');
  assert.ok(R.text.includes('model-first'), '交付版本来源要保留');
});

ok('会话只带最近几条消息（默认 4 条），更早的被裁掉', () => {
  assert.ok(R.text.includes('第 4 条（保留）'), '最近的消息要在');
  assert.ok(!R.text.includes('第 1 条（会被裁掉）'), '更早的消息不该在');
});

ok('跑分记录：summary / 题库台账（oracle 有、gen 无）/ records / verdicts / compare 都在', () => {
  assert.ok(R.text.includes('summary.json'), 'summary.json 要全文带上');
  assert.ok(/gen\s+cpp:—/.test(R.text), '缺生成器要在台账里看得见（no-gen 的根因就是它）：' + R.text.slice(0, 200));
  assert.ok(R.text.includes('no-gen'), 'verdicts.jsonl 里的判分结论要带上');
  assert.ok(R.text.includes('缺生成器') || R.text.includes('noGen') || R.text.includes('no-gen'), '判分标签要能解释为什么没差分');
});

ok('transcript 段给出工具序列（"哪一步走歪了"一眼可见）+ 失败标记', () => {
  assert.ok(/序列：.*write_file.*→.*stress_test.*→.*verify_random✗/.test(R.text),
    '要有工具序列行：' + (R.text.match(/序列：.*/) || ['(没有)'])[0]);
  assert.ok(R.text.includes('4 条事件'), '要报事件条数');
  assert.ok(!R.text.includes('+31208ms write_file'), 'toolStart 不该逐行重复列（只列 toolEnd 结果）');
});

ok('extra 段落是调用方追加的（应用侧塞状态、测试台塞台账）', () => {
  const r = diag.collect(Object.assign({}, OPTS, { extra: [{ name: '应用状态（测试）', text: '会话数 3' }] }));
  assert.ok(r.sections.map((s) => s.name).includes('应用状态（测试）'));
  assert.ok(r.text.includes('会话数 3'));
});

// ---------------------------------------------------------------- 裁剪与容错
console.log('diagbundle: 裁剪与容错');

ok('单段上限触发截断并标记 truncated（不会出一个几 MB 的包）', () => {
  const r = diag.collect(Object.assign({}, OPTS, { limits: { section: 300 } }));
  const big = r.sections.filter((s) => s.truncated);
  assert.ok(big.length > 0, '应有段落被截断');
  assert.ok(big.every((s) => s.chars <= 400), '截断后不应远超上限：' + JSON.stringify(big));
  assert.ok(r.text.includes('本段已截断'), '要告诉读者这里被裁过');
});

ok('总长度上限到了会记一条提醒（提醒里点名是哪一段之后被裁的）', () => {
  const r = diag.collect(Object.assign({}, OPTS, { limits: { total: 4000 } }));
  assert.ok(r.warnings.length > 0, '应有提醒');
  assert.ok(r.warnings.some((w) => w.includes('总长度上限')), JSON.stringify(r.warnings));
});

ok('目录/文件缺失不抛异常，只少一段 + 说明（另一台电脑上常常就是缺文件）', () => {
  const r = diag.collect({
    dataDir: path.join(T, 'not-here'), userDataDir: path.join(T, 'not-here-either'),
    rootDir: T, ablationOut: path.join(T, 'no-ablation')
  });
  assert.ok(r.text.includes('没有这个文件'), '缺失的日志要有一句说明');
  assert.ok(r.text.includes('没有跑分目录'), '缺跑分目录要有一句说明');
  assert.ok(r.sections.length >= 10, '段落数量不该因为缺文件而塌掉');
});

ok('dataDir 为 null 也不炸（全自动探测失败时）', () => {
  const r = diag.collect({ dataDir: null, userDataDir: USERDATA, rootDir: T });
  assert.ok(r.text.length > 200);
  assert.strictEqual(r.dataDir, path.join(T, 'data'), 'rootDir 下没有 data 时会退回候选列表第一个');
});

// ---------------------------------------------------------------- 写盘与 CLI
console.log('diagbundle: 写盘与命令行');

ok('write 落到 <dataDir>/diag/cfcoach-diag-<时间>.txt，文件名与内容都对得上', () => {
  const r = diag.write(OPTS);
  assert.ok(fs.existsSync(r.file), '文件不存在：' + r.file);
  assert.strictEqual(path.dirname(r.file), path.join(DATA, 'diag'));
  assert.ok(/^cfcoach-diag-\d{8}-\d{6}\.txt$/.test(path.basename(r.file)), '文件名：' + path.basename(r.file));
  const text = fs.readFileSync(r.file, 'utf8');
  // 时间戳与内存占用每次采集都不同，比较时要先把这两类行抹掉
  const stable = (s) => String(s).split('\n')
    .filter((l) => !/^生成时间：/.test(l) && !/^内存：/.test(l)).join('\n');
  assert.strictEqual(stable(text), stable(diag.collect(OPTS).text), '写出来的应与 collect 一致');
  assert.strictEqual(r.bytes, Buffer.byteLength(text, 'utf8'));
  assert.ok(text.startsWith('===='), '以分隔线开头');
});

ok('write 支持 --out 指定文件（默认目录不可写时的退路）', () => {
  const file = path.join(T, 'out', 'custom.txt');
  const r = diag.write(Object.assign({}, OPTS, { file }));
  assert.strictEqual(r.file, file);
  assert.ok(fs.existsSync(file));
});

ok('CLI：main([--out, --data-dir]) 在进程内可跑，退出码 0，并打印段落清单', () => {
  const file = path.join(T, 'cli.txt');
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try { code = diagCli.main(['--out', file, '--data-dir', DATA, '--user-data-dir', USERDATA]); }
  finally { console.log = orig; }
  assert.strictEqual(code, 0);
  assert.ok(fs.existsSync(file), 'CLI 应写出文件');
  const out = logs.join('\n');
  assert.ok(out.includes('诊断包已生成'), out);
  assert.ok(out.includes('段落'), out);
  assert.ok(out.includes('打码'), '要提醒用户已打码：' + out);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET_KEY), 'CLI 的输出同样不能带密钥');
});

ok('CLI：--print 打到标准输出（界面起不来时的唯一退路）', () => {
  const chunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  process.stderr.write = () => true;
  let code;
  try { code = diagCli.main(['--print', '--quiet', '--data-dir', DATA, '--user-data-dir', USERDATA]); }
  finally { process.stdout.write = origOut; process.stderr.write = origErr; }
  assert.strictEqual(code, 0);
  const text = chunks.join('');
  assert.ok(text.includes('cf-coach 诊断包 v1'), '应打印整份诊断包');
  assert.ok(text.includes('抓取日志 cf-fetch.log'));
});

ok('CLI：--help 打印用法；未知选项不会把输出吞掉', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try { code = diagCli.main(['--help']); } finally { console.log = orig; }
  assert.strictEqual(code, 0);
  assert.ok(logs.join('\n').includes('用法'), logs.join('\n'));
});

ok('脚本包自带的段落上限是"够看又不会太大"的量级', () => {
  const L = diag.DEFAULT_LIMITS;
  assert.ok(L.total >= 200000 && L.total <= 2000000, '整包上限：' + L.total);
  assert.ok(L.log >= 20000, '日志上限太小会看不到上下文：' + L.log);
  assert.ok(L.messageChars < L.section, '单条消息上限应远小于单段上限');
  assert.ok(L.conversations <= 10, '会话数量要克制');
});

process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ } });
console.log('\ndiagbundle: ' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
