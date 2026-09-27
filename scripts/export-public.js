'use strict';
/**
 * export-public.js — 导出**可直接发到 git 仓库**的干净源码目录。
 *
 * 目标：只带代码与文档，**不带任何使用记录与个人信息**。
 *  ① 白名单复制（只挑源码/文档/资源，绝不整目录拷贝）——这样 data/、缓存、日志、打包产物天然进不来；
 *  ② 生成一份面向源码仓库的 `.gitignore`（排除运行时数据、构建产物、本机缓存）；
 *  ③ **导出后做一次个人信息扫描**：命中即报错退出（含 CF 用户名、绝对路径、API key 形态、会话/信息卡文件等）。
 *
 * 用法：
 *   node scripts/export-public.js                # 导出到 ../codeforces-coach-public（与本仓库同级）
 *   node scripts/export-public.js --out <目录>   # 指定输出目录
 *   node scripts/export-public.js --handle <CF用户名>   # 额外把该用户名加入扫描黑名单
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : '';
const handleArg = args.indexOf('--handle') >= 0 ? args[args.indexOf('--handle') + 1] : '';
const OUT = path.resolve(outArg || path.join(ROOT, '..', 'codeforces-coach-public'));

/** 要带走的文件/目录（白名单；顺序无关） */
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  '.gitignore',
  'server.js'
];
const INCLUDE_DIRS = ['lib', 'public', 'electron', 'scripts', 'build', '.probe'];

/** 目录内需要排除的文件（开发用夹具/产物） */
const EXCLUDE = [
  /(^|\/)node_modules($|\/)/,
  /(^|\/)\.git($|\/)/,
  /(^|\/)data($|\/)/,
  /(^|\/)dist($|\/)/,
  /(^|\/)\.test-data($|\/)/,
  /\.log$/,
  /\.tsbuildinfo$/,
  /(^|\/)\.pack-data-backup($|\/)/,
  /(^|\/)\.electron-cache($|\/)/,
  /(^|\/)\.npm-cache($|\/)/,
  /profile-card.*\.json$/,
  /profile-log\.jsonl$/,
  /(^|\/)meta\.json$/,
  // 探针的**运行产物**（日志/截图/真实模型输出的文档），探针脚本本身要带走
  /(^|\/)\.probe\/(rendered\.html|smoke\.png|.*\.txt|richdoc-.*\.html|srv-(out|err)\.txt)$/,
  /^\.cf-dump\//
];

const GITIGNORE = `# ---------------------------------------------------------------------------
# Runtime data — conversations, workspaces, learner profile, API keys.
# Never commit any of this.
# ---------------------------------------------------------------------------
data/
.test-data/

# Build & packaging output
dist/
build/*.blockmap
*.tgz

# Local caches & backups
.pack-data-backup/
.electron-cache/
.npm-cache/
*.backup-*.json
profile-log.jsonl

# Developer probe output (the probe scripts themselves are tracked)
.probe/rendered.html
.probe/*.txt
.probe/richdoc-*.html
.cf-dump/
smoke.png

# Editor / OS
node_modules/
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp
`;

function copyTree(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach((name) => {
      const s = path.join(src, name);
      const rel = path.relative(ROOT, s).replace(/\\/g, '/');
      if (EXCLUDE.some((re) => re.test(rel) || re.test(name))) return;
      copyTree(s, path.join(dest, name));
    });
  } else {
    const rel = path.relative(ROOT, src).replace(/\\/g, '/');
    if (EXCLUDE.some((re) => re.test(rel) || re.test(path.basename(rel)))) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** 个人信息 / 使用痕迹扫描：命中即视为导出失败 */
function scanForPersonalData(dir, handle) {
  const findings = [];
  // ① 绝对不能存在的运行时数据（目录/文件层面，最硬的判据）
  ['data', 'dist', '.test-data', 'node_modules', 'profile-card.json', 'profile-log.jsonl'].forEach((bad) => {
    if (fs.existsSync(path.join(dir, bad))) findings.push({ file: bad, kind: '运行时数据被混入', sample: bad });
  });
  // ② 文本层面的个人信息（代码里出现字段名是正常的，所以"数据形态"判据只对 json/jsonl 生效）
  const textPatterns = [
    { name: 'CF 用户名', re: handle ? new RegExp(handle, 'i') : null },
    { name: 'Windows 用户目录', re: /C:\\+Users\\+[A-Za-z0-9._-]+/ },
    // 注意：正则字面量里 `\\` 才表示"一个反斜杠"。这里曾写成 `\\\\`（要求两个反斜杠），
    // 于是真实路径（单反斜杠）全部漏检 —— 发布前扫描给了假绿灯。用 `\\+` 兜住两种写法。
    // 这里以前写死了开发机的文件夹名（等于把本机目录名抄进公开仓库），改成通用判据：
    // "盘符 + 反斜杠 + 至少一级目录" 就当作本机绝对路径。
    { name: '开发机绝对路径', re: /[A-Z]:\\+[\\/]?[^\\/\s"',)]+[\\/]/i },
    { name: '疑似 API key', re: /(sk-[A-Za-z0-9]{16,}|api[_-]?key["'\s:]+[A-Za-z0-9_-]{20,})/i },
    { name: '对话记录文件名', re: /c_mu[a-z0-9]{8,}\.json/ }
  ].filter((p) => p.re);
  const dataPatterns = [
    { name: '会话数据', re: /"(messages|conversationId)"\s*:\s*\[/ },
    { name: '学员画像数据', re: /"(profileText|strengths|weaknesses|focus)"\s*:\s*("|\[)/ }
  ];
  const walk = (d) => {
    fs.readdirSync(d).forEach((name) => {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); return; }
      if (st.size > 2 * 1024 * 1024) return;             // 大文件（vendor/图标）跳过
      if (!/\.(js|json|jsonl|md|html|css|txt|yml|yaml|sh|py)$/i.test(name)) return;
      // 扫描器自己的源码是"模式文本的载体"：正则字面量 /C:\\+Users\\+…/ 会被通用绝对路径
      // 判据匹配到（那是判据本身，不是使用痕迹）。只跳过这个文件，其余文件照旧全扫。
      if (name === 'export-public.js' && path.basename(d) === 'scripts') {
        console.log('  ℹ️ 跳过扫描器自身（scripts/export-public.js：内含判据文本，不是使用痕迹）');
        return;
      }
      const text = fs.readFileSync(p, 'utf8');
      textPatterns.forEach((pt) => {
        const m = text.match(pt.re);
        if (!m) return;
        // 唯一允许的例外：仓库所有者名出现在 package.json 的**公开元数据**里
        // （author / repository.url —— GitHub 仓库本来就公开这些，不属于"个人使用数据"）。
        // 判据很窄：必须是 package.json，且命中所在行就是 author / url 那一行；其余一律算问题。
        if (pt.name === 'CF 用户名' && name === 'package.json') {
          const hitLine = text.split('\n').find((l) => new RegExp(handle, 'i').test(l)) || '';
          if (/"(author|url)"\s*:/i.test(hitLine)) {
            console.log('  ℹ️ 允许：package.json 公开元数据里的仓库所有者名 → ' + hitLine.trim().slice(0, 60));
            return;
          }
        }
        findings.push({ file: path.relative(dir, p), kind: pt.name, sample: String(m[0]).slice(0, 60) });
      });
      if (/\.jsonl?$/i.test(name)) {
        dataPatterns.forEach((pt) => {
          const m = text.match(pt.re);
          if (m) findings.push({ file: path.relative(dir, p), kind: pt.name, sample: String(m[0]).slice(0, 60) });
        });
      }
    });
  };
  walk(dir);
  return findings;
}

function main() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  INCLUDE_FILES.forEach((f) => {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
  });
  INCLUDE_DIRS.forEach((d) => {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) copyTree(src, path.join(OUT, d));
  });
  fs.writeFileSync(path.join(OUT, '.gitignore'), GITIGNORE, 'utf8');

  // 统计 + 扫描
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    fs.readdirSync(d).forEach((name) => {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else { files++; bytes += st.size; }
    });
  };
  walk(OUT);

  console.log('导出目录: ' + OUT);
  console.log('文件数: ' + files + '，总大小: ' + (bytes / 1024 / 1024).toFixed(2) + ' MB');
  console.log('已排除: data/ dist/ .test-data/ node_modules/ 缓存与备份 / 会话与画像文件');

  const findings = scanForPersonalData(OUT, handleArg);
  if (findings.length) {
    console.error('\n❌ 扫描到可能的个人信息/使用痕迹，请先处理：');
    findings.slice(0, 20).forEach((f) => console.error('  · ' + f.file + ' [' + f.kind + '] ' + f.sample));
    process.exit(1);
  }
  console.log('✅ 个人信息扫描通过（未发现用户名 / 绝对路径 / 密钥 / 会话数据）');
  console.log('\n下一步：cd ' + OUT + ' && git init && git add -A && git commit -m "Initial commit"');
}

main();
