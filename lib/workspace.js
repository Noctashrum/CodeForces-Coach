/**
 * lib/workspace.js — 每题专用工作区（教练对拍 harness 的缓冲区）
 *
 * 目录结构： <数据目录>/workspace/<会话ID>/
 *   sol.cpp / sol.py     题解代码（保留）
 *   brute.cpp           暴力对拍代码（对拍通过后清理）
 *   gen.py              样例生成器（对拍通过后清理）
 *   fail.txt            最后一个反例（不匹配的输入）
 *   result.json         最近一次验证结果
 *   meta.json           题目信息与验证状态（供界面与系统提示词使用）
 *
 * 每个会话 = 一道题，所以用会话 ID 做目录名，天然隔离、互不干扰。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 400 * 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const ALLOWED_EXT = new Set(['cpp', 'cc', 'cxx', 'py', 'js', 'txt', 'md', 'in', 'out', 'json', 'log', 'html']);

let rootDir = null;

/** 由 server.js 注入数据目录 */
function setRoot(dir) {
  rootDir = dir ? path.join(dir, 'workspace') : null;
  if (rootDir) { try { fs.mkdirSync(rootDir, { recursive: true }); } catch (e) { /* ignore */ } }
}

function convDir(convId) {
  const id = String(convId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !rootDir) return null;
  return path.join(rootDir, id);
}

function ensure(convId) {
  const dir = convDir(convId);
  if (!dir) throw new Error('工作区不可用');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function langOf(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'js') return 'js';
  return '';
}

/** 校验文件名（防目录穿越与奇怪后缀） */
function checkName(name) {
  const n = String(name || '').trim();
  if (!SAFE_NAME_RE.test(n) || n.includes('..')) throw new Error('非法文件名：' + name);
  const ext = n.split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error('不支持的文件类型：.' + ext + '（可用：' + [...ALLOWED_EXT].join('/') + '）');
  return n;
}

function fileInfo(dir, name) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return null;
  const st = fs.statSync(full);
  if (!st.isFile()) return null;      // 只列文件（cache/ 子目录单独管理）
  return { name, size: st.size, mtime: st.mtimeMs, lang: langOf(name) };
}

/**
 * 缓存键：按题号共享（同题缓存），没有题目时退回会话 ID。
 * 这样"换意图 / 重开会话 / 再问同一道题"都能复用已验证的题解、暴力解与生成器。
 */
function keyFor(conv) {
  const p = conv && conv.cfProblem;
  if (p && p.contestId && p.index) return 'cf-' + p.contestId + String(p.index).toUpperCase();
  return String((conv && conv.id) || 'unknown');
}

/* ---------------- 已验证产物缓存（清理临时区时不清它） ---------------- */

function cacheDirFor(key) {
  const dir = convDir(key);
  return dir ? path.join(dir, 'cache') : null;
}

function cacheVerified(key, files) {
  const dir = cacheDirFor(key);
  if (!dir) return { cached: [] };
  fs.mkdirSync(dir, { recursive: true });
  const cached = [];
  for (const name of Object.keys(files || {})) {
    const content = files[name];
    if (!content || !String(content).trim()) continue;
    try {
      checkName(name);
      fs.writeFileSync(path.join(dir, name), String(content), 'utf8');
      cached.push(name);
    } catch (e) { /* 忽略单个文件失败 */ }
  }
  return { cached };
}

function readCache(key, name) {
  const dir = cacheDirFor(key);
  if (!dir) return '';
  try {
    checkName(name);
    const full = path.join(dir, name);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  } catch (e) {
    return '';
  }
}

function listCache(key) {
  const dir = cacheDirFor(key);
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).map((n) => fileInfo(dir, n)).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function listFiles(convId) {
  const dir = convDir(convId);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => fileInfo(dir, f))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function writeFile(convId, name, content) {
  const dir = ensure(convId);
  const n = checkName(name);
  const text = String(content == null ? '' : content);
  if (text.length > MAX_FILE_BYTES) throw new Error('文件过大（上限 ' + Math.round(MAX_FILE_BYTES / 1024) + 'KB）');
  fs.writeFileSync(path.join(dir, n), text, 'utf8');
  return { name: n, bytes: Buffer.byteLength(text, 'utf8'), lang: langOf(n), lines: text.split('\n').length };
}

function readFile(convId, name) {
  const dir = ensure(convId);
  const n = checkName(name);
  const full = path.join(dir, n);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

function filePath(convId, name) {
  const dir = convDir(convId);
  if (!dir) return null;
  const n = checkName(name);
  return path.join(dir, n);
}

function removeFile(convId, name) {
  const dir = convDir(convId);
  if (!dir) return false;
  const n = checkName(name);
  const full = path.join(dir, n);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

/** 清理临时区：默认只保留题解（sol.*），删掉暴力/生成器/反例等 */
function clearScratch(convId, keepPrefixes) {
  const dir = convDir(convId);
  if (!dir || !fs.existsSync(dir)) return { removed: [] };
  const keep = Array.isArray(keepPrefixes) && keepPrefixes.length ? keepPrefixes : ['sol', 'meta.json'];
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    const kept = keep.some((k) => f === k || f.startsWith(k + '.'));
    if (kept) continue;
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch (e) { /* ignore */ }
  }
  return { removed };
}

function loadMeta(convId) {
  try {
    const raw = readFile(convId, 'meta.json');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function patchMeta(convId, patch) {
  const cur = loadMeta(convId);
  const next = Object.assign({}, cur, patch, { updatedAt: Date.now() });
  try { writeFile(convId, 'meta.json', JSON.stringify(next, null, 2)); } catch (e) { /* ignore */ }
  return next;
}

/** 记录一次验证结果（对拍/样例），供界面展示与系统提示词引用 */
function recordVerification(convId, info) {
  const patch = { verification: Object.assign({ at: Date.now() }, info) };
  if (info && info.verdict === 'mismatch' && info.input != null) {
    try { writeFile(convId, 'fail.txt', String(info.input)); } catch (e) { /* ignore */ }
  }
  return patchMeta(convId, patch);
}

/** 汇总（给 UI 与系统提示词） */
function summary(convId) {
  const files = listFiles(convId);
  const meta = loadMeta(convId);
  const names = files.map((f) => f.name);
  return {
    files,
    meta,
    verification: meta.verification || null,
    hasSol: names.some((n) => /^sol\./.test(n)),
    hasBrute: names.some((n) => /^brute\./.test(n)),
    hasGen: names.some((n) => /^gen\./.test(n))
  };
}

/** 题解文件名（按语言） */
function solName(lang) {
  return lang === 'python' ? 'sol.py' : (lang === 'js' ? 'sol.js' : 'sol.cpp');
}
function bruteName(lang) {
  return lang === 'python' ? 'brute.py' : (lang === 'js' ? 'brute.js' : 'brute.cpp');
}
function genName(lang) {
  return lang === 'python' ? 'gen.py' : (lang === 'js' ? 'gen.js' : 'gen.cpp');
}

/**
 * 删掉一个工作区（按 key：既可能是按题号共享的 `cf-2269D`，也可能是会话私有的 `conv-xxx`）。
 *
 * 为什么需要它：用户删对话时按"全删"理解（真实反馈："我删除肯定是全删啊"），
 * 而工作区是按题号共享的缓存——不显式删掉它，下次问同一题还会命中旧结论，
 * 既不符删除语义，也让人没法测试"重新对拍"。
 * @returns {boolean} 是否真的删掉了东西
 */
function removeWorkspace(key) {
  const dir = convDir(key);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 这个工作区里有没有已验证通过的产物（前端据此决定删除时要不要提示） */
function hasVerified(key) {
  const meta = loadMeta(key) || {};
  return !!(meta.verification && meta.verification.status === 'ok');
}

module.exports = {
  setRoot, convDir, ensure, listFiles, writeFile, readFile, removeFile, filePath,
  clearScratch, loadMeta, patchMeta, recordVerification, summary, langOf, checkName,
  solName, bruteName, genName,
  keyFor, cacheVerified, readCache, listCache, removeWorkspace, hasVerified
};
