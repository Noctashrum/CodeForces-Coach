/**
 * 看一眼某个会话里到底发生了什么：用户说了什么、教练调了哪些工具、产出了什么。
 * 排查"工具调用混乱 / 没出图 / 重复验证"这类问题时，比翻日志快得多。
 *
 * 用法：node .probe/inspect-conv.js <会话文件路径> [内容截断长度]
 */
'use strict';
const fs = require('fs');

const file = process.argv[2];
const cut = parseInt(process.argv[3] || '700', 10);
if (!file || !fs.existsSync(file)) {
  console.error('用法：node .probe/inspect-conv.js <conversation.json> [截断长度]');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('模式:', j.mode, '| 意图:', j.intent, '| 模型:', j.model, '| 标题:', j.title);
console.log('cfProblem:', JSON.stringify(j.cfProblem), '| 会话内题面:', String(j.statementText || '').length, '字');
console.log('消息数:', j.messages.length);

j.messages.forEach((m, i) => {
  const tools = (m.tools || []).map((t) => t.name + (t.ok === false ? '✗' : '') + '(' + Math.round((t.ms || 0) / 1000) + 's)');
  console.log('\n===== #' + i + ' ' + m.role + (m.status ? ' [' + m.status + ']' : '')
    + ' 正文 ' + String(m.content || '').length + ' 字'
    + (m.richDoc ? ' | richDoc ' + m.richDoc.length + ' 字' : ' | 无文档'));
  if (tools.length) console.log('工具链: ' + tools.join(' → '));
  if (m.role === 'user') {
    console.log('用户说: ' + JSON.stringify(String(m.content || '').slice(0, 300)));
    return;
  }
  const c = String(m.content || '');
  console.log('--- 正文开头 ---\n' + c.slice(0, cut));
  console.log('--- 正文结尾 ---\n' + c.slice(-Math.min(300, c.length)));
  const tableRows = (c.match(/^\s*\|/gm) || []).length;
  const fences = (c.match(/```/g) || []).length;
  console.log('统计：表格行 ' + tableRows + '｜代码围栏 ' + fences + '｜SVG ' + (c.match(/<svg/g) || []).length);
  (m.tools || []).forEach((t) => {
    console.log('  · ' + t.name + ' ok=' + t.ok + ' ' + Math.round((t.ms || 0) / 1000) + 's :: '
      + String(t.summary || '').replace(/\s+/g, ' ').slice(0, 220));
  });
});
