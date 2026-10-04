/**
 * L1（裸 agent）的工具面。
 *
 * ⚠️ 这是消融实验里**故意最小**的工具集合：只有"文件 + 运行 + 对拍"三件事，
 * 不含 cf-coach 的任何 harness（没有题面整理 agent、没有"正解/暴力/生成器"三件套自动生成、
 * 没有判据归一化层之上的证据门、没有 cf_doc 文档系统）。L2 的增量就是这些。
 *
 * 所有文件访问都被限制在**本次运行自己的临时目录**里（path 越界直接报错）。
 * 对拍直接复用主程序 lib/runner.js 的 stressTest —— 对拍这个"动作"三档都一样，
 * 差别只在于"谁被要求去做、以及有没有人替他做"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const runner = require('../../lib/runner');

const MAX_OUT = 4000;

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > (n || MAX_OUT) ? t.slice(0, n || MAX_OUT) + '\n…（已截断）' : t;
}

function safeJoin(dir, p) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, String(p || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径越界：' + p + '（只能在本次运行的工作目录内读写）');
  return abs;
}

function langOfFile(file, fallback) {
  const f = String(file || '').toLowerCase();
  if (f.endsWith('.py')) return 'python';
  if (f.endsWith('.cpp') || f.endsWith('.cc') || f.endsWith('.cxx')) return 'cpp';
  return fallback || 'cpp';
}

/** 本机运行时的说明（写进工具描述，避免模型交一个本机跑不了的 C++） */
async function runtimeHint() {
  const f = await runner.availableRuntimes();
  const ok = [];
  if (f.cpp) ok.push('C++ (g++)');
  if (f.python) ok.push('Python 3');
  if (f.js) ok.push('Node.js');
  if (!ok.length) return '⚠️ 本机没有任何可用运行时：编译/运行/对拍全都跑不了，只能纯推理回答。';
  return '本机可用运行时：' + ok.join('、') + (f.cpp ? '' : '（请一律用 Python 写代码）');
}

async function createL1Tools(opts) {
  const dir = path.resolve(opts.dir);
  const flags = await runner.availableRuntimes();
  const defaultLang = flags.python ? 'python' : 'cpp';
  const stressIterations = Math.max(1, Math.min(parseInt(opts.iterations, 10) || 30, 500));

  const readPart = (file, inlineCode, lang) => {
    if (inlineCode && String(inlineCode).trim()) {
      return { lang: lang || defaultLang, code: String(inlineCode) };
    }
    if (!file) throw new Error('既没给文件也没给代码');
    const f = safeJoin(dir, file);
    if (!fs.existsSync(f)) throw new Error('文件不存在：' + path.relative(dir, f));
    return { lang: lang || langOfFile(file, defaultLang), code: fs.readFileSync(f, 'utf8') };
  };

  const tools = [
    {
      name: 'write_file',
      description: '把内容写入工作目录里的文件（path 用相对文件名，如 solution.py / brute.py / gen.py）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      },
      execute: async (a) => {
        const f = safeJoin(dir, a.path);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const body = String(a.content == null ? '' : a.content);
        fs.writeFileSync(f, body, 'utf8');
        return '已写入 ' + path.relative(dir, f) + '（' + Buffer.byteLength(body, 'utf8') + ' 字节）';
      }
    },
    {
      name: 'read_file',
      description: '读取工作目录里的文件内容',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      execute: async (a) => {
        const f = safeJoin(dir, a.path);
        if (!fs.existsSync(f)) return '文件不存在：' + a.path;
        return clip(fs.readFileSync(f, 'utf8'));
      }
    },
    {
      name: 'list_files',
      description: '列出工作目录里的文件与大小',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const names = fs.readdirSync(dir);
        if (!names.length) return '（工作目录是空的）';
        return names.map((n) => {
          let size = 0;
          try { size = fs.statSync(path.join(dir, n)).size; } catch { /* 忽略 */ }
          return n + '  ' + size + ' 字节';
        }).join('\n');
      }
    },
    {
      name: 'run_code',
      description: '编译并运行工作目录里的一个文件，把 input 作为标准输入喂进去，返回 stdout / stderr / 耗时 / 判定。' + (flags.cpp ? '' : '（没有 g++，只能用 Python）'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作目录里的文件名，如 solution.py' },
          input: { type: 'string', description: '标准输入内容（可空）' },
          lang: { type: 'string', enum: ['cpp', 'python'], description: '留空则按扩展名判断' }
        },
        required: ['path']
      },
      execute: async (a) => {
        const f = safeJoin(dir, a.path);
        if (!fs.existsSync(f)) return '文件不存在：' + a.path;
        const lang = a.lang === 'python' ? 'python' : (a.lang === 'cpp' ? 'cpp' : langOfFile(a.path, defaultLang));
        if (lang === 'cpp' && !flags.cpp) return '本机没有 g++，跑不了 C++；请改用 Python 重写。' + runtimeHint();
        const pick = runner.pickLang(lang, flags);
        if (pick.unavailable) return runtimeHint();
        const code = fs.readFileSync(f, 'utf8');
        const input = a.input == null ? '' : String(a.input);
        const r = await runner.runSamples({ lang: pick.lang, code, samples: [{ input, output: null }], timeLimitMs: runner.RUN_TIMEOUT_MS });
        if (!r.ok) return '运行失败：' + r.error;
        const one = (r.results && r.results[0]) || {};
        const lines = ['判定：' + one.verdict + '｜耗时 ' + (one.timeMs || 0) + 'ms'];
        if (one.actual !== undefined && one.actual !== null) lines.push('--- 标准输出 ---\n' + clip(one.actual, 2000));
        if (one.err) lines.push('--- 错误输出 ---\n' + clip(one.err, 1200));
        return lines.join('\n');
      }
    },
    {
      name: 'stress_test',
      description: '对拍：拿"正解"和"暴力解"跑同一个随机数据生成器，逐组比对输出，返回第一组不一致的数据。'
        + '三个参数既可以是工作目录里的文件名（推荐：solution.py / brute.py / gen.py），也可以直接给代码字符串。'
        + '默认跑 ' + stressIterations + ' 组。',
      parameters: {
        type: 'object',
        properties: {
          solution: { type: 'string', description: '正解的文件名（或代码）' },
          brute: { type: 'string', description: '暴力解的文件名（或代码）' },
          gen: { type: 'string', description: '随机数据生成器的文件名（或代码）' },
          iterations: { type: 'number', description: '对拍组数，默认 ' + stressIterations }
        },
        required: ['solution', 'brute', 'gen']
      },
      execute: async (a) => {
        const isFile = (v) => typeof v === 'string' && !v.includes('\n') && /\.(py|cpp|cc|cxx|js)$/i.test(v.trim());
        try {
          const solution = isFile(a.solution) ? readPart(a.solution) : readPart(null, a.solution, defaultLang);
          const brute = isFile(a.brute) ? readPart(a.brute) : readPart(null, a.brute, defaultLang);
          const gen = isFile(a.gen) ? readPart(a.gen) : readPart(null, a.gen, defaultLang);
          const n = Math.max(1, Math.min(parseInt(a.iterations, 10) || stressIterations, 500));
          const r = await runner.stressTest({ solution, brute, gen, iterations: n, timeLimitMs: runner.RUN_TIMEOUT_MS, maxTotalMs: 120000 });
          if (!r.ok) return '对拍失败：' + r.error;
          if (r.status === 'ok') return '对拍通过：' + r.iterations + ' 组随机数据全部一致' + (r.note ? '（' + r.note + '）' : '');
          if (r.status === 'mismatch') {
            return '对拍发现不一致（第 ' + r.iteration + ' 组）\n--- 输入 ---\n' + clip(r.input, 1200)
              + '\n--- 暴力解输出 ---\n' + clip(r.expected, 1200) + '\n--- 正解输出 ---\n' + clip(r.actual, 1200);
          }
          return '对拍运行出错（' + r.which + '）：' + r.detail + (r.input ? '\n--- 输入 ---\n' + clip(r.input, 1200) : '');
        } catch (e) {
          return '对拍失败：' + ((e && e.message) || String(e));
        }
      }
    }
  ];
  return tools;
}

module.exports = { createL1Tools, runtimeHint, safeJoin };
