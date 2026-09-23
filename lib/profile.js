'use strict';
/**
 * profile.js — 学员信息卡的更新纪律（宏观能力画像，不是流水账）。
 *
 * 信息卡的用途是让教练评估**宏观能力与长短板**，因此它必须抵御两种污染：
 *  · **归因错位**：把教练给出的题解/讲解算成学员的成果；
 *  · **流水账**：把"这一轮把 X 写成了 Y"这类单轮事件与实现细节塞进长短板列表。
 *
 * 三条纪律：
 *  ① **只认学员自己的行为证据**（他写的代码 / 他问的问题 / 他的 AC 分布），**绝不用教练给出的题解或讲解**当证据；
 *  ② **只写持久特征**（跨题目反复出现的），单轮事件、实现细节、一次性的对错都不许进卡；
 *  ③ **没有新证据就不更新**（机械闸门直接跳过，连模型都不调）。
 */

/** 明确指向"这一轮/教练产出"的措辞——出现即判为幻觉或流水账 */
const EVENT_WORDS = /(本次|这一轮|这轮|刚才|刚刚|上面|上述|此次|上一题|这道题|该题|本题|今天|昨天)/;
const AI_ATTRIB = /(AI|助手|模型|教练|系统|题解|讲解|对拍|生成器|harness|给出的代码|生成的代码)/i;
/** 焦点建议里允许提"讲解"（那本来就是教练要做的事），但不许把学员没做过的事写成他的能力 */
const AI_ATTRIB_FOCUS = /(AI|助手|模型|系统|学员的?题解|生成的代码|harness)/i;
/** 单轮实现细节（"把 X 写成了 Y" 这类），属于过程而非能力 */
const DETAIL_PATTERN = /(写成了?|写错|错写成|误写|漏了|漏写|忘了|少写|多写|下标|循环边界|变量名|读入|输出格式|样例没过|WA 在|RE 在|TLE 在)/;
/**
 * 提问算不算"有信息量的学员侧证据"。
 * 判据要**严**：问教练自己代码的细节（"第 12 行为什么这么写"）不是学员能力信号，
 * 只有"他自己的想法/他自己的代码/他碰到的困难/他想学的概念"才算。
 */
const QUESTION_MARK = /(我(的|写|用|想|不会|没懂|一直|总是|经常|搞不懂|不理解|卡在)|搞不懂|不会写|卡住|错在哪|为什么不行|为什么错|能不能用|可不可以|行不行|能写吗|能过吗|复杂度|超时|TLE|WA|RE|证明|边界|套路|模板|怎么(写|做|想)|如何(写|做))/i;

/** 单条画像条目的长度上限（超过就说明它在讲一件事，而不是一个特征） */
const ITEM_MAX = 14;
const MAX_ITEMS = { strengths: 4, weaknesses: 4, focus: 3 };

/**
 * 机械闸门：这一轮到底有没有"关于学员本人"的新证据？
 * @param {object} o { intent, userText, userCode, minimalCase, userCodeFailed, problemMeta, messageCount }
 * @returns {{ok:boolean, evidence:string[], kinds:string[]}}
 */
function collectEvidence(o) {
  const opt = o || {};
  const evidence = [];
  const kinds = [];
  const userCode = String(opt.userCode || '').trim();
  const userText = String(opt.userText || '').trim();

  // ① 学员自己写了代码（代码评估意图）——最强证据
  const failed = opt.userCodeFailed != null
    ? !!opt.userCodeFailed
    : !!(opt.minimalCase && opt.minimalCase.from === 'user-vs-brute');
  if (userCode.length > 40) {
    kinds.push('user-code');
    evidence.push('学员自己写的代码（' + userCode.split('\n').length + ' 行，语言 ' + (opt.lang || 'cpp') + '）'
      + '；与暴力解对拍结果：' + (failed
        ? '存在反例（最小反例：' + String((opt.minimalCase && opt.minimalCase.input) || '').slice(0, 120).replace(/\n/g, ' ⏎ ') + '）'
        : '未复现错误'));
  }
  // ② 学员自己的提问：只取他问的"知识点层面"的那部分（去掉贴的代码、题面正文与纯题号）
  const ask = userText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/(?:CF|Codeforces|codeforces)\s*[-#:：]?\s*\d{2,5}\s*[-_ ]?\s*[A-Za-z][0-9]?/g, ' ')
    .replace(/\d{3,5}\s*[-_ ]?\s*[A-Za-z][0-9]?\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const substantive = ask.length >= 10 && QUESTION_MARK.test(ask);
  if (substantive && ask.length <= 400) {
    kinds.push('user-question');
    evidence.push('学员这次的提问：「' + ask.slice(0, 200) + '」');
  }
  // ③ 题目难度相对他的水平（只在明显偏难/偏易时才算证据）
  const rating = Number((opt.problemMeta && opt.problemMeta.rating) || 0);
  const avg = Number((opt.cfAvgSolvedRating || 0));
  if (rating && avg && Math.abs(rating - avg) >= 250) {
    kinds.push('difficulty-gap');
    evidence.push('这题官方难度 ' + rating + '，而他 AC 的平均难度是 ' + avg
      + (rating > avg ? '（明显偏难）' : '（明显偏易）'));
  }
  return { ok: kinds.length > 0, evidence, kinds };
}

/**
 * 机械守卫：把模型给的画像条目过滤成"持久特征"。
 * 过滤掉：指向本轮/教练产出的、讲单轮实现细节的、过长的、空话的。
 */
function validateCardUpdate(parsed, current) {
  const cur = current || {};
  const rejected = [];
  const clean = (arr, kind) => {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach((raw) => {
      const t = String(typeof raw === 'object' && raw ? (raw.text || raw.item || '') : raw || '').trim();
      if (!t) return;
      if (t.length > ITEM_MAX) { rejected.push({ kind, item: t, why: '过长（像在讲一件事而不是一个特征）' }); return; }
      if (EVENT_WORDS.test(t)) { rejected.push({ kind, item: t, why: '指向单轮事件' }); return; }
      const attribRe = kind === 'focus' ? AI_ATTRIB_FOCUS : AI_ATTRIB;
      if (attribRe.test(t)) { rejected.push({ kind, item: t, why: '把教练的产出算到学员头上' }); return; }
      if (kind !== 'focus' && DETAIL_PATTERN.test(t)) { rejected.push({ kind, item: t, why: '单轮实现细节，不是能力特征' }); return; }
      if (out.indexOf(t) < 0 && out.length < MAX_ITEMS[kind]) out.push(t);
    });
    return out;
  };
  const strengths = clean(parsed && parsed.strengths, 'strengths');
  const weaknesses = clean(parsed && parsed.weaknesses, 'weaknesses');
  const focus = clean(parsed && parsed.focus, 'focus');
  let profileText = String((parsed && parsed.profileText) || '').trim();
  if (EVENT_WORDS.test(profileText) || AI_ATTRIB.test(profileText) || DETAIL_PATTERN.test(profileText)) {
    rejected.push({ kind: 'profileText', item: profileText.slice(0, 60), why: '画像正文里混入了单轮细节/教练产出' });
    profileText = String(cur.profileText || '');
  }
  if (profileText.length > 200) profileText = profileText.slice(0, 200);
  const kept = strengths.length + weaknesses.length + focus.length;
  const proposed = ((parsed && parsed.strengths) || []).length + ((parsed && parsed.weaknesses) || []).length + ((parsed && parsed.focus) || []).length;
  // 大多数条目都被判为幻觉 → 整次更新作废，保留旧卡（宁可不动，也不污染）
  const ok = kept > 0 && (proposed === 0 || kept / proposed >= 0.5);
  return {
    ok,
    card: {
      profileText: profileText || String(cur.profileText || ''),
      strengths: strengths.length ? strengths : (cur.strengths || []),
      weaknesses: weaknesses.length ? weaknesses : (cur.weaknesses || []),
      focus: focus.length ? focus : (cur.focus || [])
    },
    rejected
  };
}

/** 学情分析 Agent 的系统提示词：宏观、有据、只认学员自己的行为 */
const ANALYST_SYSTEM = [
  '你是算法教练团队里的【学情分析师】。你要维护的是学员的**宏观能力画像**（长处 / 短板 / 讲解重点），',
  '它会被讲解 Agent 用来调整讲法与深浅，所以**只写持久特征，不写流水账**。',
  '',
  '【铁律（违反即不合格）】',
  '1. **只依据"学员自己的行为证据"**：他写的代码、他问的问题、他的 AC 分布与难度。',
  '   **绝不**把教练给出的题解、讲解、对拍结论当成学员的能力（那是系统的产出，不是他的）；',
  '2. **不写单轮事件**：不许出现"本次/这一轮/这道题/刚才"这类限定词，不许记录"他这次把 X 写成了 Y"；',
  '   只有**跨题目反复出现**的倾向才配进卡；证据不足就**保守不动**（沿用旧条目）；',
  '3. 每条 ≤12 字，是一个**能力特征**（如"贪心实现稳""状态定义偏弱"），不是一句话描述；',
  '   优势 ≤4 条、短板 ≤4 条、讲解重点 ≤3 条；',
  '4. 与旧卡**合并更新**（补充/替换/删除），不要重复、不要堆叠同义条目；',
  '5. 硬数据（rating / AC 数 / 平均难度 / 标签分布）由系统填，你不用复述。',
  '',
  '只输出一个 JSON 对象，不要任何其它文字：',
  '{"profileText":"2-3 句宏观画像（不许出现单轮事件与教练产出）",',
  ' "strengths":["能力特征"],"weaknesses":["能力特征"],"focus":["讲解重点建议"],',
  ' "usedEvidence":["你用了哪几条证据"]}'
].join('\n');

module.exports = {
  collectEvidence, validateCardUpdate, ANALYST_SYSTEM,
  EVENT_WORDS, AI_ATTRIB, DETAIL_PATTERN, ITEM_MAX, MAX_ITEMS
};
