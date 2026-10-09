/**
 * verify-pack.js — 核对打包产物里到底有没有本轮改动的关键代码。
 *
 * 为什么需要：`npm run pack` 是"复制目录"，很容易出现"改了源码但包里还是旧的"
 * （本项目就踩过一次：源码已修好，用户手里的 exe 仍带旧 UI）。
 * 所以每次打完包都应该跑一遍这个脚本，而不是凭感觉。
 *
 * 用法：node scripts/verify-pack.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'dist', 'CFCoach-win32-x64', 'resources', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const has = (haystack, needle) => String(haystack).indexOf(needle) >= 0;

const checks = [];
function check(label, file, needles) {
  let text = '';
  try { text = read(file); } catch (e) { checks.push([label, false, '读不到 ' + file]); return; }
  const missing = needles.filter((n) => !has(text, n));
  checks.push([label, missing.length === 0, missing.length ? '缺少：' + missing.join(' / ') : 'ok']);
}

check('复盘页：进度面板', 'public/js/review.js', ['renderProgress', 'rv-progress', 'rv-bar-fill']);
check('复盘页：SSE 进度读取', 'public/js/review.js', ['getReader', "type === 'item'", 'conversationId']);
check('复盘页：挑战兜底按钮', 'public/js/review.js', ['rv-challenge', 'doChallenge', '/api/review/challenge']);
// 超时/无题解要**分开显示**：文案在服务端产生，UI 按 editorial 字段上色
check('复盘页：区分超时与"没有题解"', 'public/js/review.js', ["it.editorial === 'timeout'", 'rv-pitem ', '📖']);
check('复盘页：事件委派（点按钮有反应）', 'public/js/review.js', ['function bindStatic', "body.addEventListener('click'"]);
check('复盘页：失败可见（不再静默）', 'public/js/review.js', ['state.error', '拉取失败']);
check('复盘页：题解 entry 输入框', 'public/js/review.js', ['rv-entry', 'parseEntryId']);
check('服务端：装材料进度事件', 'server.js', ["send('item'", "send('start'", "send('done'"]);
check('服务端：挑战兜底端点', 'server.js', ['/api/review/challenge', 'setChallengeWindowOpener']);
check('服务端：题解 entryId 直连', 'server.js', ['entryId', 'budgetMs']);
check('服务端：复盘会话带材料', 'server.js', ['/api/review/session', '赛后复盘材料']);
check('主进程：浏览器串行队列', 'electron/main.js', ['withBrowserNav', 'browserNavLock']);
check('主进程：复用已打开页面（跳过重复导航）', 'electron/main.js', ['复用已打开的页面', 'sameUrl']);
check('主进程：人工兜底窗口', 'electron/main.js', ['openChallengeWindow', 'cf-open-challenge-window']);
check('主进程：题解按结构切分', 'electron/main.js', ['SOLUTION_SPOILERS', 'isSolutionSpoiler', 'solSpoilers']);
check('主进程：公式在浏览器里还原（不是服务端正则）', 'electron/main.js', ['replaceMath', 'data-mathml', 'fromCharCode(96)']);
check('预加载：挑战桥', 'electron/preload.js', ['openChallengeWindow', 'cf-fetch-editorial']);
check('库：MathJax 还原与切分', 'lib/cfreview.js', ['editorialHtmlToText', 'splitEditorialByProblem', 'decodeEntities']);
check('库：复盘聚合与罚时口径', 'lib/cfreview.js', ['penaltyApprox', 'failedSubmissions', 'reviewBundle']);
check('技能：五个工作流 + 人格', 'skills/_coach.md', ['证据优先', '追问就是追问']);
check('技能：复盘流程', 'skills/cf-review/SKILL.md', ['赛后复盘', '不要编造']);

// 诊断包：设置页按钮 → 服务端路由 → 采集库三段必须在包里（否则用户在最需要它的那台机器上导不出来）
check('诊断包：采集库', 'lib/diagbundle.js', ['API key', 'pickDataDir', 'cf-diag.log', '##########']);
check('诊断包：服务端路由', 'server.js', ['/api/diag/export', '/api/diag/save', 'diagbundle']);
check('诊断包：设置页入口', 'public/js/app.js', ['data-ds-diag', 'data-ds-diagfile', '/api/diag/export']);
check('诊断包：主进程交底 userData（免得靠猜 APPDATA）', 'electron/main.js', ['CFCOACH_USER_DATA']);

// 取题：可见窗口接管时的 -3 重试。158A 实测（2026-10-05）：hidden 阶段超时后，
// 可见窗口因为 loadURL().catch 这条路径没过滤 -3，0.5 秒就判失败 → 表现为"稳定扒不到题"。
check('取题：可见窗口接管时的 -3 重试', 'electron/main.js', ['isAbortError', 'startLoad', '初始导航被取代']);

// 批次②：多解题不再一律"判不了" —— 本地 checker 库 + 它接进 harness 的多解题站点。
// 判据必须三态可分：合法（checker-ac）/ 不合法（checker-wa）/ 判不了（回落 multi-answer-undecidable）。
check('多解 checker：本地 checker 库', 'lib/checker.js', ['resolve', 'runOnce', 'selfTest', 'judgeSol']);
check('多解 checker：接进 harness 的多解题站点',
  'lib/harness.js', ['checkerLib', 'ensureChecker', 'checker-ac', 'checker-wa', 'multi-answer-undecidable']);

// 批次③-修订（2026-10-10 用户口径）：太慢要**在同一门语言里**改快，换语言只是默认关掉的 A/B 旋钮。
// 默认路径必须在包里：同语言优化提问 + 四步验收 + 成功/失败两种轨迹 + 默认关的语言闸。
check('同语言性能优化：接在性能闸里的默认路径',
  'lib/harness.js', ['perfRepairConfig', 'langSwitchEnabled', 'tryPerfRepair', 'perf-repair-ok', 'perf-repair-reject', '语言不许换']);
check('题解关思考：截断家族的实验旋钮（默认关）',
  'lib/harness.js', ['codeEffortNone', 'o.codeEffort', 'probe-sol-arms']);

// 批次④-第一刀（2026-10-10）：性能闸必须按**题面真实上限**计时，不许把自造的档说成"题面上限"。
// 活例子：2250C 旧闸拿 n=200000/值≤200 跑出 134ms 就写 claimVerified，尺子在真实上限上是 3.8s slow。
check('性能闸口径：题面规模解析库', 'lib/limits.js',
  ['parseNumExpr', 'flattenStatement', 'scanStatement', 'resolveGateScale', 'scaleLabel', 'DEFAULT_MAX_VALUE']);
check('性能闸口径：闸按题面解析出的上限计时（env 是显式覆盖）',
  'lib/harness.js', ['limitsLib', 'resolveGateScale', 'maxNOverride', 'scaleNotes', 'gateLine', '自造最大档']);
// 容差内已超时限也必须说出来（2250C 复跑：闸 2072ms / 时限 2000ms，尺子判 slow）
check('性能闸口径：容差内已超题面时限要如实告知', 'lib/harness.js', ['overTl', '已经超过题面时限']);

// 打包器必须把 exe 标成 GUI 子系统（不弹终端）
const packSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pack.js'), 'utf8');
checks.push(['打包器：GUI 子系统（不弹终端）', has(packSrc, 'Console: false'), has(packSrc, 'Console: false') ? 'ok' : '缺少 win32metadata.Console=false']);

let bad = 0;
console.log('核对打包产物: ' + APP + '\n');
for (const [label, ok, detail] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (ok ? '' : '  ← ' + detail));
}
console.log('\n' + (bad ? ('有 ' + bad + ' 项没进包 —— 重新跑 npm run pack') : '全部通过（本轮改动都在包里）'));
process.exitCode = bad ? 1 : 0;
