/**
 * loopguard.js — **死循环特征检测**：用"这一轮有没有带回新信息"取代"无脑掐时间/次数"。
 *
 * 起因（用户 2026-10 的复盘，原话）：
 *   「你为什么要加上限？无非怕死循环嘛！那你怕死循环你的关键是要找什么条件什么特征下被判定为
 *     死循环了，而不是直接无脑用时间上限来判断啊是不是！」
 *   「在时间和 token 限制的情况下，agent 一旦发现预算不足，打表是最优解……你工资不给够还想让
 *     工人干活你觉得可能吗？」
 *
 * ⚠️ 本模块里**没有阈值、没有 N 次、没有分数**。第一版曾写 `minRepeat=2 / stallRounds=2`，
 *    那只是把"猜一个够用的上限"从分钟数换成了轮数——**同一个错误的两种写法**（用户当场指出）。
 *    现在每一条判据都是**集合成员关系或相邻相等**，不是"攒够几次"：
 *
 *   1. repeat      这一轮产出的产物签名**之前已经出现过**（`Set.has`）→ 同一个东西又交了一遍
 *   2. oscillate   产出的签名 = 往上隔一个出现过的那个（A→B→A）→ 在两种改法之间来回
 *   3. no-new-info 这一轮拿到的**失败信息签名之前已经出现过**（`Set.has`）→ 没有带回任何新东西
 *
 *    为什么"没出现过的失败信息"才值得再试一次：每次重写都是**独立一问**（带上 prevCode 与
 *    失败证据，没有累积对话）。所以能改变下一次提问的只有"新的失败信息"——同一档、同一种死法、
 *    同一个反例，喂第二遍时那次提问与刚失败的那次信息量相同，再试就是纯掷骰子。
 *    反过来，失败**换了一档/换了一种死法**（tier4 WA → tier8 WA、WA → TLE、样例从 1/3 过到 2/3）
 *    就算新信息，会继续放行。
 *
 * 本模块是**纯函数**：不读文件、不发请求、不看时钟（时限/次数上限仍留在调用方作为最后兜底）。
 */

'use strict';

/** 稳定短哈希（djb2 → base36）。只用于"是不是同一个东西"的比较，不做任何安全用途。 */
function hashSig(s) {
  const str = String(s == null ? '' : s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + str.length;
}

/**
 * 代码签名：忽略空行、行首尾空白与**整行注释**。
 * 只改了注释或缩进的"重写"在语义上等于没改 → 必须与上一版算出同一个签名，否则死循环检测会失效。
 */
function codeSig(code) {
  const lines = String(code == null ? '' : code)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(\/\/|#|\/\*+|\*|--)/.test(l));
  return hashSig(lines.join('\n'));
}

/** 把一组片段折成一个签名（用于"这一步干了什么 + 拿到了什么"） */
function signature(parts) {
  return hashSig((Array.isArray(parts) ? parts : [parts]).map((p) => String(p == null ? '' : p)).join('\u0001'));
}

/**
 * 重试回路守卫。
 * @param {object} [o]
 * @param {string} [o.label] 人类可读的名字（如"暴力解重写"），只用于写停手原因
 * @returns {{stopped:object|null, marks:function, note:function}}
 *   note(rec)：
 *     rec.sig        这一轮**产物**的签名（通常 `codeSig(code)`）
 *     rec.evidence   这一轮拿到的**失败信息**的签名（同一档 + 同一种死法 + 同一个反例）
 *     rec.tag        人类可读的这一轮状态（只用于写原因，不参与判定）
 */
function createGuard(o) {
  o = o || {};
  const label = o.label || '重试';
  const seenProducts = new Set();
  const seenEvidence = new Set();
  const history = [];
  let stopped = null;

  function stop(kind, reason) {
    stopped = { action: 'stop', kind, reason, marks: history.slice(), attempts: history.length };
    return stopped;
  }

  return {
    /** 已经停手过就返回当时的原因（幂等：调用方可以放心重复查询） */
    get stopped() { return stopped; },
    marks: () => history.slice(),
    note(rec) {
      if (stopped) return stopped;
      const sig = String((rec && rec.sig) || '');
      const evidence = String((rec && rec.evidence) || '');
      const tag = String((rec && rec.tag) || '');
      history.push({ sig, evidence, tag });
      const n = history.length;

      /* ① 同一个产物又出现了一次 —— 最硬的死循环证据（重写产出了与之前相同的东西） */
      if (sig && seenProducts.has(sig)) {
        const prev = history.length >= 2 ? history[history.length - 2].sig : '';
        const prev2 = history.length >= 3 ? history[history.length - 3].sig : '';
        if (prev && prev !== sig && prev2 === sig) {
          return stop('oscillate', label + '在**两个版本之间来回震荡**（A→B→A，第 ' + n
            + ' 次的产物与第 ' + (n - 2) + ' 次相同）→ 这不是在收敛，停手');
        }
        return stop('repeat', label + '第 ' + n + ' 次拿到的产物和之前**一模一样**（签名 ' + sig
          + (tag ? '，状态 ' + tag : '') + '）→ 再试一次不会有任何新信息');
      }

      /* ② 失败信息与之前某一次完全相同 —— 没有带回新东西，下一次提问的信息量不会变 */
      if (evidence && seenEvidence.has(evidence)) {
        return stop('no-new-info', label + '第 ' + n + ' 次的失败信息和之前**完全相同**（'
          + (tag || evidence) + '）→ 没有带回任何新东西，再试一次不会有新信息');
      }

      if (sig) seenProducts.add(sig);
      if (evidence) seenEvidence.add(evidence);
      return { action: 'ok', kind: 'ok', reason: '' };
    }
  };
}

module.exports = { hashSig, codeSig, signature, createGuard };
