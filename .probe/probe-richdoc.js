'use strict';
/**
 * probe-richdoc.js — 富讲解"生不出图"的真实模型诊断（只读配置，不写任何数据）
 *
 * 用法：node .probe/probe-richdoc.js [配置文件路径]
 * 默认读 dist/CFCoach-win32-x64/data/config.json（真实配置）。
 *
 * 它做两件事：
 *  A) 用**当前应用的真实请求方式**（不带 max_tokens）跑一次富讲解，看模型输出多长、是否被截断、
 *     产出的 HTML 能不能过 lib/richdoc.validate；
 *  B) 再带上 max_tokens=16384 跑一次做对照。
 * 打印 finish_reason / 字符数 / 占用的 token（若上游给 usage）/ 校验错误 / 是否疑似截断。
 */
const fs = require('fs');
const path = require('path');
const harness = require('../lib/harness.js');
const richdoc = require('../lib/richdoc.js');

const ROOT = path.join(__dirname, '..');
const cfgPath = process.argv[2] || path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const provider = (cfg.providers || []).find((p) => p.id === cfg.defaultProviderId) || (cfg.providers || [])[0];
if (!provider) { console.error('配置里没有 provider'); process.exit(1); }
const model = cfg.defaultModel || (provider.models || [])[0];
console.log('provider: ' + provider.name + ' · ' + provider.baseUrl + ' · type=' + provider.type);
console.log('model: ' + model + ' · cfg.maxOutputTokens=' + JSON.stringify(cfg.maxOutputTokens));

const STATEMENT = [
  '给定 n 张牌，每张牌有一个非负整数。遇到 0 时可以取走此前未被取走的最大正数牌，求能取得的最大总和。',
  '',
  '输入格式',
  '第一行 t（1 ≤ t ≤ 10）。每个测试用例第一行 n（1 ≤ n ≤ 8），第二行 n 个整数。',
  '输出格式',
  '每个测试用例输出一行整数。'
].join('\n');
const SOL = '```cpp\n#include <bits/stdc++.h>\nint main(){int t;scanf("%d",&t);while(t--){int n;scanf("%d",&n);std::priority_queue<int>q;long long s=0;for(int i=0;i<n;i++){int x;scanf("%d",&x);if(x>0)q.push(x);else if(!q.empty()){s+=q.top();q.pop();}}printf("%lld\\n",s);}return 0;}\n```';

const system = harness.explainerSystem('full', 'cpp', true, 'L3', { status: 'ok', samples: 1, iterations: 60 });
const user = [
  '【题面】\n' + STATEMENT,
  '',
  '【已验证题解（C++23）】\n' + SOL,
  '',
  '【验证报告】状态 ok（官方样例通过 + 随机对拍 60 组一致）',
  '',
  '请按富讲解模式输出这份图文文档。'
].join('\n');
console.log('system 提示词 ' + system.length + ' 字（含富讲解指南 ' + harness.richGuide().length + ' 字）');

async function call(maxTokens, tag) {
  const body = { model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2 };
  if (maxTokens) body.max_tokens = maxTokens;
  const t0 = Date.now();
  const res = await fetch(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + (provider.apiKey || '') }, provider.extraHeaders || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000)
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!res.ok || !j) {
    console.log('\n[' + tag + '] HTTP ' + res.status + '：' + text.slice(0, 400));
    return null;
  }
  const choice = (j.choices || [])[0] || {};
  const content = (choice.message && choice.message.content) || '';
  const u = j.usage || {};
  const html = harness.extractHtmlBlock(content);
  const v = html ? richdoc.validate(html.html) : { ok: false, errors: ['没有找到 ```html 代码块'] };
  console.log('\n[' + tag + '] 耗时 ' + Math.round((Date.now() - t0) / 1000) + 's'
    + ' · finish_reason=' + choice.finish_reason
    + ' · 输出 ' + content.length + ' 字'
    + ' · usage=' + JSON.stringify({ in: u.prompt_tokens, out: u.completion_tokens }));
  console.log('  提取到 html 代码块: ' + (html ? '是' : '否')
    + (html ? '（' + html.html.length + ' 字，疑似截断=' + richdoc.looksTruncated(html.html) + '）' : ''));
  console.log('  校验: ' + (v.ok ? '✅ 通过 ' + JSON.stringify(v.stats) : '❌ ' + (v.errors || []).slice(0, 4).join('；')));
  if (v.warnings && v.warnings.length) console.log('  提醒: ' + v.warnings.slice(0, 3).join('；'));
  if (html) {
    const out = path.join(__dirname, 'richdoc-' + tag + '.html');
    fs.writeFileSync(out, html.html, 'utf8');
    console.log('  落盘: ' + out);
  }
  return { content, choice, html, v };
}

(async () => {
  await call(0, 'no-max-tokens');
  await call(16384, 'max-16384');
})().catch((e) => { console.error('探针异常: ' + ((e && e.stack) || e)); process.exit(1); });
