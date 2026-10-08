'use strict';
/**
 * 取题窗口的安全开关（2026-10-08 事故回归单测）。
 *
 * 事故：跑工作台"抓题"时**整机卡死、屏幕黑掉、报"显示设备出错"、必须重启机器**（用户实测两次）。
 * 判分链路已排除（只编译运行 C++/Python，不碰浏览器）；唯一会起 Chromium 的就是取题窗口，
 * 可见窗口里跑 Cloudflare 挑战页最可能把显卡驱动打到复位。
 *
 * 因此加了三个开关（都**默认关**，不改变正常行为）：
 *   · lib/cf.js `CFCOACH_CF_HIDDEN_ONLY=1`   → 只试隐藏窗口，不再弹可见窗口；
 *   · electron/main.js 同名开关            → 可见抓取直接被拒（并带明确原因）；
 *   · electron/main.js `CFCOACH_CF_SAFE_GPU=1` → ready 之前关硬件加速；
 *   · ablation/lib/cffetch.js（工作台抓题） → **默认**只允许隐藏窗口，要可见需 CFCOACH_CF_ALLOW_VISIBLE=1。
 *
 * 本单测用 fetch 桩把"被 Cloudflare 拦"这条路走通，**不联网**。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require 之前：lib/cf.js 加载时就把 CF_BASE 定下来（同时让它不落盘 problemset 缓存）
process.env.CF_BASE = 'https://cf-safety-test.invalid';
delete process.env.CFCOACH_CF_HIDDEN_ONLY;

const cf = require('../lib/cf.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { console.error('  \u2717 ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

cf.setCacheDir(path.join(os.tmpdir(), 'cfcoach-cfwindow-test-' + Date.now()));

/** 一切 HTTP 都返回"Cloudflare 挑战页"⇒ fetchText 必然落到内嵌浏览器这一路 */
const realFetch = global.fetch;
global.fetch = async (url) => ({
  ok: true,
  status: 200,
  url: String(url),
  text: async () => '<html><title>Just a moment...</title>Enable JavaScript and cookies to continue</html>',
  json: async () => { throw new Error('测试桩：不提供 JSON'); }
});

/** 记录每次"起浏览器"时带的模式；返回空串 ⇒ 这次抓取没成功（正好让两段式往下走） */
function recorder(calls, arity) {
  const fn = async (target, opts) => { calls.push(Object.assign({ target: String(target) }, opts || {})); return ''; };
  if (arity === 1) return async (target) => { calls.push({ target: String(target) }); return ''; };
  return fn;
}

const visibleFlags = (calls) => calls.map((c) => !!c.visible);

(async () => {
  console.log('cf-window: 取题窗口安全开关（隐藏窗口 / 可见窗口 / 安全 GPU）');

  // ① 默认行为不能变：隐藏窗口失败后仍然会退到可见窗口（老行为是刻意保留的）
  {
    const calls = [];
    cf.setBrowserFetcher(recorder(calls, 2));
    await cf.fetchProblem(1901, 'C', {}).catch(() => {});
    ok('默认（不设开关）：隐藏窗口 → 可见窗口，两段式照旧', () => {
      assert.deepStrictEqual(visibleFlags(calls), [false, true], '实际=' + JSON.stringify(visibleFlags(calls)));
    });
  }

  // ② CFCOACH_CF_HIDDEN_ONLY=1：可见窗口一次都不许弹
  {
    const calls = [];
    process.env.CFCOACH_CF_HIDDEN_ONLY = '1';
    cf.setBrowserFetcher(recorder(calls, 2));
    await cf.fetchProblem(1902, 'C', {}).catch(() => {});
    delete process.env.CFCOACH_CF_HIDDEN_ONLY;
    ok('CFCOACH_CF_HIDDEN_ONLY=1：只试隐藏窗口，可见窗口一次都不弹', () => {
      assert.deepStrictEqual(visibleFlags(calls), [false], '实际=' + JSON.stringify(visibleFlags(calls)));
    });
  }

  // ③ 旧签名抓取器（只接一个参数）本来就不该被要求"再来一次可见"
  {
    const calls = [];
    cf.setBrowserFetcher(recorder(calls, 1));
    await cf.fetchProblem(1903, 'C', {}).catch(() => {});
    ok('旧签名抓取器（arity=1）：不重复调用、不假装试过可见窗口', () => {
      assert.strictEqual(calls.length, 1, '实际=' + JSON.stringify(visibleFlags(calls)));
    });
  }

  // ④ 工作台抓题（ablation/lib/cffetch.js）默认只允许隐藏窗口 —— 那是把机器拖垮的入口
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ablation', 'lib', 'cffetch.js'), 'utf8');
    ok('工作台抓题默认注入 CFCOACH_CF_HIDDEN_ONLY=1（要可见须 CFCOACH_CF_ALLOW_VISIBLE=1）', () => {
      assert.ok(/CFCOACH_CF_ALLOW_VISIBLE/.test(src), '没有 CFCOACH_CF_ALLOW_VISIBLE 逃生门');
      assert.ok(/hiddenOnly \? \{ CFCOACH_CF_HIDDEN_ONLY: '1' \} : \{\}/.test(src),
        '没有按 hiddenOnly 注入 CFCOACH_CF_HIDDEN_ONLY');
    });
  }

  // ⑤ 应用侧（electron/main.js）的拒绝 + 安全 GPU 开关必须在
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    ok('electron：可见抓取在 CFCOACH_CF_HIDDEN_ONLY=1 下被明确拒绝', () => {
      assert.ok(/if \(o\.visible && CF_HIDDEN_ONLY\)/.test(src), '没有拒绝可见抓取的分支');
      assert.ok(/CFCOACH_CF_HIDDEN_ONLY=1/.test(src), '错误信息里没有说明开关');
    });
    ok('electron：CFCOACH_CF_SAFE_GPU=1 → ready 之前关硬件加速', () => {
      assert.ok(/app\.disableHardwareAcceleration\(\)/.test(src), '没有关硬件加速');
      assert.ok(/CFCOACH_CF_SAFE_GPU/.test(src), '没有 CFCOACH_CF_SAFE_GPU 开关');
    });
  }

  global.fetch = realFetch;
  console.log('cf-window: ' + pass + ' 项通过');
  if (process.exitCode) console.error('cf-window: 有失败项');
})().catch((e) => {
  console.error('cf-window: 单测自身异常 ' + (e && e.stack || e));
  process.exitCode = 1;
});
