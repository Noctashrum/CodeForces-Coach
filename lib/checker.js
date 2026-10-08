/**
 * lib/checker.js —— **本地 checker（特殊判题器）**：多解题的唯一判据
 *
 * 为什么需要它（2026-10 消融报告 2241B / 2267B / 2250F）：
 *   题面允许"输出任意合法答案"时，官方样例只是**一个**合法答案，题解与暴力解给出不同答案
 *   **不能**说明谁错。产品侧以前唯一的诚实做法是停下并标成 `multi-answer`（"本地判不了"）——
 *   这是对的（总比把对的题解改错好），但代价是这些题永远拿不到"已验证"，讲解线也拿不到反例。
 *   离线尺子那一半已经证明了做法可行（`ablation/checker/` 里的三份真 checker 把 2250F/2257C/2267B
 *   从"不可判"变成真判词，见 `docs/cf-ac-ruler-2026-10.md` §3.7）——这里把同一套约定搬到产品侧。
 *
 * 判据的判据（纪律，照抄 `lib/statement.js` 的思路）：
 *   ① **自检不过就不用**：checker 必须把**官方样例的答案**判成 AC，否则它和官方数据自相矛盾，
 *      拿它去判候选的错就是把 checker 的锅扣到候选头上。官方样例缺失 ⇒ 无法自检 ⇒ 也不可信
 *      （与离线尺子不同：尺子那边"没样例按可信处理"，产品侧改了这条 —— 严格**不花任何代价**，
 *       不可信就回落到原来的 `multi-answer` 停手，绝不做更坏的结论）。
 *   ② **退出码按 testlib 约定读**：0=OK / 1=WA / 2=PE，**其它（含 3=FAIL）一律算"checker 自己没给出
 *      可用结论"**，绝不能当成候选的错。真实案例：2257C 的 checker 在"jury（我们的标尺）不是最优"
 *      时返回 3 —— 那是标尺的锅。
 *   ③ checker 跑挂/超时 → 不判 WA，记下原因，调用方回落"不可判"。
 *
 * 存放位置：`<工作区>/checker/checker.{py,cpp,exe}`（也认 `<题号>.{py,cpp,exe}`）。
 *   刻意放**子目录**：`lib/workspace.js` 的 `clearScratch()` 只清工作区**顶层**文件，
 *   所以子目录里的 checker 能跨轮次复用（一份 checker 要花一次 agent 调用，不该被清掉），
 *   而删工作区（`removeWorkspace`）依然会把它一起删干净。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RUN_TIMEOUT_MS = 15000;
const BUILD_TIMEOUT_MS = 120000;
const EXTS = ['.py', '.exe', '.cpp', '.cc', '.cxx'];

/** python 解释器：环境变量优先，其次是各平台的常规名字 */
function pythonCmd() {
  const env = String(process.env.CFCOACH_PYTHON || '').trim();
  if (env) return env;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 这个目录里有没有可用的 checker（子目录优先，其次工作区顶层） */
function resolve(workDir, problemId) {
  if (!workDir) return null;
  const id = String(problemId || '').trim();
  const dirs = [
    { dir: path.join(workDir, 'checker'), source: 'workspace-checker' },
    { dir: workDir, source: 'workspace' }
  ];
  const bases = ['checker'];
  if (id) { bases.push(id); bases.push(id.toUpperCase()); }
  for (const d of dirs) {
    for (const base of bases) {
      for (const ext of EXTS) {
        const file = path.join(d.dir, base + ext);
        let st = null;
        try { st = fs.statSync(file); } catch (e) { st = null; }
        if (!st || !st.isFile() || st.size === 0) continue;
        const low = ext.toLowerCase();
        return {
          file,
          lang: low === '.py' ? 'python' : (low === '.exe' ? 'exe' : 'cpp'),
          source: d.source,
          bytes: st.size,
          mtimeMs: st.mtimeMs
        };
      }
    }
  }
  return null;
}

/** 起一个进程并收全 stdout/stderr（async：不能阻塞事件循环里其他会话的活） */
function spawnCapture(cmd, argv, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(cmd, argv, { cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ error: e });
    }
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) { /* 已经退出了 */ }
    }, o.timeoutMs || RUN_TIMEOUT_MS);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Object.assign({ stdout: out, stderr: err, timedOut }, r));
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/** 尾部两行、限长 220：判词要能给人看，又不能把兆级输出带进记录 */
function tailDetail(r) {
  const s = String((r && r.stdout || '') + '\n' + (r && r.stderr || '')).trim();
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-2).join(' | ').slice(0, 220);
}

/**
 * 准备 checker：`.py` / `.exe` 直接用；`.cpp` 编译一次（按 mtime 缓存到同目录 `.build/`）。
 * @returns {Promise<{ok:boolean, cmd?:string, args0?:string[], exe?:string, lang?:string, cached?:boolean, error?:string}>}
 */
async function build(ck, opts) {
  if (!ck) return { ok: false, error: 'no-checker' };
  if (ck.lang === 'python') return { ok: true, exe: ck.file, lang: 'python' };
  if (ck.lang === 'exe') return { ok: true, exe: ck.file, lang: 'exe' };
  const o = opts || {};
  const buildDir = o.buildDir || path.join(path.dirname(ck.file), '.build');
  try { fs.mkdirSync(buildDir, { recursive: true }); } catch (e) { /* 建不出来就让编译自己报错 */ }
  const exe = path.join(buildDir, path.basename(ck.file).replace(/\.[^.]+$/, '') + '.exe');
  try {
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= ck.mtimeMs) return { ok: true, exe, lang: 'exe', cached: true };
  } catch (e) { /* 缓存不可用就重新编译 */ }
  const r = await spawnCapture(o.gpp || 'g++', ['-O2', '-std=c++17', '-Wl,--stack,268435456', ck.file, '-o', exe],
    { timeoutMs: o.buildTimeoutMs || BUILD_TIMEOUT_MS });
  if (r.error) return { ok: false, error: 'g++ 起不来：' + String(r.error.message || r.error).slice(0, 200) };
  if (r.timedOut) return { ok: false, error: 'g++ 编译超时（' + Math.round((o.buildTimeoutMs || BUILD_TIMEOUT_MS) / 1000) + 's）' };
  if (r.code !== 0 || !fs.existsSync(exe)) {
    const msg = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' / ');
    return { ok: false, error: 'g++ 编译失败（exit ' + r.code + '）：' + msg.slice(0, 300) };
  }
  return { ok: true, exe, lang: 'exe' };
}

/**
 * 跑一次 checker：三份临时文件（输入 / 候选输出 / jury 输出）当 argv 传给 checker。
 * 约定：`checker <input> <participant_out> [jury_ans]`（与 `ablation/checker/README.md` 一致）。
 * @returns {Promise<{ok:boolean, ac?:boolean, verdict?:string, exit?:number, detail?:string, error?:string}>}
 */
async function runOnce(built, c, timeoutMs) {
  if (!built || !built.ok || !built.exe) return { ok: false, error: (built && built.error) || 'checker 没准备好' };
  const isPy = /\.py$/i.test(built.exe);
  // 文件不在了（缓存被清、换机器）就别浪费一次 spawn：直接报清楚，调用方回落"判不了"
  try { if (!fs.existsSync(built.exe)) return { ok: false, error: 'checker 文件不存在：' + built.exe }; } catch (e) { /* 交给 spawn 报错 */ }
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfcoach-checker-'));
    const fi = path.join(dir, 'in.txt');
    const fo = path.join(dir, 'out.txt');
    const fa = path.join(dir, 'ans.txt');
    fs.writeFileSync(fi, String((c && c.input) == null ? '' : c.input));
    fs.writeFileSync(fo, String((c && c.participant) == null ? '' : c.participant));
    fs.writeFileSync(fa, String((c && c.jury) == null ? '' : c.jury));
    const cmd = isPy ? pythonCmd() : built.exe;
    const argv = isPy ? [built.exe, fi, fo, fa] : [fi, fo, fa];
    const r = await spawnCapture(cmd, argv, { cwd: dir, timeoutMs: timeoutMs || RUN_TIMEOUT_MS });
    const detail = tailDetail(r);
    if (r.error) return { ok: false, error: 'checker 起不来：' + String(r.error.message || r.error).slice(0, 200) };
    if (r.timedOut || r.signal) {
      return { ok: false, error: 'checker 超时或被信号终止' + (r.signal ? '（信号 ' + r.signal + '）' : '') + (detail ? '：' + detail : '') };
    }
    if (r.code === 0) return { ok: true, ac: true, exit: 0, detail: detail || 'OK' };
    if (r.code === 1 || r.code === 2) {
      return { ok: true, ac: false, exit: r.code, verdict: r.code === 2 ? 'PE' : 'WA', detail: detail || ('exit ' + r.code) };
    }
    return { ok: false, error: 'checker 自己没给出可用结论（exit ' + r.code + '）' + (detail ? '：' + detail : '') };
  } catch (e) {
    return { ok: false, error: 'checker 运行异常：' + String((e && e.message) || e).slice(0, 200) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 只降级 */ } }
  }
}

/**
 * checker 自检：官方样例的答案当候选输出必须 AC。
 * 产品侧比离线尺子严：**没有官方样例可自检 ⇒ 不可信**（不可信只是回落到原来的"判不了"，
 * 所以这条严格不花任何代价）。
 * @returns {Promise<{trusted:boolean, tested:number, failures?:Array, note?:string}>}
 */
async function selfTest(built, samples, opts) {
  const o = opts || {};
  const list = (samples || []).filter((s) => s && s.input != null && s.output != null);
  if (!list.length) {
    const r = { trusted: false, tested: 0, note: '没有官方样例可自检 → 不采信这个 checker（回落到"多解题·本地判不了"）' };
    if (o.note !== false) r.note = r.note;
    return r;
  }
  const failures = [];
  for (const s of list) {
    const r = await runOnce(built, { input: s.input, participant: s.output, jury: s.output }, (o && o.timeoutMs) || RUN_TIMEOUT_MS);
    if (!r.ok || !r.ac) {
      failures.push({
        input: String(s.input).replace(/\s+/g, ' ').slice(0, 80),
        why: r.ok ? ('checker 把官方答案判成 ' + r.verdict + '：' + r.detail) : r.error
      });
    }
  }
  if (failures.length) {
    return { trusted: false, tested: list.length, failures, note: 'checker 与官方答案矛盾 → 不采信它，回落到"多解题·本地判不了"' };
  }
  return { trusted: true, tested: list.length };
}

/**
 * 用可信 checker 判"题解这一组输出是不是合法答案"。
 * **只判候选合法性**（jury 那一栏喂我们的暴力解输出，只为让需要最优性比对的 checker 有个参照）。
 *   · `legal:true`  → 题解与暴力解的差异是"两个都合法"⇒ **不构成题解错的证据**，对拍这一组不算不一致；
 *   · `legal:false` → 这是有背书的真反例（checker 已自证过官方样例）⇒ 交给原来的"错因仲裁 / 修题解"路径；
 *   · `ok:false`    → checker 没给出结论（exit 3 / 超时 / 跑挂）⇒ 调用方必须回落"不可判"。
 */
async function judgeSol(built, c, timeoutMs) {
  const r = await runOnce(built, c, timeoutMs || RUN_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, legal: !!r.ac, verdict: r.verdict || '', exit: r.exit, detail: r.detail };
}

/** 一次到位：解析 → 编译 → 自检（供上层在花掉一次 agent 调用之后调用） */
async function prepare(workDir, problemId, samples, opts) {
  const ck = resolve(workDir, problemId);
  if (!ck) return { ok: false, error: 'no-checker' };
  const built = await build(ck, opts);
  if (!built.ok) return { ok: false, error: built.error, checker: ck };
  const test = await selfTest(built, samples, opts);
  return { ok: true, checker: ck, built, test, trusted: !!test.trusted };
}

module.exports = {
  resolve, build, runOnce, selfTest, judgeSol, prepare, pythonCmd,
  RUN_TIMEOUT_MS, BUILD_TIMEOUT_MS, EXTS
};
