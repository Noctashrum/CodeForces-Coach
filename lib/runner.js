/**
 * lib/runner.js — 本地代码运行器（对拍验证 / 样例测试）
 * 支持 C++(g++) / Python / JavaScript(Node) 三种语言。
 * 子进程 stdio 直接绑定文件句柄（不经 shell 重定向、不依赖 stdio 管道），
 * 超时用 taskkill 强制杀进程树。
 * 注意：仅用于运行模型生成的验证代码；本运行器只做超时控制，不做系统级资源隔离。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sandbox = require('./sandbox');

/* ---------------- 代码沙箱（缓解措施；可在设置里关闭） ---------------- */

let sandboxCfg = { enabled: true, allowNetwork: false };

/** 由 server.js 注入用户设置 */
function setSandbox(cfg) {
  sandboxCfg = Object.assign({}, sandboxCfg, cfg || {});
}
function sandboxStatus() {
  return {
    enabled: !!sandboxCfg.enabled,
    allowNetwork: !!sandboxCfg.allowNetwork,
    python: sandbox.available('python'),
    js: sandbox.available('js'),
    cpp: false,
    note: sandbox.describe()
  };
}
/** 为某个通道准备 env / 解释器参数（失败时退回不加限制，绝不让守卫本身把程序跑挂） */
function sandboxFor(kind, dir) {
  try {
    return sandbox.prepare(kind, { dir, enabled: sandboxCfg.enabled, allowNetwork: sandboxCfg.allowNetwork });
  } catch (e) {
    return { env: process.env };
  }
}

const RUN_TIMEOUT_MS = 5000;      // 单次运行默认超时
/**
 * 暴力解（对拍标尺）专用的宽松超时。
 *
 * 为什么必须单独给：暴力解**按设计就是慢的**（"不要聪明，只要正确"），
 * 却一直被按题解的标准（5 秒）掐表 —— 于是出现"暴力解在最小规模档就超时"这种判词，
 * 接着整条链被判 no-bruler / 重写好几轮。真实反馈："为什么暴力解还是超时。"
 * 标尺慢一点完全可以接受（对拍可以等），**判错才是灾难**。
 */
const BRUTE_TIMEOUT_MS = 20000;
const OUTPUT_CAP = 4000;          // 传给模型的输出截断上限
const COMPILE_TIMEOUT_MS = 30000;

/**
 * 把"没给/给了非法值"的超时统一成内置默认值。
 *
 * ⚠️ 真实事故（朋友的机器上，用户截图）：`cf_run` 的 `timeoutMs` 没给时，
 * tools.js 传下来的是 **0**，而 `setTimeout(..., 0)` 会在下一个 tick 立刻 taskkill ——
 * 于是任何程序都在 130ms 左右被判 **TLE**，工具还照着文案补一句
 * 「⚠ 超时——这就是 TLE 的直接证据」。模型信了，转身去翻工作区找"为什么超时"，
 * 一口气把 12 步预算烧光（截图里 24 次调用），最后连讲解都没写。
 * 多一层兜底：0 / 负数 / 非数字 / NaN 一律视为"用内置值"。
 */
function normTimeLimit(ms) {
  const n = Number(ms);
  return (Number.isFinite(n) && n > 0) ? n : RUN_TIMEOUT_MS;
}

/**
 * 依据**本机实际可用的运行时**挑一门语言。
 *
 * 为什么必须在代码里兜、而不能只靠提示词：`cf_verify` 的 lang 描述是「cpp（默认）| python」，
 * 于是模型在**只有 Python、没有 g++** 的机器上照样按默认交 C++，验证链第一步就编译失败
 * （真实事故：朋友机器无 g++ → NO-BRULER，一遍遍地重跑却永远跑不通）。
 * 模型说想要哪门语言是"意图"，本机有什么是"事实"——事实优先，然后把降级如实说出来。
 *
 * @param {string} requested 期望语言（cpp/python/js）
 * @param {{cpp:boolean,python:boolean,js:boolean}} flags 探测到的可用运行时
 * @returns {{lang:string, changed:boolean, requested:string, unavailable:boolean, flags:object}}
 */
function pickLang(requested, flags) {
  const want = (requested === 'python' || requested === 'js') ? requested : 'cpp';
  /**
   * 没注入运行时探测结果时（单测 / 老调用方）**一律当"都可用"**：保持改造前的行为，
   * 绝不能因为"没有探测信息"就把用户判成"本机什么都跑不了"而拒绝跑验证链。
   */
  if (!flags) return { lang: want, changed: false, requested: want, unavailable: false, flags: { cpp: true, python: true, js: true } };
  const avail = {
    cpp: !!(flags && flags.cpp),
    python: !!(flags && flags.python),
    js: !!(flags && flags.js)
  };
  if (avail[want]) return { lang: want, changed: false, requested: want, unavailable: false, flags: avail };
  // 一个都没有：如实报告"无可运行环境"，绝不假装跑过
  if (!avail.cpp && !avail.python && !avail.js) {
    return { lang: want, changed: false, requested: want, unavailable: true, flags: avail };
  }
  // 退到 Python（题解/暴力解最容易写对的一门），其次 C++，最后 Node
  for (const cand of ['python', 'cpp', 'js']) {
    if (avail[cand]) return { lang: cand, changed: true, requested: want, unavailable: false, flags: avail };
  }
  return { lang: want, changed: false, requested: want, unavailable: true, flags: avail };
}

function detectRuntime(kind) {
  const cmds = { cpp: 'g++', python: 'python', js: 'node' };
  const cmd = cmds[kind];
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          try { child.kill(); } catch (e) { /* ignore */ }
          resolve(false);
        }
      }, 5000);
      child.on('error', () => {
        if (!done) { done = true; clearTimeout(timer); resolve(false); }
      });
      child.on('exit', (code) => {
        if (!done) { done = true; clearTimeout(timer); resolve(code === 0); }
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function truncate(s, cap) {
  s = String(s == null ? '' : s);
  return s.length > cap ? s.slice(0, cap) + '\n…(已截断，共 ' + s.length + ' 字符)' : s;
}

/** 输出规范化：去行尾空格、去尾部空行（**仅用于展示**，判定请用 compareOutputs） */
function normalizeOutput(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
    .trim();
}

/**
 * 输出判定：**先归一化，再判等**。
 *
 * 为什么不能直接比字符串：这会制造大量**假失败**，而且是"对方明明没错"的那种：
 *   ① 格式差异：`YES` vs `Yes`、`1 2 3` vs 三行、行尾空格/末尾空行 —— 算对了，只是不像；
 *   ② 浮点精度：题面要求 1e-6，它给 0.1234567890，官方是 0.1234567 —— 等值比对必 WA；
 *   ③ 多解题：题面说"输出任意一个合法方案"，它给方案 A、官方是方案 B —— 两边都对，等值必 WA（③另有处理）。
 * 这类"失败"如果当成逻辑错去让模型重写，它每次都"没错"，于是无限重试 ——
 * 真实反馈："它不是降智了，是你的判据在制造假失败。"
 *
 * 判据：拆成 token 流比对（忽略空白布局），数值按 eps 比较，字符串忽略大小写。
 * 返回 kind 便于**给失败分类**（格式类 → 便宜处理；真差异 → 才值得重写）：
 *   'same' 完全一致｜'layout' 只差空白布局｜'case' 只差大小写｜'precision' 只差浮点尾数｜'different' 真的不一样
 */
function compareOutputs(actual, expected) {
  const a = String(actual == null ? '' : actual);
  const e = String(expected == null ? '' : expected);
  if (normalizeOutput(a) === normalizeOutput(e)) return { ok: true, kind: 'same' };
  const at = a.trim().split(/\s+/).filter(Boolean);
  const et = e.trim().split(/\s+/).filter(Boolean);
  if (at.length !== et.length) return { ok: false, kind: 'different', detail: 'token 数不同（' + at.length + ' vs ' + et.length + '）' };
  let caseOnly = false;
  let numeric = 0;
  let numericWithinEps = 0;
  for (let i = 0; i < et.length; i++) {
    if (at[i] === et[i]) continue;
    const an = Number(at[i]);
    const en = Number(et[i]);
    if (Number.isFinite(an) && Number.isFinite(en)) {
      numeric++;
      const eps = Math.max(1e-6, Math.abs(en) * 1e-6);
      if (Math.abs(an - en) <= eps) { numericWithinEps++; continue; }
      return { ok: false, kind: 'different', detail: '第 ' + (i + 1) + ' 个数差得超出 1e-6（' + at[i] + ' vs ' + et[i] + '）' };
    }
    if (at[i].toLowerCase() === et[i].toLowerCase()) { caseOnly = true; continue; }
    return { ok: false, kind: 'different', detail: '第 ' + (i + 1) + ' 个 token 不同' };
  }
  if (numeric && numericWithinEps === numeric) return { ok: true, kind: 'precision' };
  if (caseOnly) return { ok: true, kind: 'case' };
  return { ok: true, kind: 'layout' };   // token 全等，只是换行/空格布局不同
}

function makeWorkDir(tag) {
  const dir = path.join(os.tmpdir(), 'chatbox-run-' + tag + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 运行程序：stdin/stdout/stderr 直接绑定本地文件句柄（无 shell、无管道）
 *
 * 每次调用用**独立的临时文件名**（run-<序号>-<随机>.in/out/err）：
 * 并发跑两个程序时如果共用 run.in/run.out，会互相覆盖输入与输出 ——
 * 并行对拍（题解与暴力解同时跑）正是靠这一点才安全。
 * @returns { ok, timedOut, exitCode, output, err, timeMs }
 */
let runSeq = 0;
function runProgram(spec, dir, input, timeLimitMs) {
  const program = typeof spec === 'string' ? spec : spec.program;
  const rawArgs = typeof spec === 'string' ? [] : (spec.args || []);
  const kind = typeof spec === 'string' ? '' : (spec.kind || '');
  const tag = (++runSeq) + '-' + crypto.randomBytes(3).toString('hex');
  return new Promise((resolve) => {
    const pre = kind ? sandboxFor(kind, dir) : { env: process.env };
    const args = (pre.args || []).concat(rawArgs);
    const env = Object.assign({}, pre.env);
    // Python 的报错/输出走 UTF-8，避免中文错误信息被控制台代码页搞成乱码（模型要读这些信息）
    if (kind === 'python') env.PYTHONIOENCODING = 'utf-8';
    const inFile = path.join(dir, 'run-' + tag + '.in');
    const outFile = path.join(dir, 'run-' + tag + '.out');
    const errFile = path.join(dir, 'run-' + tag + '.err');
    fs.writeFileSync(inFile, String(input == null ? '' : input), 'utf8');
    let inFd, outFd, errFd;
    try {
      inFd = fs.openSync(inFile, 'r');
      outFd = fs.openSync(outFile, 'w');
      errFd = fs.openSync(errFile, 'w');
    } catch (e) {
      resolve({ ok: false, timedOut: false, exitCode: null, output: '', err: '无法创建运行文件: ' + e.message, timeMs: 0 });
      return;
    }
    const start = Date.now();
    // ⚠️ 必须用 normTimeLimit：0 会被 setTimeout 当成"立刻超时"，把任何程序都判成 TLE
    const limit = normTimeLimit(timeLimitMs);
    let timedOut = false;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(inFd); } catch (e) { /* ignore */ }
      try { fs.closeSync(outFd); } catch (e) { /* ignore */ }
      try { fs.closeSync(errFd); } catch (e) { /* ignore */ }
      resolve(r);
    };
    let child;
    try {
      child = spawn(program, args, { cwd: dir, stdio: [inFd, outFd, errFd], env, windowsHide: true });
    } catch (e) {
      finish({ ok: false, timedOut: false, exitCode: null, output: '', err: '无法启动进程: ' + e.message, timeMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch (e) { /* ignore */ }
    }, limit);
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, timedOut, exitCode: null, output: '', err: '启动失败: ' + e.message, timeMs: Date.now() - start });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const timeMs = Date.now() - start;
      let output = '', err = '';
      try { output = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* ignore */ }
      try { err = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* ignore */ }
      // 用完即删：并发对拍会产生很多组临时文件，别把它们堆在竞技场目录里
      [inFile, outFile, errFile].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
      finish({ ok: !timedOut && code === 0, timedOut, exitCode: code, output, err, timeMs });
    });
  });
}

/** 编译 C++：stderr 绑定文件句柄；返回 null 表示成功，否则错误文本 */
function compileCpp(dir, base) {
  return new Promise((resolve) => {
    const src = path.join(dir, base + '.cpp');
    const out = path.join(dir, base + '.exe');
    const errFile = path.join(dir, base + '.cerr');
    let errFd;
    try {
      errFd = fs.openSync(errFile, 'w');
    } catch (e) {
      resolve('无法创建编译错误文件: ' + e.message);
      return;
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(errFd); } catch (e) { /* ignore */ }
      resolve(v);
    };
    let child;
    try {
      child = spawn('g++', ['-O2', '-std=c++23', '-o', out, src], { cwd: dir, stdio: ['ignore', 'ignore', errFd], windowsHide: true });
    } catch (e) {
      finish('无法启动 g++: ' + e.message);
      return;
    }
    const timer = setTimeout(() => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch (e) { /* ignore */ }
    }, COMPILE_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      finish('g++ 启动失败: ' + e.message);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(out)) {
        finish(null);
      } else {
        let err = '编译失败（退出码 ' + code + '）';
        try { err += '\n' + truncate(fs.readFileSync(errFile, 'utf8'), 1500); } catch (e) { /* ignore */ }
        finish(err);
      }
    });
  });
}

function codeFileName(kind, base) {
  if (kind === 'cpp') return base + '.cpp';
  if (kind === 'python') return base + '.py';
  return base + '.js';
}

function programSpec(kind, dir, base, extraArgs) {
  const extra = Array.isArray(extraArgs) ? extraArgs : [];
  if (kind === 'cpp') return { program: path.join(dir, base + '.exe'), args: extra, kind };
  if (kind === 'python') return { program: 'python', args: [path.join(dir, base + '.py')].concat(extra), kind };
  return { program: 'node', args: [path.join(dir, base + '.js')].concat(extra), kind };
}

/** 准备一段代码：写文件 + （C++）编译；返回 { ok, error, spec } */
async function prepare(kind, code, dir, base) {
  if (!code || !String(code).trim()) return { ok: false, error: '代码为空' };
  const file = path.join(dir, codeFileName(kind, base));
  fs.writeFileSync(file, String(code), 'utf8');
  if (kind === 'cpp') {
    const cerr = await compileCpp(dir, base);
    if (cerr) return { ok: false, error: cerr };
  }
  return { ok: true, error: null, spec: programSpec(kind, dir, base) };
}

/**
 * 样例测试：对官方样例逐个运行代码
 * samples: [{input, output}]（output 为 null 时只运行不比较）
 */
async function runSamples(opts) {
  const { lang = 'cpp', code, samples = [] } = opts;
  // 0 / 非法值一律回落到内置默认值（见 normTimeLimit 的说明：0 会变成"立刻 TLE"）
  const timeLimitMs = normTimeLimit(opts.timeLimitMs);
  if (!Array.isArray(samples) || !samples.length) return { ok: false, error: '当前题目没有可用样例' };
  const dir = makeWorkDir('sample');
  try {
    const prep = await prepare(lang, code, dir, 'sol');
    if (!prep.ok) return { ok: false, error: prep.error };
    const results = [];
    let formatDiff = '';   // 等价但形态不同时的类型（layout/case/precision）：用于给上层**准确的格式反馈**
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.input == null) continue;
      const r = await runProgram(prep.spec, dir, s.input, timeLimitMs);
      let verdict;
      let kind = 'same';
      if (r.timedOut) verdict = 'TLE';
      else if (!r.ok) verdict = 'RE';
      else if (s.output == null) verdict = 'OK';
      else {
        const cmp = compareOutputs(r.output, s.output);
        verdict = cmp.ok ? 'AC' : 'WA';
        kind = cmp.kind;
        // 等价但形态不同（空白布局/大小写/浮点尾数）→ 不算错，但记下来，方便上层给出准确的格式反馈
        if (cmp.ok && cmp.kind !== 'same') formatDiff = cmp.kind;
      }
      results.push({
        index: i + 1,
        verdict,
        kind,
        timeMs: r.timeMs,
        input: truncate(s.input, 500),
        expected: s.output == null ? null : truncate(s.output, 1200),
        actual: truncate(r.output, 1200),
        err: r.timedOut ? '运行超时（>' + timeLimitMs + 'ms）' : (r.ok ? '' : truncate(r.err, 800))
      });
    }
    const allPass = results.every((r) => r.verdict === 'AC' || r.verdict === 'OK');
    // formatDiff：本次虽然全过，但存在**等价而形态不同**的地方（空白/大小写/浮点尾数）。
    // 交给上层做两件事：① 给模型准确的格式反馈（不说"你错了"）；② 如果是标尺（暴力解）就顺手机械修一下。
    return { ok: true, allPass, results, formatDiff };
  } finally {
    cleanupDir(dir);
  }
}

/**
 * 暴力对拍：gen 生成随机小数据 → brute 出标准答案 → solution 出结果 → 对比
 * 参数：solution/brute/gen = { lang, code }；iterations 默认 60
 */
async function stressTest(opts) {
  const { solution, brute, gen, iterations = 60, timeLimitMs = RUN_TIMEOUT_MS, maxTotalMs = 180000 } = opts;
  for (const [name, part] of [['solution', solution], ['brute', brute], ['gen', gen]]) {
    if (!part || !part.code || !String(part.code).trim()) return { ok: false, error: '缺少 ' + name + ' 代码' };
  }
  const n = Math.max(1, Math.min(parseInt(iterations, 10) || 60, 500));
  const dir = makeWorkDir('stress');
  const startTotal = Date.now();
  try {
    const prepSol = await prepare(solution.lang || 'cpp', solution.code, dir, 'sol');
    if (!prepSol.ok) return { ok: false, error: '正解 ' + prepSol.error };
    const prepBrute = await prepare(brute.lang || 'cpp', brute.code, dir, 'brute');
    if (!prepBrute.ok) return { ok: false, error: '暴力 ' + prepBrute.error };
    const prepGen = await prepare(gen.lang || 'cpp', gen.code, dir, 'gen');
    if (!prepGen.ok) return { ok: false, error: '生成器 ' + prepGen.error };

    let totalRunMs = 0;
    for (let i = 1; i <= n; i++) {
      if (Date.now() - startTotal > maxTotalMs) {
        return { ok: true, status: 'ok', iterations: i - 1, note: '已达总时长上限，提前结束（前 ' + (i - 1) + ' 组全部通过）' };
      }
      const gi = await runProgram(prepGen.spec, dir, '', timeLimitMs);
      if (gi.timedOut) return { ok: true, status: 'error', which: 'generator', detail: '生成器第 ' + i + ' 组超时' };
      if (!gi.ok) return { ok: true, status: 'error', which: 'generator', detail: '生成器第 ' + i + ' 组运行失败：' + truncate(gi.err, 500) };
      const input = gi.output;

      const bi = await runProgram(prepBrute.spec, dir, input, timeLimitMs);
      if (bi.timedOut) return { ok: true, status: 'error', which: 'brute', detail: '暴力解第 ' + i + ' 组超时', input: truncate(input, 1500) };
      if (!bi.ok) return { ok: true, status: 'error', which: 'brute', detail: '暴力解第 ' + i + ' 组运行失败：' + truncate(bi.err, 500), input: truncate(input, 1500) };

      const si = await runProgram(prepSol.spec, dir, input, timeLimitMs);
      if (si.timedOut) return { ok: true, status: 'error', which: 'solution', detail: '正解第 ' + i + ' 组超时（>' + timeLimitMs + 'ms）', input: truncate(input, 1500) };
      if (!si.ok) return { ok: true, status: 'error', which: 'solution', detail: '正解第 ' + i + ' 组运行失败：' + truncate(si.err, 500), input: truncate(input, 1500) };

      totalRunMs += si.timeMs;
      if (!compareOutputs(bi.output, si.output).ok) {
        return {
          ok: true,
          status: 'mismatch',
          iteration: i,
          input: truncate(input, 1500),
          expected: truncate(bi.output, 1500),
          actual: truncate(si.output, 1500)
        };
      }
    }
    return { ok: true, status: 'ok', iterations: n, avgSolutionMs: Math.round(totalRunMs / n) };
  } finally {
    cleanupDir(dir);
  }
}

/** 检测本机可用的运行环境（供前端/工具提示用） */
async function availableRuntimes() {
  /**
   * 诊断开关（也是回归夹具）：`CFCOACH_FAKE_RUNTIMES=none|python|cpp,js`
   * 线上事故复盘：朋友的电脑没有 g++/python —— 验证链空转、模型反复重试、最后什么都没交付。
   * 那台机器的环境在开发机上复现不了，所以给一个显式开关，让"没有编译器的机器"这条路
   * 在任何机器上都能被真的跑一遍（探针 .probe/probe-no-runtime.js 用它）。
   */
  const fake = process.env.CFCOACH_FAKE_RUNTIMES;
  if (fake && String(fake).trim()) {
    const want = String(fake).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const none = want.includes('none');
    return {
      cpp: !none && want.includes('cpp'),
      python: !none && want.includes('python'),
      js: !none && want.includes('js')
    };
  }
  const [cpp, python, js] = await Promise.all([detectRuntime('cpp'), detectRuntime('python'), detectRuntime('js')]);
  return { cpp, python, js };
}

/* ---------------- 工作区文件版（教练 harness 用） ---------------- */

function readCodeFile(file) {
  const code = fs.readFileSync(file, 'utf8');
  if (!code.trim()) throw new Error('文件为空：' + path.basename(file));
  return code;
}

/** 按文件跑官方样例：{ file, lang, samples } */
async function runSamplesFile(opts) {
  const { file, lang, samples, timeLimitMs } = opts || {};
  return runSamples({ lang, code: readCodeFile(file), samples, timeLimitMs });
}

/**
 * 完整对拍 harness：先验证暴力解本身（过官方样例），再用生成器批量攻击题解。
 * 这是教练的标准验证流程，参数都是工作区文件路径：
 *   { solFile, bruteFile, genFile, solLang, bruteLang, genLang, samples, iterations }
 * 返回 status：
 *   brute-failed  暴力解没过官方样例（先用 results 修暴力解，不要开始对拍）
 *   mismatch      找到反例（input/expected/actual 已给出，并写入 fail.txt）
 *   ok            全部通过
 *   error         编译/运行/超时错误（which 指明是哪一段）
 */
async function stressByFiles(opts) {
  const o = opts || {};
  const iterations = Math.max(1, Math.min(parseInt(o.iterations, 10) || 300, 2000));
  const solLang = o.solLang || 'cpp';
  const bruteLang = o.bruteLang || solLang;
  const genLang = o.genLang || 'python';

  // 阶段 1：暴力解先自证（样例必须全过），避免拿错解当标尺
  let bruteSamples = null;
  const sampleList = (o.samples || []).filter((s) => s && s.input != null);
  if (sampleList.length) {
    bruteSamples = await runSamples({ lang: bruteLang, code: readCodeFile(o.bruteFile), samples: sampleList });
    if (!bruteSamples.ok) return { ok: true, status: 'error', which: 'brute', detail: bruteSamples.error };
    if (!bruteSamples.allPass) {
      return {
        ok: true, status: 'brute-failed', stage: 'brute-samples',
        detail: '暴力解未通过官方样例，先修正它（此时对拍没有意义）',
        results: bruteSamples.results
      };
    }
  }

  // 阶段 2：生成器产数据 → 暴力解当标尺 → 与题解逐组比对
  const r = await stressTest({
    solution: { lang: solLang, code: readCodeFile(o.solFile) },
    brute: { lang: bruteLang, code: readCodeFile(o.bruteFile) },
    gen: { lang: genLang, code: readCodeFile(o.genFile) },
    iterations,
    maxTotalMs: o.maxTotalMs || 180000
  });
  return Object.assign({
    stage: 'stress',
    bruteSamples: bruteSamples ? { allPass: true, count: bruteSamples.results.length } : null
  }, r);
}

/* ---------------- 常驻竞技场：一次编译、多次对拍（多 Agent harness 用） ---------------- */

/**
 * 规模阶梯：生成器统一接受一个「规模上限」参数（argv[1]），编排器按阶梯传值。
 * 这样做的好处是不破坏隔离——gen 不需要知道 brute 的复杂度，
 * 由运行器根据 brute 是否 TLE/RE 自动降档，尺度协商交给代码而不是模型。
 */
const SIZE_LADDER = [8, 20, 50, 200, 1000];

/**
 * 准备一个常驻竞技场：把多份代码编译/落地在一个临时目录里，之后可以反复跑，
 * 避免每个阶段重复编译（C++ 编译一次约几百毫秒，对拍循环里很贵）。
 *
 * parts: { sol: {lang, code}, brute: {lang, code}, gen: {lang, code}, user: {lang, code} }
 * @returns { ok, error, dir, run, genCase, compare, runSamples, minimize, close }
 */
async function openArena(parts, arenaOpts) {
  const dir = makeWorkDir('arena');
  // 标尺超时可被调用方压制（测试要快速造出 TLE 场景；生产用 BRUTE_TIMEOUT_MS 的宽松值）
  const bruteTimeout = (arenaOpts && arenaOpts.bruteTimeoutMs) || BRUTE_TIMEOUT_MS;
  const specs = {};
  for (const key of Object.keys(parts || {})) {
    const part = parts[key];
    if (!part || !String(part.code || '').trim()) continue;
    const prep = await prepare(part.lang || 'cpp', part.code, dir, key);
    if (!prep.ok) {
      cleanupDir(dir);
      return { ok: false, error: key + '：' + prep.error, dir: null };
    }
    specs[key] = prep.spec;
  }
  if (!specs.sol) { cleanupDir(dir); return { ok: false, error: '缺少题解代码' }; }

  /** 跑某个程序一次 */
  async function run(key, input, timeLimitMs) {
    const spec = specs[key];
    if (!spec) return { ok: false, err: '没有这个程序：' + key, output: '', timedOut: false, timeMs: 0 };
    return runProgram(spec, dir, input, timeLimitMs || RUN_TIMEOUT_MS);
  }

  /**
   * 让生成器产一组数据（tier = 规模上限、valueCap = 数值上限，经 argv[1]/argv[2] 传给生成器）。
   *
   * ⚠️ 这里**绝对不能改生成器的输出**。曾经试过"机械把大数值缩放成小数值"（clampValues），
   * 结果把**二进制串字段**（如 `00100010`）当成数字改写成了 `16` —— 数据被悄悄改坏，
   * 仲裁看到"字符串长度与 n 不符"就判生成器有罪，于是白白重写生成器 3 次、整轮 unverified。
   * 结论：没有格式解析器就无法安全地改数据；数值范围只能靠"把上限告诉生成器 + 机械检测超限"解决。
   */
  async function genCase(tier, timeLimitMs, valueCap) {
    if (!specs.gen) return { ok: false, err: '缺少生成器', input: '', timedOut: false };
    const spec = specs.gen;
    const n = (tier == null ? SIZE_LADDER[0] : tier);
    const args = [String(n)];
    if (valueCap != null) args.push(String(valueCap));
    const withTier = { program: spec.program, args: spec.args.concat(args) };
    const r = await runProgram(withTier, dir, '', timeLimitMs || RUN_TIMEOUT_MS);
    // 原样返回（一个字符都不改）；要判断数值是否超限请用 maxNumericToken 只做"报告"
    return { ok: r.ok, err: r.err, timedOut: r.timedOut, input: r.output, timeMs: r.timeMs };
  }

  /** 数据里最大的"纯数字 token"：只用于**报告/提醒生成器**，绝不回写数据 */
  function maxNumericToken(text) {
    let max = 0;
    (String(text || '').match(/\d+/g) || []).forEach((t) => { const v = Number(t); if (Number.isFinite(v) && v > max) max = v; });
    return max;
  }

  /**
   * 比较两个程序在给定输入上的输出。
   * **两个程序并发跑**：它们互不依赖、只是各跑各的，串行等于白等一份时间；
   * 每次调用使用独立的临时文件（见 runProgram），所以并发不会互相覆盖输入输出。
   */
  async function compare(input, aKey, bKey, timeLimitMs) {
    const [a, b] = await Promise.all([
      run(aKey, input, timeLimitMs),
      run(bKey, input, timeLimitMs)
    ]);
    const same = a.ok && b.ok && compareOutputs(a.output, b.output).ok;
    return {
      same,
      aKey, bKey,
      a: { ok: a.ok, timedOut: a.timedOut, output: truncate(a.output, 1500), err: truncate(a.err, 600), timeMs: a.timeMs },
      b: { ok: b.ok, timedOut: b.timedOut, output: truncate(b.output, 1500), err: truncate(b.err, 600), timeMs: b.timeMs }
    };
  }

  /** 官方样例（跑指定程序）：多组样例**并发跑**，结果顺序保持一致 */
  async function runSamplesOn(key, samples) {
    const list = (samples || []).filter((s) => s && s.input != null);
    // 标尺（brute）用宽松超时；题解/生成器仍按默认掐表
    const tl = key === 'brute' ? bruteTimeout : RUN_TIMEOUT_MS;
    const runs = await Promise.all(list.map((s) => run(key, s.input, tl)));
    const results = [];
    let formatDiff = '';
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const r = runs[i];
      let verdict;
      let kind = 'same';
      if (r.timedOut) verdict = 'TLE';
      else if (!r.ok) verdict = 'RE';
      else if (s.output == null) verdict = 'OK';
      else {
        const cmp = compareOutputs(r.output, s.output);
        verdict = cmp.ok ? 'AC' : 'WA';
        kind = cmp.kind;
        // 等价但形态不同（空白布局/大小写/浮点尾数）→ 不算错，但记下来，方便上层给出准确的格式反馈
        if (cmp.ok && cmp.kind !== 'same') formatDiff = cmp.kind;
      }
      results.push({
        index: i + 1, verdict, kind, timeMs: r.timeMs,
        input: truncate(s.input, 500),
        expected: s.output == null ? null : truncate(s.output, 800),
        actual: truncate(r.output, 800),
        err: r.timedOut ? '超时' : (r.ok ? '' : truncate(r.err, 600))
      });
    }
    return { allPass: results.every((r) => r.verdict === 'AC' || r.verdict === 'OK'), results };
  }

  /**
   * 反例最小化（delta debugging，纯代码、零 token）：
   * 反复尝试删掉输入里的行/元素，只要「仍然 WA」就保留删除，直到不能再删。
   * 产出「n=1, a=[1]」这种可精确归因的最小反例。
   */
  async function minimize(input, aKey, bKey, opts) {
    const o = opts || {};
    const maxSteps = o.maxSteps || 60;
    const isBad = async (text) => {
      const r = await compare(text, aKey, bKey, o.timeLimitMs);
      // 仍然不一致、或被比较方崩了/超时（也算触发点）都视为「还是坏」
      return !r.same;
    };
    let best = String(input);
    if (!(await isBad(best))) return { ok: false, input: best, note: '原始输入未复现不一致' };
    let steps = 0;

    // 第一层：按行删
    let lines = best.replace(/\r/g, '').split('\n');
    let changed = true;
    while (changed && steps < maxSteps) {
      changed = false;
      for (let i = 0; i < lines.length && steps < maxSteps; i++) {
        const candidate = lines.slice(0, i).concat(lines.slice(i + 1)).join('\n');
        if (!candidate.trim()) continue;
        steps++;
        if (await isBad(candidate)) { lines = candidate.split('\n'); changed = true; i--; }
      }
    }

    // 第二层：按 token 删（同一行里的元素）
    let tokens = lines.join('\n').split(/(\s+)/);
    changed = true;
    while (changed && steps < maxSteps) {
      changed = false;
      for (let i = 0; i < tokens.length && steps < maxSteps; i++) {
        if (!tokens[i].trim()) continue;
        const candidate = tokens.slice(0, i).concat(tokens.slice(i + 1)).join('');
        if (!candidate.trim()) continue;
        steps++;
        if (await isBad(candidate)) { tokens = candidate.split(/(\s+)/); changed = true; i--; }
      }
    }
    best = tokens.join('').trim();
    return { ok: true, input: best, steps, originalLength: String(input).length, minimalLength: best.length };
  }

  return {
    ok: true, error: null, dir,
    has: (k) => !!specs[k],
    run, genCase, compare, runSamples: runSamplesOn, minimize, maxNumericToken,
    /** 只替换其中一个程序（例如修完题解后重编译），不必重建整个竞技场 */
    async update(key, part) {
      const prep = await prepare(part.lang || 'cpp', part.code, dir, key);
      if (!prep.ok) return { ok: false, error: key + '：' + prep.error };
      specs[key] = prep.spec;
      return { ok: true };
    },
    close: () => cleanupDir(dir)
  };
}

/* ---------------- 第一层体检：编译 / 语法 / 未定义行为 ---------------- */

/**
 * 代码体检（对拍之前的一层）：
 *  - C++：先用 -fsanitize=undefined 编译并跑官方样例，抓数组越界/溢出/空指针等 UB
 *    （MinGW 若没有 libubsan 会编译失败 → available=false，自动跳过这一层）
 *  - Python：先做语法检查（py_compile），再用 -X dev 跑样例抓运行时告警
 *  - JS：node --check 语法检查
 * @returns { available, findings:[{kind, detail}], results }
 */
async function sanitizeCheck(opts) {
  const { lang = 'cpp', code, samples = [] } = opts || {};
  const timeLimitMs = normTimeLimit((opts || {}).timeLimitMs);
  const src = String(code || '');
  if (!src.trim()) return { available: false, findings: [], note: '没有代码' };
  const dir = makeWorkDir('health');
  const findings = [];
  try {
    if (lang === 'cpp') {
      const file = path.join(dir, 'probe.cpp');
      fs.writeFileSync(file, src, 'utf8');
      const exe = path.join(dir, 'probe.exe');
      const errFile = path.join(dir, 'probe.cerr');
      const cerr = await new Promise((resolve) => {
        let fd;
        try { fd = fs.openSync(errFile, 'w'); } catch (e) { resolve('无法创建编译日志'); return; }
        let kid;
        try {
          kid = spawn('g++', ['-O1', '-std=c++23', '-g', '-fsanitize=undefined', '-fno-sanitize-recover=all', '-o', exe, file],
            { cwd: dir, stdio: ['ignore', 'ignore', fd], windowsHide: true });
        } catch (e) { fs.closeSync(fd); resolve('无法启动 g++'); return; }
        kid.on('error', () => { try { fs.closeSync(fd); } catch (e) {} resolve('g++ 启动失败'); });
        kid.on('exit', (c) => {
          try { fs.closeSync(fd); } catch (e) {}
          if (c === 0 && fs.existsSync(exe)) resolve(null);
          else { let t = ''; try { t = fs.readFileSync(errFile, 'utf8'); } catch (e) {} resolve(t || ('sanitizer 编译失败（退出码 ' + c + '）')); }
        });
      });
      const noSanitizer = !!cerr && /unrecognized|not found|cannot find -lubsan|undefined reference/i.test(cerr);
      if (cerr && !noSanitizer) {
        findings.push({ kind: 'compile-error', detail: truncate(cerr, 1200) });
        return { available: true, findings, results: [], note: '编译未通过' };
      }
      if (noSanitizer) return { available: false, findings: [], note: '本机 g++ 不支持 UBSan，已跳过该层' };
      const results = [];
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!s || s.input == null) continue;
        const r = await runProgram({ program: exe, args: [], kind: 'cpp' }, dir, s.input, timeLimitMs);
        const ubHit = /runtime error:|UndefinedBehaviorSanitizer|AddressSanitizer/i.test(String(r.err || ''));
        if (ubHit) findings.push({ kind: 'ub', detail: '样例 ' + (i + 1) + '：' + truncate(r.err, 800) });
        else if (r.timedOut) findings.push({ kind: 'timeout', detail: '样例 ' + (i + 1) + '：运行超时' });
        results.push({ index: i + 1, ub: ubHit, ok: r.ok, timedOut: r.timedOut });
      }
      return { available: true, findings, results };
    }

    if (lang === 'python') {
      const file = path.join(dir, 'probe.py');
      fs.writeFileSync(file, src, 'utf8');
      const syn = await new Promise((resolve) => {
        let kid;
        try {
          kid = spawn('python', ['-m', 'py_compile', file], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (e) { resolve({ code: -1, err: '无法启动 python' }); return; }
        let err = '';
        if (kid.stderr) kid.stderr.on('data', (d) => { err += String(d); });
        kid.on('error', () => resolve({ code: -1, err: 'python 启动失败' }));
        kid.on('exit', (c) => resolve({ code: c, err }));
      });
      if (syn.code !== 0) {
        findings.push({ kind: 'compile-error', detail: truncate(syn.err || '语法检查未通过', 1200) });
        return { available: true, findings, results: [], note: '语法检查未通过' };
      }
      const results = [];
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!s || s.input == null) continue;
        const r = await runProgram({ program: 'python', args: ['-X', 'dev', file], kind: 'python' }, dir, s.input, timeLimitMs);
        const warn = /Warning:|Traceback/i.test(String(r.err || ''));
        if (warn) findings.push({ kind: 'runtime-warning', detail: '样例 ' + (i + 1) + '：' + truncate(r.err, 700) });
        results.push({ index: i + 1, ok: r.ok, timedOut: r.timedOut });
      }
      return { available: true, findings, results };
    }

    if (lang === 'js') {
      const file = path.join(dir, 'probe.js');
      fs.writeFileSync(file, src, 'utf8');
      const syn = await new Promise((resolve) => {
        let kid;
        try {
          kid = spawn('node', ['--check', file], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (e) { resolve({ code: -1, err: '无法启动 node' }); return; }
        let err = '';
        if (kid.stderr) kid.stderr.on('data', (d) => { err += String(d); });
        kid.on('error', () => resolve({ code: -1, err: 'node 启动失败' }));
        kid.on('exit', (c) => resolve({ code: c, err }));
      });
      if (syn.code !== 0) findings.push({ kind: 'compile-error', detail: truncate(syn.err || '语法检查未通过', 1200) });
      return { available: true, findings, results: [] };
    }

    return { available: false, findings: [], note: '未知语言' };
  } finally {
    cleanupDir(dir);
  }
}

module.exports = {
  runSamples, compareOutputs, normalizeOutput, stressTest, availableRuntimes, RUN_TIMEOUT_MS, BRUTE_TIMEOUT_MS,
  normTimeLimit, pickLang,
  runSamplesFile, stressByFiles,
  openArena, SIZE_LADDER, sanitizeCheck,
  setSandbox, sandboxStatus
};
