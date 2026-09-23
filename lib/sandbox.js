/**
 * lib/sandbox.js —— 代码沙箱守卫的接线 API（运行 LLM 生成代码时用）
 *
 * 设计目标：把"用户设置里可开关的沙箱"收敛成两个函数，lib/runner.js 只需在
 * spawn 之前问一句 prepare(kind, { dir })，然后把返回的 env / args 拼上去。
 *
 * 【重要：这是"缓解"，不是可靠隔离】
 * 守卫脚本（lib/sandbox/guard.js、lib/sandbox/sitecustomize.py）是在用户态
 * 打补丁拦截 socket / fs 的常用入口，只能挡住"提示注入诱导模型写偷文件/发请求"
 * 这一档，挡不住 native 直连、ctypes、进程内绑定绕过等。C++ 通道更是完全无法
 * 在用户态限制（需要 job object / 容器 / 受限账户）。详见 describe()。
 *
 * 用法（以 lib/runner.js 为例）：
 *   const sandbox = require('./sandbox');
 *   const pre = sandbox.prepare(kind, { dir, allowNetwork: userAllowsNet });
 *   child = spawn(program, (pre.args || []).concat(args),
 *                 { cwd: dir, stdio: [inFd, outFd, errFd], env: pre.env,
 *                   windowsHide: true });
 * 注意：args 必须拼在脚本路径【之前】（Node 的 --require 是解释器参数），
 * env 必须整个替换（不要把 pre.env 再叠回 process.env —— prepare 已经合并好了）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const GUARD_DIR = path.join(__dirname, 'sandbox');
const PY_GUARD = path.join(GUARD_DIR, 'sitecustomize.py');
const JS_GUARD = path.join(GUARD_DIR, 'guard.js');

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** 守卫是否可用：python => sitecustomize.py 存在；js => guard.js 存在；cpp => 永远 false */
function available(kind) {
  if (kind === 'python') return fileExists(PY_GUARD);
  if (kind === 'js') return fileExists(JS_GUARD);
  return false;
}

/** 环境变量名在 Windows 上大小写不敏感：先剔掉同名旧键，再写入，避免出现两个 PATH */
function withEnv(base, additions) {
  const out = {};
  const lower = {};
  for (const k of Object.keys(base || {})) {
    const lk = k.toLowerCase();
    if (lower[lk]) continue;      // 已有一个同名（异大小写）键，跳过
    lower[lk] = true;
    out[k] = base[k];
  }
  for (const k of Object.keys(additions)) {
    const lk = k.toLowerCase();
    if (lower[lk]) {
      // 找到实际存在的那个键名，原地覆盖（保留原键名的大小写风格）
      for (const ek of Object.keys(out)) {
        if (ek.toLowerCase() === lk) { out[ek] = additions[k]; break; }
      }
      continue;
    }
    lower[lk] = true;
    out[k] = additions[k];
  }
  return out;
}

/** 把 guard 目录塞进 PYTHONPATH 最前面（保留用户原有的 PYTHONPATH 项） */
function withPythonPath(base) {
  const sep = process.platform === 'win32' ? ';' : ':';
  let existing = '';
  for (const k of Object.keys(base || {})) {
    if (k.toUpperCase() === 'PYTHONPATH') { existing = base[k] || ''; break; }
  }
  const parts = String(existing).split(sep).filter((s) => s && s !== GUARD_DIR);
  parts.unshift(GUARD_DIR);
  return { PYTHONPATH: parts.join(sep) };
}

/**
 * 为一个将要运行的子进程准备环境变量与参数。
 *
 * @param {'python'|'js'|'cpp'} kind 通道类型
 * @param {{ dir: string, allowNetwork?: boolean, enabled?: boolean }} opts
 *        dir          题目程序的工作目录（沙箱内可自由读写）
 *        allowNetwork true = 放开网络（等价于不施加网络限制）
 *        enabled      false = 整体关闭沙箱（用户设置里关掉时）
 * @returns {{ env: object, args?: string[] }}
 *        env  —— 完整的环境变量对象，直接传给 spawn({ env })
 *        args —— 需要附加到命令行【最前面】（脚本路径之前）的解释器参数
 */
function prepare(kind, opts) {
  const o = opts || {};
  const dir = o.dir ? path.resolve(String(o.dir)) : '';

  // 关闭沙箱 / 放开网络：一律"不施加限制"，保持旧行为
  if (o.enabled === false || o.allowNetwork === true) {
    return { env: process.env };
  }

  if (kind === 'js') {
    const env = withEnv(process.env, { SANDBOX_DIR: dir, SANDBOX_ALLOW_NET: '0' });
    if (!available('js')) return { env: process.env };   // 守卫缺失 → 别加 --require（会直接崩）
    return { env, args: ['--require', JS_GUARD] };
  }

  if (kind === 'python') {
    if (!available('python')) {
      return {
        env: withEnv(process.env, { SANDBOX_DIR: dir, SANDBOX_ALLOW_NET: '0' })
      };
    }
    const additions = Object.assign(
      { SANDBOX_DIR: dir, SANDBOX_ALLOW_NET: '0' },
      withPythonPath(process.env)
    );
    return { env: withEnv(process.env, additions) };
  }

  // cpp（以及任何其他 kind）：用户态无法限制原生程序，如实不加限制
  return { env: process.env };
}

/** 人类可读说明，用于设置页 / README */
function describe() {
  const py = available('python');
  const js = available('js');
  return [
    '代码沙箱（缓解措施，非可靠隔离）',
    '',
    '用途：运行 LLM 生成的验证代码时，限制它读写沙箱目录之外的文件、访问外网。',
    '动机：题面抓取自外网，可能被间接提示注入，诱导模型生成越权代码。',
    '',
    '各通道状态：',
    '  Python：' + (py ? '已启用' : '不可用（缺少 lib/sandbox/sitecustomize.py）') +
      ' —— 通过 PYTHONPATH 自动加载 sitecustomize，拦截 socket/urllib 与 open/os.*/shutil 常用入口。',
    '  JS    ：' + (js ? '已启用' : '不可用（缺少 lib/sandbox/guard.js）') +
      ' —— 通过 NODE_OPTIONS 风格的 --require 预加载，拦截 net/tls/http/https/dns/fetch 与 fs 常用入口。',
    '  C++   ：不可用 —— C++ 通道无法限制文件/网络访问（用户态没有拦截点，',
    '          需要 job object / 容器 / 受限账户才能限制；当前 runner 只用 taskkill 控超时）。',
    '',
    '已知绕过（这是"缓解"而非隔离的原因）：',
    '  · 进程内原生直连（process.binding / ctypes / _winapi / mmap）不受 JS/Python 层补丁约束；',
    '  · 用户代码可把被 patch 的函数改回原样（require("fs") 与解释器拿到的是同一模块对象）；',
    '  · Python 的 import 机制未拦截（拦截太脆），只拦用户显式 open 任意路径这条主流通道；',
    '  · C++ 通道完全不受限；',
    '  · 关闭沙箱（enabled:false）或放开网络（allowNetwork:true）时守卫整体不生效。',
    '',
    '结论：用于降低"被题面注入后偷读本机文件 / 外发数据"的风险，不能防御有意逃逸的代码。'
  ].join('\n');
}

module.exports = { prepare, available, describe, GUARD_DIR, PY_GUARD, JS_GUARD };
