/**
 * patch-explain-skill.js — 把 cf-explain 里"文档是可选项"的过时口径改成"完整讲解必交付图文文档"。
 * 口径变化的原因见 server.js 里那段文档提醒的注释：图文讲解是本产品的核心交付形态，
 * 而旧文案写的是"默认 Markdown，用户明确要图文时才出文档"，模型照着做 → 用户拿到纯文字（真实反馈两次）。
 *
 * 用法：node .probe/patch-explain-skill.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'skills', 'cf-explain', 'SKILL.md');
let s = fs.readFileSync(file, 'utf8');

const oldSection = [
  '## 3. 交付形式',
  '',
  '- 默认：**对话里的 Markdown**。短平快，学员读完就能懂。',
  '- 用户明确要"图文/文档/图解/生动一点"，或者这题的算法**确实需要一张图才说得清**时：用 `cf_doc` 出一份 HTML 文档。'
].join('\n');

const newSection = [
  '## 3. 交付形式（完整讲解 = 图文文档，这是硬要求）',
  '',
  '- **完整讲解的交付物是"对话正文 + 一份图文文档"**：最后一步**必须**调用 `cf_doc` 产出 HTML 文档。',
  '  正文只留 1–2 句引子 + 关键结论（不要把文档内容再复述一遍，文档就渲染在消息下面）。',
  '  这一点没有例外：学员点开就是"图文讲解"，只给 Markdown 会被当成没做完（真实反馈两次都是这个原因）。',
  '- 只有这两种情况**不**出文档：① 用户明确只要思路（"给点思路 / 先别给答案"）；② 你只是在追问里补一句解释。',
  '- 文档至少要 1 张**真图解**（有节点与连线的 SVG；**表格不算图**，把表格画成 SVG 也不算）。',
  '  画哪张：算法状态怎么一步步变、数据结构长什么样、构造怎么摆、或者反例/边界长什么样。'
].join('\n');

if (s.indexOf(oldSection) < 0) {
  console.error('没找到旧文案，可能已经改过；请人工确认。');
  process.exit(1);
}
s = s.replace(oldSection, newSection);
fs.writeFileSync(file, s);
console.log('cf-explain 交付形式已更新');
