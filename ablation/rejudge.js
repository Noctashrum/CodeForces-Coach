'use strict';

/**
 * 用**修好的 CF-AC 尺子**重判一个跑分目录里的全部记录。
 *
 *   node ablation/rejudge.js [--store ablation/out/ui] [--out <file>] [--only 2268C,2267B]
 *                           [--levels L0,L0C,L1,L2] [--latest] [--limit N]
 *                           [--tiers 30,200,2000] [--generous 20000] [--gen-dir <别的store>,...]
 *                           [--problems <problems.json>]   （跑分目录里没有 problems.json 时用）
 *
 * 为什么是**串行**的：这一关要拿"真实时限"判 TLE，并发跑会让被测程序抢 CPU，
 * 把"超时"和"被挤慢"混为一谈 —— 计时结论必须单线程跑出来。也别和别的重活同时跑。
 *
 * 判据（三条同时成立才是 CF-AC，详见 ablation/lib/ruler.js）：
 *   ① 官方样例全过  ② 与外部 AC 提交在 [30,2000] 等规模档上随机对拍一致  ③ 最大规模、真实时限内跑得动
 * 旧口径（judge.js）只做了 ① 和"玩具规模"的 ②，所以它会把"小规模正确的暴力解"记成 AC。
 *
 * 输出：
 *   <store>/verdicts-cfac.jsonl   每条记录一行（含 startedAt，可与 records.jsonl 对齐）
 *   控制台：逐条进度 + 逐档汇总 + **旧口径 vs CF-AC 逐格对照表**
 */

const fs = require('fs');
const path = require('path');
const ruler = require('./lib/ruler');
const judge = require('./judge');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const a = { store: path.join(__dirname, 'out', 'ui'), levels: null, only: null, latest: false, limit: 0, tiers: null, generous: 0, oracleMs: 0, oracleTries: 0 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--store') a.store = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--only') a.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--levels') a.levels = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (k === '--latest') a.latest = true;
    else if (k === '--limit') a.limit = Number(argv[++i]) || 0;
    else if (k === '--tiers') a.tiers = String(argv[++i]).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    else if (k === '--generous') a.generous = Number(argv[++i]) || 0;
    else if (k === '--oracle-ms') a.oracleMs = Number(argv[++i]) || 0;
    else if (k === '--oracle-tries') a.oracleTries = Number(argv[++i]) || 0;
    else if (k === '--gen-dir') a.genDirs = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--problems') a.problems = argv[++i];
    else if (k === '--store' === k) { /* noop */ }
  }
  if (!a.out) a.out = path.join(a.store, 'verdicts-cfac.jsonl');
  return a;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}

function fmtMs(ms) { return ms == null ? '—' : (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'); }
function pct(n, d) { return d ? Math.round((n / d) * 100) + '%' : '—'; }

async function main() {
  const args = parseArgs(process.argv);
  const store = path.resolve(args.store);
  const problemsFile = args.problems ? path.resolve(ROOT, args.problems) : path.join(store, 'problems.json');
  const raw = JSON.parse(fs.readFileSync(problemsFile, 'utf8'));
  const all = raw.problems || raw.all || raw;
  const byId = {};
  for (const p of all) byId[p.id] = p;

  const cacheDir = path.join(ROOT, 'data', 'cf-problems');
  const overrides = ruler.loadOverrides(store);
  // cost-sample 这类目录只有 records 没有生成器 —— 允许借别的 store 的 tier-aware 生成器
  const genRoots = (args.genDirs || []).map((d) => path.resolve(ROOT, d));

  let records = readJsonl(path.join(store, 'records.jsonl'));
  if (args.only) records = records.filter((r) => args.only.includes(r.problem));
  if (args.levels) records = records.filter((r) => args.levels.includes(String(r.level).toUpperCase()));
  if (args.latest) {
    const last = {};
    for (const r of records) last[r.level + '|' + r.problem] = r;
    records = Object.keys(last).map((k) => last[k]);
  }
  if (args.limit) records = records.slice(0, args.limit);

  const oldVerdicts = readJsonl(path.join(store, 'verdicts.jsonl'));
  const oldByKey = {};
  for (const v of oldVerdicts) oldByKey[v.level + '|' + v.problem] = v;

  console.log('重判目录 : ' + store);
  console.log('记录条数 : ' + records.length + '（串行跑；' + (args.latest ? '每格只取最后一条' : '全部记录') + '）');
  console.log('对拍规模 : ' + (args.tiers || ruler.DIFF_TIERS).join('/') + '，最大规模关：题面最大档 + 真实时限');
  console.log('');

  const out = fs.createWriteStream(args.out, { flags: 'w' });
  const results = [];
  const basisSeen = {};
  const t0 = Date.now();
  let n = 0;

  for (const rec of records) {
    n++;
    const p = byId[rec.problem];
    const tag = '[' + String(n).padStart(3) + '/' + records.length + '] ' + rec.level + ' ' + rec.problem;
    if (!p) {
      console.log(tag + ' → 题库里没有这道题，跳过');
      const v = { level: rec.level, problem: rec.problem, startedAt: rec.startedAt, cfac: false, verdict: 'no-problem' };
      results.push(v); out.write(JSON.stringify(v) + '\n');
      continue;
    }
    if (!basisSeen[rec.problem]) {
      basisSeen[rec.problem] = true;
      const lim = ruler.resolveLimits(p, { overrides, cacheDir });
      const sc = ruler.resolveScale(p, { overrides });
      const g = ruler.resolveGen(store, p, { genRoots });
      console.log('  · 尺子依据 ' + rec.problem + ' (r' + p.rating + ')：时限 ' + lim.timeLimitMs + 'ms(' + lim.source + ')，maxN=' + sc.maxN + '(' + sc.source + ')，maxV=' + sc.maxV + '，生成器 ' + (g ? g.from + (g.tierAware ? '' : '/弱') : '无'));
    }
    const started = Date.now();
    let v;
    try {
      v = await ruler.runRuler({
        storeDir: store, problem: p, code: rec.code, codeLang: rec.codeLang,
        cacheDir, tiers: args.tiers || ruler.DIFF_TIERS, generousMs: args.generous || undefined,
        oracleMs: args.oracleMs || undefined, oracleTries: args.oracleTries || undefined,
        overrides, genRoots
      });
    } catch (e) {
      v = { cfac: false, verdict: 'ruler-crash', detail: String((e && e.message) || e).slice(0, 300) };
    }
    const row = Object.assign({
      level: rec.level, problem: rec.problem, startedAt: rec.startedAt, model: rec.model,
      codeLang: rec.codeLang, codeSource: rec.codeSource, codeLen: (rec.code || '').length,
      cost: rec.cost && rec.cost.amount != null ? rec.cost.amount : null, secs: Number(((Date.now() - started) / 1000).toFixed(1))
    }, v);
    results.push(row);
    out.write(JSON.stringify(row) + '\n');

    const diffTxt = (v.diffs || []).map((d) => d.tier + ':' + (d.status === 'same' ? 'same' : d.status)).join(' ');
    const maxTxt = v.maxScale
      ? ('max ' + (v.maxScale.measuredMs == null ? '超时' : fmtMs(v.maxScale.measuredMs)) + '/oracle ' + fmtMs(v.maxScale.oracleMs) + ' TL' + v.timeLimitMs)
      : '';
    console.log(tag + ' → ' + (v.verdict || '?') + (v.cfac ? '  ★CF-AC' : '') + '  (' + row.secs + 's)  ' + diffTxt + '  ' + maxTxt + (v.detail ? '  ' + String(v.detail).slice(0, 80) : ''));
  }
  out.end();

  /* ------------------------------------------------------------ 汇总 */
  const summary = ruler.summarizeCfac(results);
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);

  console.log('');
  console.log('================ 新口径（CF-AC） ================');
  const levelOrder = ['L0', 'L0C', 'L1', 'L2'].filter((l) => summary[l]);
  for (const lv of Object.keys(summary)) {
    const g = summary[lv];
    console.log(lv.padEnd(4) + ' n=' + String(g.total).padStart(3)
      + '  CF-AC ' + String(g.cfac).padStart(2) + '(' + pct(g.cfac, g.total) + ')'
      + '  样例AC ' + String(g.sampleAC).padStart(2)
      + '  差分AC ' + String(g.diffAC).padStart(2)
      + '  | no-code ' + g.noCode + '  gen-weak ' + g.genWeak + '  no-gen ' + g.noGen
      + '  TLE ' + g.tle + '  slow ' + g.slow + '  WA ' + g.wa
      + '  RE ' + g.re + '  oracle坏 ' + g.oracleBroken);
  }

  // 花费与 ¥/CF-AC
  console.log('');
  console.log('---- 花费与 ¥/CF-AC（只算有 cost 的记录） ----');
  if (summary.__order) delete summary.__order;
  for (const lv of Object.keys(summary)) {
    const g = summary[lv];
    if (!g.costTotal) continue;
    console.log(lv.padEnd(4) + ' 花费 ¥' + g.costTotal.toFixed(3) + '  CF-AC ' + g.cfac
      + '  → ¥/CF-AC ' + (g.cfac ? '¥' + (g.costTotal / g.cfac).toFixed(3) : '—'));
  }

  /* ------------------------------------------- 旧口径 vs CF-AC 逐格对照 */
  if (oldVerdicts.length) {
    console.log('');
    console.log('=========== 旧口径 vs CF-AC（每格取该档最后一条记录） ===========');
    const levels = levelOrder;
    const cells = {};
    for (const r of results) cells[r.problem + '|' + r.level] = r;   // results 已按 records 顺序 → 后写的即最后一条
    const ids = Object.keys(byId).filter((id) => levels.some((lv) => cells[id + '|' + lv]));
    ids.sort((a, b) => (byId[b].rating || 0) - (byId[a].rating || 0));
    let head = '题'.padEnd(8) + 'rating'.padEnd(7);
    for (const lv of levels) head += (lv + ' 旧→新').padEnd(20);
    console.log(head);
    const tally = {};
    for (const id of ids) {
      let line = id.padEnd(8) + String(byId[id].rating || '').padEnd(7);
      for (const lv of levels) {
        const rec = cells[id + '|' + lv];
        const old = oldByKey[lv + '|' + id];
        const oldStrict = !!(old && old.diffVerdict === 'AC' && !old.deliveredBrute);
        const oldTxt = old ? (old.sampleVerdict === 'AC' ? (old.diffVerdict === 'AC' ? (old.deliveredBrute ? '降级AC' : 'AC') : String(old.diffVerdict)) : String(old.sampleVerdict)) : '—';
        const newTxt = rec ? (rec.cfac ? 'CF-AC' : String(rec.verdict)) : '—';
        // 都判 AC / 旧 AC 新不 AC / 旧不 AC 新 AC
        const key = (lv) + ':' + (oldStrict ? (rec && rec.cfac ? 'keep' : 'lost') : (rec && rec.cfac ? 'gain' : 'none'));
        tally[key] = (tally[key] || 0) + 1;
        line += (oldTxt + ' → ' + newTxt).padEnd(20);
      }
      console.log(line);
    }
    console.log('');
    console.log('---- 格子级变化（旧严格 AC 为基准） ----');
    for (const k of Object.keys(tally).sort()) console.log('  ' + k.replace(':', ' ') + ' : ' + tally[k]);
  }

  const lost = results.filter((r) => {
    const old = oldByKey[r.level + '|' + r.problem];
    return old && old.diffVerdict === 'AC' && !old.deliveredBrute && !r.cfac;
  });
  console.log('');
  console.log('旧口径判过、新尺子判不过的记录 ' + lost.length + ' 条：');
  for (const r of lost) console.log('  ' + r.level + ' ' + r.problem + ' → ' + r.verdict + (r.maxScale ? ' (max ' + fmtMs(r.maxScale.measuredMs) + ' / TL ' + r.timeLimitMs + ')' : ''));

  console.log('');
  console.log('跑完 ' + results.length + ' 条，用时 ' + minutes + ' 分钟，结果写入 ' + args.out);
}

main().catch((e) => { console.error(e); process.exit(1); });
