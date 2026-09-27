/* 临时工具：读抓取会话分区里的 cookie（SQLite 文件，无需依赖库：直接扫字符串） */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const part = process.env.CFCOACH_PART
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codeforces-coach', 'Partitions', 'cfcoach-fetch', 'Network', 'Cookies');

console.log('Cookies 文件: ' + part);
if (!fs.existsSync(part)) { console.log('不存在'); process.exit(1); }
const buf = fs.readFileSync(part);
console.log('大小 ' + buf.length + ' 字节');

// 粗读：把可打印字符抽出来，找 codeforces 域名附近的 cookie 名
const text = buf.toString('latin1');
const names = new Set();
const re = /([A-Za-z_][A-Za-z0-9_]{1,40})[^\x20-\x7e]{0,8}(?:\.)?codeforces\.com/gi;
let m;
while ((m = re.exec(text)) !== null) names.add(m[1]);
// 另一种排布：域名在前，名字在后
const re2 = /codeforces\.com[^\x20-\x7e]{0,8}([A-Za-z_][A-Za-z0-9_]{1,40})/gi;
while ((m = re2.exec(text)) !== null) names.add(m[1]);

const list = [...names].filter((n) => n.length > 1).sort();
console.log('\n识别到的 cookie 相关标识（含推测）:');
console.log(list.length ? '  ' + list.join(', ') : '  （没识别出来）');

// 关键 cookie 的存在性
for (const key of ['cf_clearance', '39ce7', '70a7c28f3de', '79d1787', 'csrftoken', 'X-User-Sha1', 'JSESSIONID']) {
  if (text.includes(key)) console.log('  ✓ 含 ' + key);
}
