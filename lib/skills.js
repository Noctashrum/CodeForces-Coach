/**
 * skills.js — cf-coach 的 skill 加载器（零依赖，自包含）。
 *
 * 设计要点（为什么是自己写而不是接外部框架）：
 *  1. **skill 是本项目的一部分**，放在仓库的 `skills/` 下，随 Git 走，不依赖任何外部目录约定；
 *  2. **目录是唯一事实来源**：提示词不散落在 JS 里，改讲解风格 = 改 Markdown，不需要改代码；
 *  3. **目录（catalog）与正文（body）分离**：常驻系统提示词的只有 name + description（几十字），
 *     正文只在真的用到时才注入——这样加 skill 不会线性推高每轮的 prefill。
 *
 * 文件格式（与业界通用的 SKILL 约定一致，将来要对接别的运行时也不用改文件）：
 *
 *   skills/                       ← 根目录
 *     cf-verify/                  ← 目录包
 *       SKILL.md                  ← frontmatter + 正文
 *       DESIGN.md                 ← 附带资源（正文里用相对路径引用）
 *     cf-fetch.md                 ← 也可以是平铺单文件
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const BODY_CACHE = new Map();   // path -> { mtimeMs, body }

/** 极简 YAML frontmatter 解析：只支持 `key: value` 与 `key: "quoted"`，够用且没有依赖 */
function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: text };
  const head = text.slice(3, end);
  let body = text.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  const data = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[m[1]] = v;
  }
  return { data, body: body.trim() };
}

/** 读取单个 skill 文件（带 mtime 缓存，避免每轮重复读盘） */
function readSkillFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = BODY_CACHE.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { data, body } = parseFrontmatter(raw);
  const entry = { mtimeMs: stat.mtimeMs, data, body, file };
  BODY_CACHE.set(file, entry);
  return entry;
}

/**
 * 扫描 skills 根目录。发现规则：
 *   - `<name>/SKILL.md`（目录包，资源与它同目录）
 *   - `<name>.md`（平铺单文件）
 * 嵌套的深层 SKILL.md **不**被发现（避免把 spec/ 之类的目录误当 skill）。
 */
function list(root) {
  const dir = root || SKILLS_DIR;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    let file = null;
    let resourceDir = dir;
    if (ent.isDirectory()) {
      const cand = path.join(full, 'SKILL.md');
      if (fs.existsSync(cand)) { file = cand; resourceDir = full; }
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      file = full;
    }
    if (!file) continue;
    const parsed = readSkillFile(file);
    if (!parsed) continue;
    const name = String(parsed.data.name || '').trim() || ent.name.replace(/\.md$/i, '');
    const description = String(parsed.data.description || '').trim();
    if (!name || !description) continue;   // 没有 description 的 skill 无法被路由，直接跳过
    // 下划线开头 = 内部文件（如教练人格 _coach.md）：由系统提示词直接加载，不进可调用技能目录
    const internal = ent.name.startsWith('_') || name.startsWith('_');
    if (internal || String(parsed.data['disable-model-invocation'] || '').toLowerCase() === 'true') continue;
    out.push({
      name,
      description,
      whenToUse: String(parsed.data.whenToUse || '').trim(),
      resourceDir,
      file,
      order: out.length
    });
  }
  return out;
}

/**
 * 常驻系统提示词的**目录**（catalog）。
 * 刻意只给 name + description：正文按需注入，目录要足够短才能常驻。
 */
function catalog(root) {
  const items = list(root);
  if (!items.length) return '';
  return [
    '<skills>',
    '技能是一组"怎么做某类事"的可复用指令。下面是本会话可用的技能目录（只有摘要）：',
    '',
    ...items.map((s) => '- `' + s.name + '`：' + s.description),
    '',
    '当任务命中某个技能的描述时，先调用 `skill` 工具（参数 name=<技能名>）读取它的完整指令，**再动手**。',
    '目录里只有摘要，不要凭摘要猜测技能内容。',
    '</skills>'
  ].join('\n');
}

/** 读一个 skill 的完整正文（含资源目录提示） */
function load(name, root) {
  const items = list(root);
  const hit = items.find((s) => s.name === name);
  if (!hit) return null;
  const parsed = readSkillFile(hit.file);
  if (!parsed) return null;
  return {
    name: hit.name,
    description: hit.description,
    resourceDir: hit.resourceDir,
    body: parsed.body
  };
}

/** 把 skill 正文渲染成注入用的块（与目录同一套语义，便于模型识别） */
function render(skill) {
  if (!skill) return '';
  const lines = ['<skill_content name="' + skill.name + '">'];
  if (skill.resourceDir) {
    lines.push('<skill_resources>');
    lines.push('这个技能的资源目录：' + skill.resourceDir);
    lines.push('技能正文里提到的相对路径，都相对这个目录解析；按需读取引用的资源。');
    lines.push('</skill_resources>');
  }
  lines.push('<skill_instructions>');
  lines.push(skill.body);
  lines.push('</skill_instructions>');
  lines.push('</skill_content>');
  return lines.join('\n');
}

/** 供界面展示：技能清单 */
function summary(root) {
  return list(root).map((s) => ({ name: s.name, description: s.description, dir: s.resourceDir }));
}

/**
 * 读内部文件（下划线开头的 skill，如 `_coach.md`）的正文。
 * 这类文件承载"系统提示词"这类不面向模型路由的内容，所以要绕过 list() 的过滤。
 */
function loadInternal(name, root) {
  const dir = root || SKILLS_DIR;
  const file = path.join(dir, name.endsWith('.md') ? name : name + '.md');
  const parsed = readSkillFile(file);
  return parsed ? parsed.body : '';
}

module.exports = { SKILLS_DIR, list, catalog, load, render, summary, loadInternal, parseFrontmatter };
