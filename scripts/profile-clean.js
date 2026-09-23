'use strict';
/**
 * profile-clean.js — 清理被污染的信息卡（把"单轮事件 / 教练产出 / 实现细节"从宏观画像里剔掉）。
 *
 * 为什么需要：信息卡偶尔会混进"从单轮表现推出来的"条目（例如"能快速抓分割结构"这类只反映某一题的说法）
 * 或教练产出的影子。`lib/profile.js` 的守卫挡住了日常增量污染，这个工具用来**体检并清理已有卡片**。
 *
 * 用法：
 *   node scripts/profile-clean.js --check          只体检、打印将被剔除的条目
 *   node scripts/profile-clean.js --apply          备份后写回（备份为 profile-card.backup-<时间>.json）
 *   node scripts/profile-clean.js --file <路径>    指定信息卡文件（默认取数据目录/data 下的 profile-card.json）
 */
const fs = require('fs');
const path = require('path');
const pf = require('../lib/profile');

function resolveFile(argFile) {
  if (argFile) return path.resolve(argFile);
  const candidates = [
    process.env.CHATBOX_DATA_DIR ? path.join(process.env.CHATBOX_DATA_DIR, 'profile-card.json') : '',
    path.join(__dirname, '..', 'data', 'profile-card.json'),
    path.join(__dirname, '..', 'dist', 'CFCoach-win32-x64', 'data', 'profile-card.json')
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[candidates.length - 1];
}

/** 把画像正文里"从本次对话里推出来的句子"整句删掉（保留宏观部分） */
function cleanProfileText(text) {
  const s = String(text || '').trim();
  if (!s) return { text: '', removed: [] };
  const removed = [];
  const parts = s.split(/[。；]/).map((x) => x.trim()).filter(Boolean);
  const kept = parts.filter((p) => {
    const bad = pf.EVENT_WORDS.test(p) || pf.AI_ATTRIB.test(p) || pf.DETAIL_PATTERN.test(p);
    if (bad) removed.push(p);
    return !bad;
  });
  return { text: kept.join('。') + (kept.length ? '。' : ''), removed };
}

/** 二字实词片段（用于判断某条目是不是"从被删的那句话里推出来的"） */
function shingles(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 与"被删掉的单轮句子"共享二字片段的条目 → 判定为**从这一轮推出来的**，一并剔除。
 * 例：句子含"前缀条件/分割/贪心/空间" → 条目"前缀区间条件混淆""能快速抓分割结构""贪心取右挤压空间"被剔除；
 * 而"边界样例自检不足""高难题落地不完整"不含这些片段 → 保留。
 */
function dropSessionDerived(items, removedText) {
  const pool = new Set();
  removedText.forEach((t) => shingles(t).forEach((x) => pool.add(x)));
  const kept = [];
  const dropped = [];
  (items || []).forEach((it) => {
    const hit = [...shingles(it)].filter((x) => pool.has(x));
    if (hit.length) dropped.push({ item: it, why: '与单轮描述共现（' + hit.slice(0, 3).join('/') + '）' });
    else kept.push(it);
  });
  return { kept, dropped };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.indexOf('--apply') >= 0;
  const fileArg = args.indexOf('--file') >= 0 ? args[args.indexOf('--file') + 1] : '';
  const file = resolveFile(fileArg);
  if (!fs.existsSync(file)) {
    console.error('找不到信息卡文件: ' + file);
    process.exit(1);
  }
  const card = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = {
    profileText: card.profileText || '',
    strengths: card.strengths || [],
    weaknesses: card.weaknesses || [],
    focus: card.focus || []
  };

  const textClean = cleanProfileText(before.profileText);
  // 共现过滤只作为**建议**（二字片段容易误伤"贪心熟练（44 题）"这种真宏观条目），
  // 真正删哪些由 --drop 显式指定，删错了也能从备份恢复。
  const sSug = dropSessionDerived(before.strengths, textClean.removed);
  const wSug = dropSessionDerived(before.weaknesses, textClean.removed);
  const dropIdx = args.indexOf('--drop');
  const explicit = [];
  if (dropIdx >= 0) {
    for (let i = dropIdx + 1; i < args.length && args[i].indexOf('--') !== 0; i++) explicit.push(args[i]);
  }
  const dropSet = new Set(explicit);
  const keepSet = new Set((() => {
    const ki = args.indexOf('--keep');
    const out = [];
    if (ki >= 0) for (let i = ki + 1; i < args.length && args[i].indexOf('--') !== 0; i++) out.push(args[i]);
    return out;
  })());
  const applyDrop = (items) => (items || []).filter((x) => !dropSet.has(x) || keepSet.has(x));
  const textDropIdx = args.indexOf('--text-drop');
  if (textDropIdx >= 0) {
    for (let i = textDropIdx + 1; i < args.length && args[i].indexOf('--') !== 0; i++) {
      const clause = args[i];
      if (clause && textClean.text.indexOf(clause) >= 0) {
        textClean.text = textClean.text.replace(clause, '').replace(/[，、；]{2,}/g, '，').replace(/，。/g, '。');
        textClean.removed.push(clause);
      }
    }
  }
  const textCleanFinal = textClean;
  const checked = pf.validateCardUpdate({
    profileText: textCleanFinal.text,
    strengths: applyDrop(before.strengths),
    weaknesses: applyDrop(before.weaknesses),
    focus: applyDrop(before.focus)
  }, { profileText: textCleanFinal.text, strengths: [], weaknesses: [], focus: [] });

  const after = {
    profileText: textClean.text,
    strengths: checked.card.strengths,
    weaknesses: checked.card.weaknesses,
    focus: checked.card.focus
  };

  console.log('信息卡: ' + file);
  const show = (label, b, a) => {
    console.log('\n【' + label + '】');
    if (Array.isArray(b)) {
      b.forEach((x) => console.log('  ' + (a.indexOf(x) >= 0 ? '保留' : '剔除') + '  ' + x));
    } else if (b !== a) {
      console.log('  原：' + b);
      console.log('  新：' + a);
    } else {
      console.log('  （不变）' + a);
    }
  };
  show('画像正文', before.profileText, after.profileText);
  show('优势', before.strengths, after.strengths);
  show('短板', before.weaknesses, after.weaknesses);
  show('讲解重点', before.focus, after.focus);
  if (textClean.removed.length) {
    console.log('\n从画像正文里删掉的句子（单轮事件/教练产出/实现细节）：');
    textClean.removed.forEach((x) => console.log('  · ' + x));
  }
  const allDropped = checked.rejected;
  if (allDropped.length) {
    console.log('\n被机械守卫拒收的条目（单轮事件 / 教练产出 / 实现细节 / 过长）：');
    allDropped.forEach((r) => console.log('  · [' + r.kind + '] ' + r.item + ' —— ' + r.why));
  }
  const sug = sSug.dropped.concat(wSug.dropped);
  if (sug.length) {
    console.log('\n【建议删除】（与该轮单轮描述共现，可能只是"这一题的表现"；用 --drop 显式确认）：');
    sug.forEach((r) => console.log('  · ' + r.item + ' —— ' + r.why));
  }
  if (explicit.length) console.log('\n本次 --drop 指定：\n  · ' + explicit.join('\n  · '));

  if (!apply) {
    console.log('\n（只体检，未写回。确认无误后加 --apply 写回，会自动备份）');
    return;
  }
  const backup = file.replace(/\.json$/, '.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.copyFileSync(file, backup);
  const next = Object.assign({}, card, {
    profileText: after.profileText,
    strengths: after.strengths,
    weaknesses: after.weaknesses,
    focus: after.focus,
    cleanedAt: Date.now()
  });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  console.log('\n已写回: ' + file + '\n备份: ' + backup);
}

main();
