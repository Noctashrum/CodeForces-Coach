/**
 * probe-folders.js — 真机验证「对话文件夹 + 多选批量操作」的服务端契约。
 *
 * 用法：node scripts/probe-folders.js
 * 会启动打包好的 exe（隔离数据目录），把新增的接口全跑一遍，并断言状态真的落盘。
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'CFCoach-win32-x64', 'CFCoach.exe');
const DATA = path.join(ROOT, '.test-data', 'probe-folders');

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* ignore */ } resolve({ status: res.statusCode, json: j, text: d }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const proc = spawn(EXE, [], { windowsHide: true, cwd: path.dirname(EXE), stdio: 'ignore', env: Object.assign({}, process.env, { CHATBOX_DATA_DIR: DATA }) });
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -OwningProcess ' + proc.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort"', { windowsHide: true, encoding: 'utf8' });
      port = parseInt(String(out).trim(), 10) || 0;
    } catch (e) { /* 等 */ }
  }
  if (!port) { console.error('拿不到端口'); proc.kill(); process.exit(2); }
  console.log('端口 ' + port + '｜数据目录 ' + DATA + '\n');

  try {
    // 造 4 个对话
    const ids = [];
    for (let i = 1; i <= 4; i++) {
      const r = await req(port, 'POST', '/api/conversations', {});
      await req(port, 'PATCH', '/api/conversations/' + r.json.id, { title: '对话' + i });
      ids.push(r.json.id);
    }
    check('新建 4 个对话', ids.length === 4);

    // 文件夹 CRUD
    const f1 = await req(port, 'POST', '/api/folders', { name: '线段树' });
    check('新建文件夹', f1.status === 200 && f1.json.folder && f1.json.folder.name === '线段树', f1.json);
    const dup = await req(port, 'POST', '/api/folders', { name: '线段树' });
    check('同名文件夹被拒（不是静默建两个）', dup.status === 400, dup.json);
    const f2 = await req(port, 'POST', '/api/folders', { name: 'DP' });
    const fid1 = f1.json.folder.id;
    const fid2 = f2.json.folder.id;
    const list = await req(port, 'GET', '/api/folders');
    check('文件夹清单', list.json.folders.length === 2, list.json.folders);
    const ren = await req(port, 'PATCH', '/api/folders/' + fid2, { name: '动态规划' });
    check('重命名文件夹', ren.json.folder.name === '动态规划', ren.json.folder);

    // 批量移动
    const mv = await req(port, 'POST', '/api/conversations/batch', { ids: [ids[0], ids[1]], action: 'move', folder: fid1 });
    check('批量移动到文件夹', mv.json.done === 2, mv.json);
    await req(port, 'POST', '/api/conversations/batch', { ids: [ids[2]], action: 'move', folder: fid2 });
    const convs1 = (await req(port, 'GET', '/api/conversations')).json.conversations;
    const byId = {};
    convs1.forEach((c) => { byId[c.id] = c; });
    check('列表带 folder 字段且落盘正确',
      byId[ids[0]].folder === fid1 && byId[ids[1]].folder === fid1 && byId[ids[2]].folder === fid2 && byId[ids[3]].folder === '',
      convs1.map((c) => [c.title, c.folder]));

    // 批量归档 / 恢复
    const ar = await req(port, 'POST', '/api/conversations/batch', { ids: [ids[0], ids[3]], action: 'archive' });
    check('批量归档', ar.json.done === 2, ar.json);
    const active = (await req(port, 'GET', '/api/conversations?archived=0')).json.conversations.map((c) => c.id);
    const arch = (await req(port, 'GET', '/api/conversations?archived=1')).json.conversations.map((c) => c.id);
    check('归档后从对话页移出、出现在归档页', active.indexOf(ids[0]) < 0 && arch.indexOf(ids[0]) >= 0, { active, arch });
    await req(port, 'POST', '/api/conversations/batch', { ids: [ids[0]], action: 'unarchive' });
    const active2 = (await req(port, 'GET', '/api/conversations?archived=0')).json.conversations.map((c) => c.id);
    check('恢复后回到对话页（文件夹归属保留）', active2.indexOf(ids[0]) >= 0
      && (await req(port, 'GET', '/api/conversations')).json.conversations.find((c) => c.id === ids[0]).folder === fid1);

    // 非法批量操作
    const bad = await req(port, 'POST', '/api/conversations/batch', { ids: [ids[0]], action: 'explode' });
    check('非法批量操作被拒', bad.status === 400, bad.json);
    const noIds = await req(port, 'POST', '/api/conversations/batch', { ids: [], action: 'delete' });
    check('空选中被拒（不是静默成功）', noIds.status === 400, noIds.json);
    const badFolder = await req(port, 'POST', '/api/conversations/batch', { ids: [ids[0]], action: 'move', folder: 'f_nope' });
    check('移动到不存在的文件夹被拒', badFolder.status === 400, badFolder.json);

    // 删文件夹：对话保留、回到未分类
    const del = await req(port, 'DELETE', '/api/folders/' + fid1);
    check('删文件夹报告移出的对话数', del.status === 200 && del.json.moved === 2, del.json);
    const after = (await req(port, 'GET', '/api/conversations')).json.conversations;
    check('删文件夹不删对话（回到未分类）',
      after.length === 4 && after.find((c) => c.id === ids[0]).folder === ''
      && after.find((c) => c.id === ids[1]).folder === '',
      after.map((c) => [c.title, c.folder]));
    check('另一文件夹不受影响', after.find((c) => c.id === ids[2]).folder === fid2);

    // 批量删除
    const dl = await req(port, 'POST', '/api/conversations/batch', { ids: [ids[0], ids[1]], action: 'delete' });
    check('批量删除', dl.json.done === 2, dl.json);
    const end = (await req(port, 'GET', '/api/conversations')).json.conversations;
    check('删除后只剩 2 个对话', end.length === 2, end.map((c) => c.title));

    // 文件夹清单落盘文件存在且是合法 JSON
    const fp = path.join(DATA, 'folders.json');
    let foldersFile = null;
    try { foldersFile = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { foldersFile = null; }
    check('folders.json 落在数据目录且内容正确',
      Array.isArray(foldersFile) && foldersFile.length === 1 && foldersFile[0].name === '动态规划', foldersFile);
  } catch (e) {
    fail++;
    console.log('  ✗ 异常：' + ((e && e.stack) || e));
  }

  try { proc.kill(); } catch (e) { /* ignore */ }
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
