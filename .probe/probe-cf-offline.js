'use strict';
/**
 * probe-cf-offline.js — 验证"抓过一次就离线可用"：把 CF_BASE 指到死端口，看能否靠落盘缓存返回题面与样例
 * 用法：node .probe/probe-cf-offline.js <数据目录> <contestId> <index>
 *   数据目录里应当已经有 cf-problems/<ID><INDEX>.json（先正常运行过一次取题）
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, '.test-data', 'cf-selftest2');
const CID = process.argv[3] || '2264';
const IDX = (process.argv[4] || 'D').toUpperCase();

process.env.CF_BASE = 'http://127.0.0.1:3997';   // 没人监听：联网必失败
const cf = require(path.join(ROOT, 'lib', 'cf.js'));
cf.setCacheDir(DATA);

const f = path.join(DATA, 'cf-problems', CID + IDX + '.json');
console.log('落盘缓存: ' + (fs.existsSync(f) ? f + '（' + fs.statSync(f).size + ' 字节）' : '（不存在）'));

(async () => {
  const r = await cf.fetchProblem(CID, IDX);
  const samples = (r.samples || []).filter((s) => s.input != null);
  console.log('返回: fromCache=' + !!r.fromCache + ' · 题面 ' + String(r.statement || '').length + ' 字 · 样例 ' + samples.length + ' 组');
  console.log('告警: ' + JSON.stringify(r.warnings || []));
  const ok = !!r.fromCache && String(r.statement || '').length > 300 && samples.length > 0;
  console.log('判定: ' + (ok ? '✅ 断网也能用缓存题面+样例' : '❌ 没走缓存'));
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('异常: ' + e.message); process.exit(1); });
