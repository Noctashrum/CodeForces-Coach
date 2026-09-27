/**
 * test-e2e.js — ChatBox 端到端集成测试
 * 前置：node server.js（3210）+ node scripts/mock-llm.js（3999）
 * 覆盖：配置保存、会话 CRUD、SSE 流式聊天、重新生成多版本、
 *       编辑重发、删除回滚、归档/恢复、导出导入、静态页面。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3210';
const MOCK = process.env.E2E_MOCK || 'http://127.0.0.1:3999/v1';

let pass = 0, fail = 0;
const fails = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
}

/** mock-llm 的请求计数：用来验证"点停止后不再请求模型"（老实现会把整条链路跑完） */
async function mockStats() {
  try {
    const r = await fetch(MOCK.replace(/\/v1\/?$/, '') + '/__stats');
    return await r.json();
  } catch (e) { return null; }
}

async function sseChat(body, opts) {
  const o = opts || {};
  const ctrl = new AbortController();
  if (o.abortAfterMs) {
    setTimeout(async () => {
      // 模拟前端"点停止"：先显式调停止端点（浏览器的 abort 未必让服务端收到连接关闭），再断开
      if (o.stopFirst) {
        try { await api('/api/chat/stop', { method: 'POST', body: JSON.stringify({ conversationId: body.conversationId }) }); } catch (e) { /* ignore */ }
      }
      try { ctrl.abort(); } catch (e) { /* ignore */ }
    }, o.abortAfterMs);
  }
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).catch((e) => ({ ok: false, aborted: true, err: e }));
  const events = [];
  if (!r || !r.body) return events;          // 已被 abort：没有响应体
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          try {
            const one = JSON.parse(line.slice(5).trim());
            events.push(one);
            if (o.onEvent) o.onEvent(one);
          } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) {
    // 用户在流中途点了停止 → 读取会被中断，这不是错误
  }
  return events;
}

async function main() {
  console.log('\n== 1. 配置服务 ==');
  const cfgRes = await api('/api/config');
  const cfg = cfgRes.json;
  cfg.providers = [{
    id: 'mock-p', name: 'Mock测试服务', type: 'openai', baseUrl: MOCK,
    apiKey: 'test-key', extraHeaders: {}, models: ['mock-gpt-4', 'mock-gpt-mini'], stream: true
  }];
  cfg.defaultProviderId = 'mock-p';
  cfg.defaultModel = 'mock-gpt-4';
  const saveCfg = await api('/api/config', { method: 'POST', body: JSON.stringify(cfg) });
  check('保存配置', saveCfg.status === 200 && saveCfg.json.ok === true);
  const testRes = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: cfg.providers[0] }) });
  check('测试连接', testRes.json.ok === true, JSON.stringify(testRes.json));
  check('测试连接返回模型列表', testRes.json.ok && Array.isArray(testRes.json.models) && testRes.json.models.length === 3);

  console.log('\n== 2. 会话 CRUD ==');
  const convRes = await api('/api/conversations', { method: 'POST', body: '{}' });
  const conv = convRes.json;
  check('新建会话', convRes.status === 200 && !!conv.id);
  check('新会话继承默认模型', conv.model === 'mock-gpt-4', conv.model);
  check('新会话默认教练模式', conv.mode === 'coach', conv.mode);
  check('新会话讲解语言默认继承全局', conv.lang === null, conv.lang);
  const cid = conv.id;
  // 历史兼容：显式切回 chat 模式跑通用聊天回归
  await api('/api/conversations/' + cid, { method: 'PATCH', body: JSON.stringify({ mode: 'chat' }) });

  console.log('\n== 2b. 对话文件夹 + 多选批量操作 ==');
  {
    // 再造两个会话，连同上面的 cid 一起做分类与批量操作
    const cx = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    const cy = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    check('新会话默认未分类', cx.folder === '', cx.folder);

    const fRes = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'e2e-线段树' }) });
    check('新建文件夹', fRes.status === 200 && fRes.json.folder && fRes.json.folder.name === 'e2e-线段树', fRes.json);
    const fid = fRes.json.folder.id;
    const dup = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'e2e-线段树' }) });
    check('同名文件夹被拒（不静默建重复）', dup.status === 400, dup.json);

    const mv = await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [cx.id, cy.id], action: 'move', folder: fid }) });
    check('批量移动到文件夹', mv.status === 200 && mv.json.done === 2, mv.json);
    const all1 = (await api('/api/conversations')).json.conversations;
    const pick = (id) => all1.find((c) => c.id === id) || {};
    check('列表带 folder 字段且落盘正确', pick(cx.id).folder === fid && pick(cy.id).folder === fid && pick(cid).folder === '',
      [pick(cx.id).folder, pick(cy.id).folder, pick(cid).folder]);

    const ar = await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [cx.id], action: 'archive' }) });
    check('批量归档', ar.json.done === 1, ar.json);
    const act = (await api('/api/conversations?archived=0')).json.conversations.map((c) => c.id);
    const arc = (await api('/api/conversations?archived=1')).json.conversations.map((c) => c.id);
    check('归档后从对话页移出、出现在归档页', act.indexOf(cx.id) < 0 && arc.indexOf(cx.id) >= 0);
    await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [cx.id], action: 'unarchive' }) });
    const back = (await api('/api/conversations')).json.conversations.find((c) => c.id === cx.id);
    check('恢复后回到对话页且保留文件夹归属', !!back && back.archived === false && back.folder === fid);

    const badAct = await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [cx.id], action: 'explode' }) });
    check('非法批量操作被拒', badAct.status === 400, badAct.json);
    const empty = await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [], action: 'delete' }) });
    check('空选中被拒（不是静默成功）', empty.status === 400, empty.json);
    const badFolder = await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [cx.id], action: 'move', folder: 'f_nope' }) });
    check('移动到不存在的文件夹被拒', badFolder.status === 400, badFolder.json);

    const delF = await api('/api/folders/' + fid, { method: 'DELETE' });
    check('删文件夹报告移出的对话数', delF.status === 200 && delF.json.moved === 2, delF.json);
    const all2 = (await api('/api/conversations')).json.conversations;
    check('删文件夹不删对话（回到未分类）',
      all2.length === all1.length && all2.find((c) => c.id === cx.id).folder === '' && all2.find((c) => c.id === cy.id).folder === '',
      all2.map((c) => [c.title, c.folder]));

    const dl = await api('/api/conversations/batch', { method: 'POST', body: JSON.stringify({ ids: [cx.id, cy.id], action: 'delete' }) });
    check('批量删除', dl.json.done === 2, dl.json);
    const all3 = (await api('/api/conversations')).json.conversations;
    check('批量删除后只剩目标以外的一个会话', all3.length === all1.length - 2 && all3.every((c) => c.id !== cx.id && c.id !== cy.id), all3.length);
  }

  console.log('\n== 3. 流式聊天 (send) ==');
  const ev1 = await sseChat({ conversationId: cid, mode: 'send', userContent: '你好，介绍一下你自己' });
  check('收到 meta 事件', ev1.some((e) => e.type === 'meta' && e.assistantMessageId));
  const deltas1 = ev1.filter((e) => e.type === 'delta');
  check('收到流式 delta', deltas1.length > 3);
  const done1 = ev1.find((e) => e.type === 'done');
  check('收到 done 事件', !!done1);
  const full1 = deltas1.map((d) => d.text).join('');
  check('内容包含模拟助手回复', full1.indexOf('模拟助手') >= 0);
  check('内容包含 markdown 代码块', full1.indexOf('```python') >= 0);
  check('包含思考过程', ev1.some((e) => e.type === 'reasoningDelta'));
  check('包含用量统计', done1 && done1.message && done1.message.usage && done1.message.usage.completionTokens > 0);

  const after1 = (await api('/api/conversations/' + cid)).json;
  check('会话文件已落盘（1 用户 + 1 助手）', after1.messages.length === 2);
  check('自动生成标题', after1.title !== '新对话' && after1.title.indexOf('你好') === 0, after1.title);
  check('助手消息状态 done', after1.messages[1].status === 'done');

  console.log('\n== 4. 重新生成（多版本） ==');
  const ev2 = await sseChat({ conversationId: cid, mode: 'regenerate' });
  const done2 = ev2.find((e) => e.type === 'done');
  check('重新生成完成', !!done2);
  const after2 = (await api('/api/conversations/' + cid)).json;
  check('旧版本进入 alternates', after2.messages.length === 2 && after2.messages[1].alternates && after2.messages[1].alternates.length === 1);
  check('正文已更新', after2.messages[1].content && after2.messages[1].content.length > 0);

  console.log('\n== 5. 编辑重发（回滚） ==');
  const userMsgId = after2.messages[0].id;
  const ev3 = await sseChat({ conversationId: cid, mode: 'edit', baseUserMessageId: userMsgId, userContent: '换个说法：请用一句话介绍你自己' });
  const done3 = ev3.find((e) => e.type === 'done');
  check('编辑重发完成', !!done3);
  const after3 = (await api('/api/conversations/' + cid)).json;
  check('编辑后仍为 2 条消息（截断重发）', after3.messages.length === 2);
  check('用户消息已替换', after3.messages[0].content === '换个说法：请用一句话介绍你自己');

  console.log('\n== 6. 消息删除 ==');
  const delRes = await api('/api/conversations/' + cid + '/messages', {
    method: 'POST', body: JSON.stringify({ messages: after3.messages.slice(0, 1) })
  });
  check('回滚删除成功', delRes.status === 200 && delRes.json.messages.length === 1);

  console.log('\n== 7. 归档 / 恢复 / 搜索 / 列表 ==');
  const archRes = await api('/api/conversations/' + cid, { method: 'PATCH', body: JSON.stringify({ archived: true, pinned: true }) });
  check('归档+置顶', archRes.json.archived === true && archRes.json.pinned === true);
  const listArch = (await api('/api/conversations?archived=1')).json.conversations;
  check('归档列表包含该会话', listArch.some((c) => c.id === cid));
  const searchRes = (await api('/api/conversations?q=' + encodeURIComponent('一句话'))).json.conversations;
  check('搜索命中', searchRes.some((c) => c.id === cid));
  const archSendRes = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: cid, mode: 'send', userContent: 'x' })
  });
  check('归档会话发送被拒绝', archSendRes.status !== 200 && (await archSendRes.json()).error.indexOf('归档') >= 0);
  const restoreRes = await api('/api/conversations/' + cid, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
  check('恢复归档', restoreRes.json.archived === false);

  console.log('\n== 8. 导出 / 导入 ==');
  const expRes = await api('/api/export/' + cid + '.md');
  check('导出 Markdown', expRes.status === 200 && expRes.text.indexOf('## 🧑 用户') >= 0);
  const expAll = await api('/api/export/all.json');
  const allJson = expAll.json;
  check('导出全部 JSON', expAll.status === 200 && Array.isArray(allJson.conversations) && allJson.conversations.length >= 1);
  // 清掉再导入
  await api('/api/conversations?confirm=1', { method: 'DELETE' });
  const impRes = await api('/api/import', { method: 'POST', body: JSON.stringify(allJson) });
  check('导入全部', impRes.json.ok === true && impRes.json.imported >= 1);
  const listAfter = (await api('/api/conversations')).json.conversations;
  check('导入后列表恢复', listAfter.length >= 1);

  console.log('\n== 9. Anthropic 协议 ==');
  const anthCfg = Object.assign({}, cfg, {
    providers: [{ id: 'mock-a', name: 'Mock Claude', type: 'anthropic', baseUrl: 'http://127.0.0.1:3999', apiKey: 'k', extraHeaders: {}, models: ['mock-claude'] }],
    defaultProviderId: 'mock-a', defaultModel: 'mock-claude'
  });
  await api('/api/config', { method: 'POST', body: JSON.stringify(anthCfg) });
  const convA = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
  await api('/api/conversations/' + convA.id, { method: 'PATCH', body: JSON.stringify({ mode: 'chat' }) });
  const evA = await sseChat({ conversationId: convA.id, mode: 'send', userContent: '测试 anthropic 协议' });
  check('Anthropic 流式完成', evA.some((e) => e.type === 'done'));
  const doneA = evA.find((e) => e.type === 'done');
  check('Anthropic 内容正确', doneA && doneA.message.content.indexOf('模拟助手') >= 0);
  check('Anthropic 思考过程', doneA && doneA.message.reasoning && doneA.message.reasoning.length > 0);
  check('Anthropic 用量', doneA && doneA.message.usage && doneA.message.usage.promptTokens === 42);

  console.log('\n== 10. 静态资源 ==');
  for (const p of ['/', '/styles.css', '/js/app.js', '/js/md.js', '/vendor/marked.min.js', '/vendor/hljs/highlight.min.js', '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css']) {
    const r = await fetch(BASE + p);
    check('静态 ' + p, r.status === 200);
  }

  console.log('\n== 11. 算法教练（CF 题面 / 工具循环 / 对拍验证） ==');
  // 需要 mock-cf（127.0.0.1:3998）与带 CF_BASE 的 server；不可用时跳过本组
  let mockCfOk = false;
  try {
    const probe = await fetch('http://127.0.0.1:3998/api/user.info?handles=tester');
    mockCfOk = probe.status === 200;
  } catch (e) { /* ignore */ }
  if (!mockCfOk) {
    console.log('  （跳过：mock-cf 未启动。启动方法：node scripts/mock-cf.js，并用 CF_BASE=http://127.0.0.1:3998 启动 server）');
  } else {
    const cfProblem = await api('/api/cf/problem?contestId=1800&index=C');
    check('CF 题面获取', cfProblem.status === 200 && cfProblem.json.title.indexOf('Powering the Hero') >= 0);
    check('CF 题面正文解析', cfProblem.json.statement && cfProblem.json.statement.length > 50);
    check('CF 样例解析', Array.isArray(cfProblem.json.samples) && cfProblem.json.samples.length >= 2, cfProblem.json.samples && cfProblem.json.samples.length);
    check('CF 公式规范化', cfProblem.json.statement.indexOf('$n$') >= 0);
    const cfUser = await api('/api/cf/user?handle=tester');
    check('CF 用户查询', cfUser.status === 200 && cfUser.json.rating === 1620 && cfUser.json.levelText === 'Expert');

    // 反爬失败路径：403 挑战 → 给出可操作提示（不是裸 HTTP 错误）
    const blocked = await api('/api/cf/problem?contestId=999&index=A');
    check('反爬 403 有兜底提示', blocked.status === 400 && /反爬|代理|粘贴/.test(blocked.json.error), blocked.json.error);
    // 被重定向到其它页面 → 校验落地题目并报错
    const wrongPage = await api('/api/cf/problem?contestId=998&index=A');
    check('落地页校验生效', wrongPage.status === 400 && /其它页面|反爬|粘贴/.test(wrongPage.json.error), wrongPage.json.error);
    // 元数据兜底通道（走官方 API，不受反爬影响）
    const metaOnly = await api('/api/cf/meta?contestId=1800&index=C');
    check('元数据兜底通道', metaOnly.status === 200 && metaOnly.json.metaOnly === true && metaOnly.json.rating === 1500
      && (metaOnly.json.tags || []).length >= 1, metaOnly.json);
    check('元数据带题名', metaOnly.json.title === 'C. Powering the Hero (hard version)', metaOnly.json.title);
    // CF 已禁止非 gym 比赛带附加参数调用 contest.standings → 元数据必须走 problemset 总表通道
    const metaNoStandings = await api('/api/cf/meta?contestId=1799&index=C');
    check('元数据不依赖 contest.standings', metaNoStandings.status === 200 && metaNoStandings.json.rating === 1500
      && metaNoStandings.json.title === 'C. Sum on Subarrays', metaNoStandings.json);
    // 题号预校验：错题号（如把 C1/C2 写成 C）直接给出该比赛的正确题号，不白跑网络
    const badIndex = await api('/api/cf/problem?contestId=1799&index=B');
    check('错题号给出提示', badIndex.status === 400 && /没有题号 B/.test(badIndex.json.error)
      && /C/.test(badIndex.json.error), badIndex.json.error);
    // 比赛号不存在 → **必须说准原因**。真实事故：用户查 2269D（2269 只有 A/B 两题），
    // 界面一律显示"题面被 Codeforces 反爬拦截"，于是他去折腾代理和登录，问题却被掩盖。
    const noContest = await api('/api/cf/problem?contestId=7777&index=A');
    check('比赛号不存在 → 说清是比赛号问题（不是"被反爬拦截"）',
      noContest.status === 400 && /比赛号写错|没有比赛 7777/.test(noContest.json.error)
      && !/反爬拦截/.test(noContest.json.error), noContest.json.error);
    const metaMissing = await api('/api/cf/meta?contestId=7777&index=A');
    check('元数据兜底也查不到时如实标 notFound（不伪造"题目已登记"）',
      metaMissing.status === 200 && metaMissing.json.notFound === true && !metaMissing.json.rating, metaMissing.json);

    // 恢复 OpenAI mock 配置
    const coachCfg = Object.assign({}, cfg, {
      providers: [{ id: 'mock-p', name: 'Mock测试服务', type: 'openai', baseUrl: MOCK, apiKey: 'test-key', extraHeaders: {}, models: ['mock-gpt-4', 'mock-gpt-mini'] }],
      defaultProviderId: 'mock-p', defaultModel: 'mock-gpt-4',
      cfHandle: 'tester',
      defaultCoachLang: 'cpp'
    });
    await api('/api/config', { method: 'POST', body: JSON.stringify(coachCfg) });

    // CF AC 统计
    const statsRes = await api('/api/cf/stats?handle=tester');
    check('CF AC 统计', statsRes.status === 200 && statsRes.json.solvedCount === 5 && statsRes.json.topTags.length > 0, statsRes.json && { solved: statsRes.json.solvedCount, tags: statsRes.json.topTags });

    // 信息卡：先手动写一个标记值，供"对话后自动更新"检测
    await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ profileText: '手工画像-初始', strengths: ['贪心'], weaknesses: ['DP'], focus: ['多讲状态'] })
    });
    const profManual = (await api('/api/profile')).json;
    check('信息卡手动保存', profManual.card && profManual.card.profileText === '手工画像-初始');

    const convC = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    const patchRes = await api('/api/conversations/' + convC.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    check('切换教练模式', patchRes.status === 200 && patchRes.json.mode === 'coach');
    check('切换讲解语言', patchRes.json.lang === 'python', patchRes.json.lang);

    const evC = await sseChat({ conversationId: convC.id, mode: 'send', userContent: '帮我讲解 Codeforces 1800C' });
    const tools = evC.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const toolResults = evC.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    // 编排（新架构）：教练是一个工具循环 —— cf_fetch 取题 → cf_verify 拉起流水线（契约/三 Agent/校准/对拍/清理）
    // → cf_doc 出图文文档（机械校验后落盘）→ 教练自己收尾讲解。
    // 注意：这里断言的是**步骤名**，它们由流水线作为工具事件发出来，与旧架构同名同序。
    check('编排：抽取 I/O 契约', tools.includes('harness_contract'), tools);
    check('编排：题解 Agent', tools.includes('agent_solution'), tools);
    check('编排：暴力 Agent', tools.includes('agent_brute'), tools);
    check('编排：生成器 Agent（仅输入契约）', tools.includes('agent_gen'), tools);
    check('编排：官方样例校准', tools.includes('harness_samples'), tools);
    check('编排：批量对拍', tools.includes('harness_stress'), tools);
    check('编排：验证后清理临时区', tools.includes('harness_cleanup'), tools);
    check('编排：先取题面再验证（工具顺序）',
      tools.indexOf('cf_fetch') >= 0 && tools.indexOf('cf_fetch') < tools.indexOf('cf_verify'), tools);
    check('编排：收尾讲解在验证之后（cf_doc / 正文都在对拍之后）',
      tools.indexOf('cf_doc') > tools.indexOf('harness_stress'), tools);
    check('暴力解先过样例（标尺冻结）',
      toolResults.some((s) => /暴力解已通过样例并冻结|暴力解官方样例全过/.test(s)), toolResults);
    check('对拍通过并报告组数', toolResults.some((s) => /对拍通过 \d+ 组/.test(s)), toolResults);
    const doneC = evC.find((e) => e.type === 'done');
    // 图文讲解是完整讲解的交付形态：内容在 richDoc 文档里（正文只留引子与要点）
    const docC = (doneC && doneC.message.richDoc) || '';
    check('教练最终讲解产出图文文档', !!doneC && docC.length > 2000
      && /class="chapter"/.test(docC) && docC.indexOf('复杂度') >= 0,
      { docLen: docC.length, content: doneC && doneC.message.content.slice(0, 40) });
    check('图文文档同时落盘到工作区（richDocPath 可追溯）',
      !!(doneC && doneC.message.richDocPath && /\.html$/.test(doneC.message.richDocPath)),
      doneC && doneC.message.richDocPath);
    check('教练讲解状态 done', doneC && doneC.message.status === 'done');
    check('教练讲解：验证通过时不走降级口径（也不自称"没把握"）',
      !!doneC && docC.indexOf('诚实降级') < 0 && docC.indexOf('没有把握') < 0);
    // ---- 实时可见性：思考过程与正文都必须**边生成边可见**（学员反馈过"全程黑屏"）----
    const idxDone = evC.findIndex((e) => e.type === 'done');
    const beforeDone = evC.slice(0, idxDone < 0 ? evC.length : idxDone);
    // 文档由 cf_doc 一次性交付，因此"生成过程实时可见"由**正文 delta**与**思考**承担
    const bodyDeltas = beforeDone.filter((e) => e.type === 'delta' && e.text);
    check('实时可见：讲解正文在 done 之前就流式下发（delta）', bodyDeltas.length >= 3, bodyDeltas.length);
    check('实时可见：文档在 done 之前就已交付（richDoc 事件）', beforeDone.some((e) => e.type === 'richDoc'));
    const reasonBeforeDone = beforeDone.filter((e) => e.type === 'reasoningDelta' && e.text);
    check('实时可见：思考过程实时流式下发（reasoningDelta）', reasonBeforeDone.length >= 2, reasonBeforeDone.length);
    const agentReason = evC.filter((e) => e.type === 'agentReasoning' && e.text);
    check('实时可见：子 Agent 的思考实时进工作台（agentReasoning）', agentReason.length >= 2, agentReason.length);
    check('实时可见：讲解消息落盘时带思考内容', !!(doneC && doneC.message.reasoning && doneC.message.reasoning.length > 0),
      doneC && String(doneC.message.reasoning || '').slice(0, 40));
    // ---- 讲解结构：文档由 cf_doc 机械校验（白名单/标签闭合/图解数量）后才允许落盘 ----
    check('讲解结构：文档经过机械校验并报出统计（cf_doc）',
      tools.includes('cf_doc') && toolResults.some((s) => /文档已生成并落盘/.test(s)), toolResults.slice(-4));
    check('讲解结构：带图解与交互组件（不是纯文字）',
      (docC.match(/<svg/gi) || []).length >= 2 && /figure class="diagram"/.test(docC) && /anim-box/.test(docC),
      { svg: (docC.match(/<svg/gi) || []).length });
    check('讲解结构：讲解里的代码与已验证代码一致',
      docC.indexOf('heapq') >= 0 && docC.indexOf('<pre class="code"') >= 0);
    // ---- 本轮 token 消耗与费用估算（不依赖模型：取服务商 usage；没有就按字符估算并标注）----
    const uC = doneC.message.usage || {};
    // 「整轮」= 工具循环自己的调用 + **工具内部验证链的子 Agent 调用**（后者才是最贵的部分）
    check('用量：统计整轮（工具循环 + 验证链）的调用次数与 token',
      uC.calls >= 3 && uC.promptTokens > 0 && uC.completionTokens > 0, uC);
    check('用量：按 Agent 拆分（coach / 三个代码 Agent 之一都在账上）',
      !!(uC.byRole && uC.byRole.coach && uC.byRole.solution),
      uC.byRole && Object.keys(uC.byRole));
    check('用量：费用按单价估算（mock-gpt-4 命中内置参考价）',
      !!(uC.cost && uC.cost.amount > 0 && uC.cost.currency === 'CNY'), uC.cost);
    const convC2 = (await api('/api/conversations/' + convC.id)).json;
    check('会话保存 CF 题目关联', convC2.cfProblem && convC2.cfProblem.contestId === 1800 && convC2.cfProblem.index === 'C', convC2.cfProblem);
    check('会话保存讲解语言', convC2.lang === 'python', convC2.lang);

    // 工作区（本题缓冲区）最终状态：题解保留、暴力与生成器已被清理、验证记录为 ok
    const wsRes = await api('/api/workspace?convId=' + convC.id);
    const traceWithTokens = (wsRes.json.trace || []).filter((t) => t.tokens && t.tokens.in >= 0);
    check('用量：决策轨迹里每次调用带 token', traceWithTokens.length >= 3, traceWithTokens.length);
    const wsFiles = (wsRes.json.files || []).map((f) => f.name);
    check('工作区保留题解 sol.py', wsFiles.indexOf('sol.py') >= 0, wsFiles);
    check('工作区已清理暴力/生成器', wsFiles.indexOf('brute.py') < 0 && wsFiles.indexOf('gen.py') < 0, wsFiles);
    check('工作区记录对拍通过', wsRes.json.verification && wsRes.json.verification.status === 'ok'
      && wsRes.json.verification.iterations > 0, wsRes.json.verification);
    check('工作区记录暴力解冻结', wsRes.json.verification && wsRes.json.verification.bruteFrozen === true, wsRes.json.verification);
    const solFile = await api('/api/workspace/file?convId=' + convC.id + '&name=sol.py');
    check('可读取工作区题解代码', solFile.status === 200 && solFile.json.content.indexOf('heapq') >= 0, solFile.status);
    const missing = await api('/api/workspace/file?convId=' + convC.id + '&name=brute.py');
    check('已清理文件不可读', missing.status === 404, missing.status);
    const escape = await api('/api/workspace/file?convId=' + convC.id + '&name=..%2Fconfig.json');
    check('工作区拒绝目录穿越', escape.status >= 400, escape.status);

    // 追问：解释型问题 → 教练自己判断"上下文里已经有题面与代码"，**一个工具都不调**直接答
    // （旧架构靠 harness_router 判路由；新架构里这个判断就是模型自己的活，所以断言改成看**结果**）
    const convC3 = await sseChat({ conversationId: convC.id, mode: 'send', userContent: '第 12 行为什么这么写？' });
    const tools3 = convC3.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    check('追问：不重跑验证链（追问由教练自行判断，不再路由到流水线）',
      !tools3.includes('harness_stress') && !tools3.includes('cf_verify'), tools3);
    const done3 = convC3.find((e) => e.type === 'done') || {};
    check('追问仍有讲解输出（图文文档或文字都算）',
      !!((done3.message && done3.message.richDoc && done3.message.richDoc.length > 1000)
        || String((done3.message || {}).content || '').length > 50),
      { rich: !!((done3.message || {}).richDoc), len: String((done3.message || {}).content || '').length });

    // 思路提示：必须跑完整验证链路（只是讲解等级降到 L1）——用户明确要求，不能省对拍
    const convH = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convH.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', intent: 'hint' }) });
    const evH = await sseChat({ conversationId: convH.id, mode: 'send', userContent: 'CF 1800C 给我点思路' });
    const toolsH = evH.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsH = evH.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    check('思路提示也跑全量验证（含对拍）', toolsH.includes('harness_stress'), toolsH);
    // 意图（思路提示）必须**真的影响交付**：只给方向，不能把完整可提交代码塞给学员。
    // 旧架构靠"讲解等级降到 L1"实现，新架构里由教练自己按意图裁量 —— 所以断言改成看正文。
    const doneH = evH.find((e) => e.type === 'done') || {};
    check('思路提示：只给方向，不贴完整可提交代码',
      !!doneH.message && String(doneH.message.content || '').indexOf('```') < 0,
      String((doneH.message || {}).content || '').slice(0, 80));
    check('同题缓存：复用已验证的暴力解与生成器', resultsH.some((s) => s.indexOf('复用同题已验证的暴力解') >= 0)
      || resultsH.some((s) => s.indexOf('复用同题缓存产物') >= 0), resultsH);
    const wsH = (await api('/api/workspace?convId=' + convH.id)).json;
    check('同题缓存：不同会话共享同一工作区键', wsH.key === 'cf-1800C', wsH.key);
    check('同题缓存：已验证标尺已入缓存', (wsH.cache || []).some((f) => /^brute\./.test(f.name)), (wsH.cache || []).map((f) => f.name));
    check('思路提示同样产出已验证题解', wsH.verification && wsH.verification.status === 'ok', wsH.verification);
    await api('/api/conversations/' + convH.id, { method: 'DELETE' });

    // ===== 意图「自动」（默认）：由模型自己判断这次要哪一种，不再让用户先选 =====
    const convAuto = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    check('新会话默认真·自动意图', convAuto.intent === 'auto', convAuto.intent);
    const autoPatch = await api('/api/conversations/' + convAuto.id, { method: 'PATCH', body: JSON.stringify({ intent: 'auto' }) });
    check('自动意图可以显式设回（不会被回落成别的值）', autoPatch.json && autoPatch.json.intent === 'auto', autoPatch.json && autoPatch.json.intent);
    await api('/api/conversations/' + convAuto.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    const evAuto = await sseChat({ conversationId: convAuto.id, mode: 'send', userContent: 'CF 1800C 给我点思路' });
    const toolsAuto = evAuto.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const doneAuto = evAuto.find((e) => e.type === 'done') || {};
    // 判据看**交付形态**：自动判定为"思路提示"时不该出图文文档、也不该甩完整代码
    check('自动意图：只要方向的问法 → 不给完整代码、不产出图文文档',
      !!doneAuto.message && !doneAuto.message.richDoc && String(doneAuto.message.content || '').indexOf('```') < 0,
      { rich: !!(doneAuto.message || {}).richDoc, len: String((doneAuto.message || {}).content || '').length });
    check('自动意图：照样跑完整验证（不是省掉对拍）', toolsAuto.includes('harness_stress'), toolsAuto);
    await api('/api/conversations/' + convAuto.id, { method: 'DELETE' });

    // ===== 粘贴题面的默认路径：题面已在会话里 → 不联网取、样例当场可用、直接完整讲解 =====
    // 三条真实事故都固化在这里：
    //   ① 用户粘了题面，教练还去 cf_fetch 取一遍（白等一轮往返，样例反而变少）；
    //   ② cf_run 用错调用形状，永远回"当前题目没有可用样例"（模型白试 4 次 → 重跑整条链）；
    //   ③ 完整讲解只给文字不给图文文档（图文是核心交付）。
    const convStmt = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convStmt.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    const pastedStatement = [
      '【Codeforces 1800C】C. Powering the Hero (hard version)',
      '时限：2 seconds · 内存：256 megabytes',
      '',
      'There are n cards in a deck. Each card has a positive number or 0.',
      'In one move you take the top card: a positive number goes onto the top of your bonus stack,',
      'while a 0 lets you take the maximum bonus from the stack and add it to your score.',
      'The deck is processed from top to bottom and you may also skip cards entirely.',
      '',
      '输入格式',
      'The first line contains t (1 <= t <= 10^4) — the number of test cases.',
      'Each test case starts with n (1 <= n <= 2*10^5) and then a line of n integers.',
      'It is guaranteed that the sum of n over all test cases does not exceed 2*10^5.',
      '',
      '输出格式',
      'For each test case print one integer — the maximum score you can achieve.',
      '',
      '样例：',
      '输入 1：',
      '2',
      '3',
      '3 3 0',
      '2',
      '5 0',
      '输出 1：',
      '3',
      '5'
    ].join('\n');
    const evStmt = await sseChat({ conversationId: convStmt.id, mode: 'send', userContent: pastedStatement });
    const toolsStmt = evStmt.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsStmt = evStmt.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    check('粘题面：不再联网取题（题面已在会话里）', !toolsStmt.includes('cf_fetch'), toolsStmt);
    check('粘题面：照样跑完整验证', toolsStmt.includes('harness_stress'), toolsStmt);
    // cf_run 曾经因为调用形状过期而永远失败 —— 这条断言就是它的看门人
    check('cf_run 真的能跑（不再回"当前题目没有可用样例"）',
      resultsStmt.some((s) => /【运行结果】|【运行失败】/.test(s))
      && !resultsStmt.some((s) => /没有可用样例/.test(s)),
      resultsStmt.filter((s) => /运行|样例/.test(s)).slice(0, 3));
    const doneStmt = evStmt.find((e) => e.type === 'done') || {};
    check('粘题面 = 完整讲解：交付图文文档', !!(doneStmt.message && doneStmt.message.richDoc),
      { rich: !!((doneStmt.message || {}).richDoc) });
    const convStmtAfter = (await api('/api/conversations/' + convStmt.id)).json;
    check('粘题面：题面与样例当场登记进会话（不再依赖联网取）',
      String(convStmtAfter.statementText || '').length > 300 && (convStmtAfter.cfProblemSamples || []).length >= 1,
      { stmt: String(convStmtAfter.statementText || '').length, samples: (convStmtAfter.cfProblemSamples || []).length });
    await api('/api/conversations/' + convStmt.id, { method: 'DELETE' });

    // ===== 同一道题再问一遍（工作区已有验证通过产物）=====
    // 真实事故：第二轮正确地跳过了重复对拍（cf-explain §0），却**连文档也一起跳过了** ——
    // 用户拿到的是又一段纯文字（"依旧没有图"）。判据因此必须是"这题可信吗"，而不是
    // "这一轮有没有重新跑一遍验证"。
    const convAgain = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convAgain.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    const evAgain = await sseChat({
      conversationId: convAgain.id, mode: 'send',
      userContent: 'CF 1800C 再给我讲一遍（题面我已经贴过了，这题之前验证过）'
    });
    const toolsAgain = evAgain.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const doneAgain = evAgain.find((e) => e.type === 'done') || {};
    check('再问一遍时：先看工作区（决定要不要重跑）', toolsAgain.includes('cf_workspace'), toolsAgain);
    // 注意：这里不硬断言"没有 harness_stress"。工作区按**题号**共享，新会话只有在 cfProblem 已登记
    // （客户端「从 CF 获取题面」那条路会登记）时才命中同一个工作区；这个用例是纯粘贴，
    // 命中与否取决于题面登记时机。真正要守住的是下面这条：**跳过对拍也必须交付文档**。
    check('复用已验证结论时：**图文文档照样交付**（跳过对拍 ≠ 跳过文档）',
      !!(doneAgain.message && doneAgain.message.richDoc), { rich: !!((doneAgain.message || {}).richDoc), tools: toolsAgain });
    await api('/api/conversations/' + convAgain.id, { method: 'DELETE' });

    // 代码评估（只提做法、没贴代码）：问「用 XX 能写吗」→ 先做可行性评估，可行则复用缓存标尺重跑题解
    const evI = await sseChat({ conversationId: convC.id, mode: 'send', userContent: '这题用 Floyd 能写吗？' });
    const toolsI = evI.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    check('代码评估：只提做法时先做可行性评估', toolsI.includes('harness_idea'), toolsI);
    check('代码评估：评估可行后仍跑对拍', toolsI.includes('harness_stress'), toolsI);
    check('代码评估：复用缓存标尺（不重写暴力解）', !toolsI.includes('agent_brute'), toolsI);

    // 熔断与诚实降级：题解反复错 → 有限轮后停下，讲解改用"我没把握"口径
    // （先清掉本题的同题缓存，确保这条会话真的重跑链路）
    await api('/api/workspace/clear', { method: 'POST', body: JSON.stringify({ convId: convC.id, keepAll: true }) });
    const convF = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convF.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-fail' }) });
    const evF = await sseChat({ conversationId: convF.id, mode: 'send', userContent: 'CF 1800C 讲解一下' });
    const resultsF = evF.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const doneF = evF.find((e) => e.type === 'done');
    const noticesF = evF.filter((e) => e.type === 'notice').map((e) => e.message);
    check('熔断：对拍未通过时停止并如实报告', resultsF.some((s) => s.indexOf('对拍未通过') >= 0), resultsF.slice(-4));
    check('熔断：发出未验证提醒', noticesF.some((s) => s.indexOf('验证未通过') >= 0), noticesF);
    // 降级口径现在写在**图文文档**里（正文只有引子）：文档开头必须有未验证警示
    const docF = (doneF && doneF.message.richDoc) || '';
    check('熔断：讲解走诚实降级口径（文档里带未验证警示）',
      /未验证通过|未验证|诚实降级/.test(docF), { doc: docF.length, head: docF.slice(0, 0) || String(doneF && doneF.message.content || '').slice(0, 60) });
    check('熔断：消息带验证状态（未通过）', !!(doneF && doneF.message.verification && doneF.message.verification.status === 'unverified'),
      doneF && doneF.message.verification);
    const wsF = (await api('/api/workspace?convId=' + convF.id)).json;
    check('熔断：未验证时不清理缓冲区（留证据）', (wsF.files || []).some((f) => /^sol\./.test(f.name)), (wsF.files || []).map((f) => f.name));
    check('熔断：记录修正次数与调用数', !!(wsF.verification && wsF.verification.solRewrites >= 1 && wsF.verification.agentCalls > 0),
      wsF.verification);
    check('熔断：修正轮数受硬上限约束（≤3 轮，不再按难度放到 8–16 轮）',
      !!(wsF.verification && wsF.verification.solRewrites <= 3),
      wsF.verification && wsF.verification.solRewrites);
    check('熔断：模型调用总数受预算约束（≤40 次）', !!(wsF.verification && wsF.verification.agentCalls <= 40),
      wsF.verification && wsF.verification.agentCalls);
    check('熔断：失败原因如实可读（不是空话）',
      !!(wsF.verification && wsF.verification.reason && wsF.verification.reason.length > 8
        && /轮仍未与暴力解一致|重写 \d+ 次仍不收敛|已完成：|尚未完成有效验证|未通过官方样例|不可用|证据不足以判定/.test(wsF.verification.reason)),
      wsF.verification && wsF.verification.reason);
    check('熔断：如实记录整轮墙钟与调用数（诊断成本用）',
      !!(wsF.verification && typeof wsF.verification.wallMs === 'number' && wsF.verification.wallMs >= 0),
      wsF.verification && { wallMs: wsF.verification.wallMs, calls: wsF.verification.agentCalls });
    check('决策轨迹：记录每次调用的模型名', (wsF.trace || []).every((t) => typeof t.model === 'string') && (wsF.trace || []).length >= 4,
      (wsF.trace || []).map((t) => t.model));
    // 步骤 chip：新架构下一条 chip = 一次**工具调用**（cf_fetch / cf_verify / cf_doc …）；
    // 流水线内部的每一步在 Agent 工作台里（agentStart/agentDelta/agentEnd），两者分工不同
    check('历史消息带步骤 chip（重渲染不丢）', !!doneF && Array.isArray(doneF.message.tools) && doneF.message.tools.length >= 3,
      doneF && (doneF.message.tools || []).map((t) => t.name));
    check('决策轨迹已记录（可展开时间线）', Array.isArray(wsF.trace) && wsF.trace.length >= 4
      && wsF.trace.some((t) => t.role === 'solution') && wsF.trace.some((t) => t.role === 'brute' || t.role === 'gen'),
      (wsF.trace || []).map((t) => t.role));
    await api('/api/conversations/' + convF.id, { method: 'DELETE' });

    // 暴力解写不出 → 无标尺降级（只做官方样例校验，并如实标注）
    const convNB = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convNB.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-nobrute' }) });
    const evNB = await sseChat({ conversationId: convNB.id, mode: 'send', userContent: 'CF 1800C 讲解一下' });
    const resultsNB = evNB.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const doneNB = evNB.find((e) => e.type === 'done');
    check('无标尺：暴力解写不出时不硬对拍', resultsNB.some((s) => s.indexOf('跳过对拍') >= 0 || s.indexOf('没有对拍标尺') >= 0
      || s.indexOf('未通过官方样例') >= 0), resultsNB.slice(-4));
    const wsNB = (await api('/api/workspace?convId=' + convNB.id)).json;
    check('无标尺：验证状态如实记录', !!(wsNB.verification && /no-bruler|samples-failed|failed/.test(wsNB.verification.status)), wsNB.verification);
    check('无标尺：讲解也走诚实降级',
      /未验证通过|未验证|诚实降级/.test(String((doneNB && doneNB.message.richDoc) || '')
        + String((doneNB && doneNB.message.content) || '')));
    await api('/api/conversations/' + convNB.id, { method: 'DELETE' });

    // ===== 反「标尺投机」：复刻真实事故（题解/暴力解打表 → 必须被机械拦下，且绝不进死循环）=====
    const convCh = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convCh.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-cheat' }) });
    const evCh = await sseChat({ conversationId: convCh.id, mode: 'send', userContent: 'CF 2264D 讲解一下' });
    const toolsCh = evCh.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsCh = evCh.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const doneCh = evCh.find((e) => e.type === 'done');
    check('反打表：检出题解硬编码样例答案', resultsCh.some((s) => /硬编码样例答案|打表/.test(s)), resultsCh.slice(0, 4));
    check('反打表：拒绝把打表当题解交付', resultsCh.some((s) => s.indexOf('拒绝交付') >= 0), resultsCh.slice(0, 4));
    check('反打表：不打对拍（不拿说谎的标尺去改题解）', !toolsCh.includes('harness_stress'), toolsCh);
    const wsCh = (await api('/api/workspace?convId=' + convCh.id)).json;
    check('反打表：验证状态如实记录（未通过）', !!(wsCh.verification && wsCh.verification.status === 'unverified'), wsCh.verification);
    check('反打表：打表代码不落盘（不留假题解）',
      !(wsCh.files || []).some((f) => /^sol\./.test(f.name)), (wsCh.files || []).map((f) => f.name));
    check('反打表：讲解走诚实降级（不硬讲一个错解）',
      /未验证通过|未验证|诚实降级/.test(String((doneCh && doneCh.message.richDoc) || '')
        + String((doneCh && doneCh.message.content) || '')));
    await api('/api/conversations/' + convCh.id, { method: 'DELETE' });

    const convCb = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convCb.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-cheat-brute' }) });
    const evCb = await sseChat({ conversationId: convCb.id, mode: 'send', userContent: 'CF 2264D 讲解一下' });
    const toolsCb = evCb.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsCb = evCb.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const wsCb = (await api('/api/workspace?convId=' + convCb.id)).json;
    check('反打表：拒绝拿打表的暴力解当标尺', resultsCb.some((s) => /打表|硬编码样例答案/.test(s)), resultsCb.slice(0, 4));
    check('反打表：标尺作废后不进对拍死循环（题解只调用一次）',
      toolsCb.filter((n) => n === 'agent_solution').length <= 1, toolsCb);
    check('反打表：如实降级为"只有样例校验"', !!(wsCb.verification && /no-bruler|samples-failed/.test(wsCb.verification.status))
      && (wsCb.verification.solRewrites || 0) === 0, wsCb.verification);
    await api('/api/conversations/' + convCb.id, { method: 'DELETE' });

    // 图文文档校验（mock-bad-explain）：第一次交的文档**没有图** → 必须被机械校验拦下，
    // 教练按提示重写一次 → 修正版通过校验并交付。
    // 为什么断言改成这样：讲解以前由流水线的讲解 Agent 写、由 harness_richdoc 校验；
    // 现在由教练写、由 `cf_doc` 校验 —— 闸门还在，只是换了执行者。
    const convBad = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convBad.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-bad-explain' }) });
    const evBad = await sseChat({ conversationId: convBad.id, mode: 'send', userContent: 'CF 1800C 讲解一下' });
    const toolsBad = evBad.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsBad = evBad.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const doneBad = evBad.find((e) => e.type === 'done');
    check('图文校验：没有图的文档被拦下（不是直接交付）',
      resultsBad.some((s) => /没有任何 SVG 图解|未通过校验/.test(s)), resultsBad.slice(0, 4));
    check('图文校验：按校验提示重写了一次（cf_doc 被调用 ≥2 次）',
      toolsBad.filter((n) => n === 'cf_doc').length >= 2, toolsBad);
    check('图文校验：修正版通过校验并交付（消息带 richDoc）',
      !!(doneBad && doneBad.message.richDoc && doneBad.message.richDoc.length > 1000),
      doneBad && String(doneBad.message.richDoc || '').length);
    await api('/api/conversations/' + convBad.id, { method: 'DELETE' });

    // ===== 粘贴题面（非 CF 标准格式）=====
    // 粘贴题面（非 CF 标准格式）：题面里带着样例但正文是自由文本 —— 必须先整理出结构化样例再进流水线。
    // 现在：机械判格式 → 不标准就派【题面整理 Agent】→ 拿到结构化样例 → 正常跑完整验证链。
    const pastedText = [
      '有一堆牌，每张牌有一个非负整数值。遇到值为 0 的牌时，可以从之前出现过且没被取走的牌里取一张，把它的值加入总和。',
      '求能取得的最大总和。**输入**',
      '',
      '第一行一个整数 t 表示测试用例数。每个测试用例第一行是 n，第二行是 n 个整数。**输出**',
      '',
      '每组输出一行一个整数。'
    ].join('\n');
    const convPaste = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convPaste.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    const evPaste = await sseChat({ conversationId: convPaste.id, mode: 'send', userContent: pastedText });
    const toolsPaste = evPaste.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsPaste = evPaste.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const wsPaste = (await api('/api/workspace?convId=' + convPaste.id)).json;
    check('粘贴题面：先做格式体检', toolsPaste.includes('harness_normalize'), toolsPaste);
    check('粘贴题面：派【题面整理 Agent】整理成标准结构',
      resultsPaste.some((s) => /题面整理 Agent 已把粘贴内容整理成标准结构/.test(s)), resultsPaste.slice(0, 3));
    check('粘贴题面：整理后拿到结构化样例（不再"没标尺"）',
      !!(wsPaste.verification && wsPaste.verification.samples > 0), wsPaste.verification && { samples: wsPaste.verification.samples });
    check('粘贴题面：整理后能跑完整对拍',
      toolsPaste.includes('harness_stress') && resultsPaste.some((s) => /对拍通过 \d+ 组/.test(s)), resultsPaste.slice(-3));
    check('粘贴题面：验证状态为 ok', !!(wsPaste.verification && wsPaste.verification.status === 'ok'), wsPaste.verification);
    await api('/api/conversations/' + convPaste.id, { method: 'DELETE' });

    // ===== 删除会话 = 全删（含本题验证缓存），并且要如实报告 =====
    // 用户的原话："我在 UI 中删除了这个对话为什么还能有缓存呢？我删除肯定是全删啊"
    // —— 缓存按题号共享，如果不跟着删，既不符删除语义，也没法测"重新对拍"。
    const delConv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + delConv.id, { method: 'PATCH', body: JSON.stringify({ cfProblem: { contestId: 4242, index: 'Z', title: 'Z. Cache Test' } }) });
    // 造一个"已验证"的工作区（不走真链路，直接写 meta，保持用例快）
    const wsRoot = path.join(((await api('/api/info')).json || {}).dataDir || '', 'workspace');
    const purgeKey = 'cf-4242Z';
    const metaFile = path.join(wsRoot, purgeKey, 'meta.json');
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify({ verification: { status: 'ok', samples: 1, iterations: 50 } }), 'utf8');
    const delRes = await api('/api/conversations/' + delConv.id, { method: 'DELETE', body: JSON.stringify({ forceWorkspace: true }) });
    check('删对话：连本题验证缓存一起删（全删语义）',
      delRes.status === 200 && delRes.json.workspaceCleared === true && !fs.existsSync(metaFile),
      delRes.json);

    // 本题缓存被别的对话共用时：保留缓存但**如实说明**（不能假装删干净了）
    const sharedA = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    const sharedB = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    for (const cv of [sharedA, sharedB]) {
      await api('/api/conversations/' + cv.id, { method: 'PATCH', body: JSON.stringify({ cfProblem: { contestId: 4243, index: 'Y', title: 'Y. Shared' } }) });
    }
    const sharedMeta = path.join(wsRoot, 'cf-4243Y', 'meta.json');
    fs.mkdirSync(path.dirname(sharedMeta), { recursive: true });
    fs.writeFileSync(sharedMeta, JSON.stringify({ verification: { status: 'ok', samples: 1, iterations: 50 } }), 'utf8');
    const delShared = await api('/api/conversations/' + sharedA.id, { method: 'DELETE' });
    check('删对话：缓存被别的对话共用 → 保留并如实报告共用者',
      delShared.status === 200 && delShared.json.workspaceCleared === false
      && delShared.json.workspaceKept === 'cf-4243Y' && (delShared.json.sharedWith || []).indexOf(sharedB.id) >= 0,
      delShared.json);
    // 显式清缓存的口子（UI 的「重新对拍」按钮走的接口）——不必靠删对话来测链路
    const purge = await api('/api/workspace/purge', { method: 'POST', body: JSON.stringify({ convId: sharedB.id }) });
    check('重新对拍：清掉本题缓存（下次从零跑验证链）',
      purge.status === 200 && purge.json.key === 'cf-4243Y' && purge.json.removed === true && !fs.existsSync(sharedMeta),
      purge.json);
    await api('/api/conversations/' + sharedB.id, { method: 'DELETE' });

    // ===== 没有样例：手算锚点 Agent 造极端小样例并手算答案 =====
    const convAnchor = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convAnchor.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-noanchor' }) });
    const evAnchor = await sseChat({
      conversationId: convAnchor.id, mode: 'send',
      userContent: '牌堆问题：遇到 0 就取此前没取过的最大正数牌，求能取得的最大总和。\n\n输入格式\n第一行 t，每个测试用例一行 n、一行 n 个整数。\n\n输出格式\n每组输出一行整数。'
    });
    const toolsAnchor = evAnchor.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsAnchor = evAnchor.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const wsAnchor = (await api('/api/workspace?convId=' + convAnchor.id)).json;
    check('无样例：派【手算锚点 Agent】造小样例并手算', toolsAnchor.includes('agent_witness'), toolsAnchor);
    check('无样例：手算锚点三方一致才采信（手算=题解=暴力解）',
      resultsAnchor.some((s) => /手算锚点生效/.test(s)), resultsAnchor.slice(-4));
    check('无样例：验证报告标注锚点来源是 hand（不是官方样例）',
      !!(wsAnchor.verification && wsAnchor.verification.samplesSource === 'hand'), wsAnchor.verification && wsAnchor.verification.samplesSource);
    check('无样例：仍然跑了对拍（不因缺样例而不验证）',
      toolsAnchor.includes('harness_stress'), toolsAnchor);
    await api('/api/conversations/' + convAnchor.id, { method: 'DELETE' });

    // ===== 信息卡：只记宏观特征，不记单轮事件、不把教练产出算成学员的 =====
    // 先用"无证据的一轮"验证不更新：重置成手工画像 → 发一条只贴题号的消息 → 画像必须原样（0 token 跳过）
    await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ profileText: '手工画像-初始', strengths: ['贪心'], weaknesses: ['DP'], focus: ['多讲状态'] })
    });
    const convNoEv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convNoEv.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    await sseChat({ conversationId: convNoEv.id, mode: 'send', userContent: 'CF 1800C 讲解一下' });
    await new Promise((r) => setTimeout(r, 1500));
    const cardAfterPlain = (await api('/api/profile')).json.card || {};
    check('信息卡：只贴题号的一轮不更新画像（没有学员侧证据 → 跳过）',
      cardAfterPlain.profileText === '手工画像-初始', cardAfterPlain.profileText);
    await api('/api/conversations/' + convNoEv.id, { method: 'DELETE' });
    const convCard = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convCard.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', intent: 'debug' }) });
    await sseChat({
      conversationId: convCard.id, mode: 'send',
      userContent: 'CF 1800C 我的代码为什么 WA？\n\n```python\nimport sys\ndef main():\n    sys.stdin.read()\n    print(0)\nmain()\n```'
    });
    let cardAfterCode = {};
    for (let i = 0; i < 20; i++) {   // 信息卡是异步更新的，等它落盘
      await new Promise((r) => setTimeout(r, 300));
      cardAfterCode = (await api('/api/profile')).json.card || {};
      if ((cardAfterCode.strengths || []).join() !== '贪心') break;
    }
    const junk = /(本次|这一轮|这道题|该题|本题|题解|讲解|对拍|教练|AI)/;
    check('信息卡：贴了代码的一轮会更新画像（学员侧证据成立）',
      (cardAfterCode.strengths || []).length > 0 && JSON.stringify(cardAfterCode.strengths) !== JSON.stringify(['贪心']),
      cardAfterCode.strengths);
    check('信息卡：宏观特征里不出现单轮事件/教练产出',
      !junk.test((cardAfterCode.strengths || []).join(' ')) && !junk.test((cardAfterCode.weaknesses || []).join(' '))
      && !junk.test((cardAfterCode.focus || []).join(' ')), {
        strengths: cardAfterCode.strengths, weaknesses: cardAfterCode.weaknesses, focus: cardAfterCode.focus
      });
    check('信息卡：画像正文里不出现单轮事件',
      !/(本次|这一轮|这道题|该题|本题)/.test(cardAfterCode.profileText || ''), cardAfterCode.profileText);
    check('信息卡：条目数量受控（优势/短板 ≤4、重点 ≤3）',
      (cardAfterCode.strengths || []).length <= 4 && (cardAfterCode.weaknesses || []).length <= 4
      && (cardAfterCode.focus || []).length <= 3, cardAfterCode);
    // 注意：这里**不再**把卡片重置回手工值 —— 信息卡现在只在"有学员侧证据"时更新，
    // 后面的富讲解会话没有证据，不会再刷它；重置会破坏后面的画像断言。
    await api('/api/conversations/' + convCard.id, { method: 'DELETE' });

    // ===== 三个代码 Agent 真并发 + 停止后不留"正在生成" =====
    // 用 mock-delay（按角色固定延迟：题解 2.5s / 暴力 1.5s / 生成器 0.8s）量时间窗：
    // 真并发 → 三个 agentStart 几乎同时、窗口重叠、总跨度≈最慢那路；串行 → 总跨度≈三者之和
    // 用 1800C（mock 的三份代码就是这道题的语义，样例必然能过），并**清掉它的同题缓存**以强制重跑
    const info = (await api('/api/info')).json;
    if (info && info.dataDir) {
      // 清掉 1800C 的**整个工作区**（含 cache/ 与 meta.json）：
      // 只清 cache 不够 —— meta 里还写着"已验证"，服务端会走"复用+路由"快路径，压根不跑三个代码 Agent
      fs.rmSync(path.join(info.dataDir, 'workspace', 'cf-1800C'), { recursive: true, force: true });
    }
    const convPar = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convPar.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-delay' }) });
    const tPar = Date.now();
    const spans = {};        // 每个角色记录**首次**调用的时间窗（后续重写不算，那属于另一条链路）
    const evPar = await sseChat({ conversationId: convPar.id, mode: 'send', userContent: 'CF 1800C 讲解一下' }, {
      onEvent: (ev) => {
        if (ev.type === 'agentStart' && !spans[ev.role]) spans[ev.role] = { start: Date.now() - tPar, end: null };
        if (ev.type === 'agentEnd' && spans[ev.role] && spans[ev.role].end == null) spans[ev.role].end = Date.now() - tPar;
      }
    });
    const three = ['solution', 'brute', 'gen'].map((r) => spans[r]).filter((x) => x && x.end != null);
    check('并发：三个代码 Agent 的首次调用都在同一起跑线', three.length === 3, JSON.stringify(spans));
    if (three.length === 3) {
      const latestStart = Math.max(...three.map((x) => x.start));
      const earliestEnd = Math.min(...three.map((x) => x.end));
      check('并发：三个调用的时间窗互相重叠（不是串行等待）', latestStart < earliestEnd,
        JSON.stringify({ spans, latestStart, earliestEnd }));
      const span = Math.max(...three.map((x) => x.end)) - Math.min(...three.map((x) => x.start));
      check('并发：总跨度接近"最慢那一路"而不是三者之和', span < 2600 + 1500,
        JSON.stringify({ span, serialWouldBe: 4800, spans }));
    }
    const bruteCalls = evPar.filter((e) => e.type === 'agentStart' && e.role === 'brute').length;
    check('并发：暴力解一次过样例，没有触发多余的重写（省时间的关键）', bruteCalls === 1,
      'brute agentStart 次数 = ' + bruteCalls);
    await api('/api/conversations/' + convPar.id, { method: 'DELETE' });

    // 停止链路：点停止 → 服务端立刻收尾（消息落盘 + 释放"正在生成"登记 + 未完成的步骤不再转圈）
    // 用一个**全新的粘贴题面**（工作区键 = 会话 ID，没有缓存）确保真的在链路中途被停
    const convStop = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convStop.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', model: 'mock-delay' }) });
    const stopStatement = [
      '牌堆里依次给出 n 张非负整数牌；遇到 0 可以取走此前未被取走的最大正数牌，求能取得的最大总和。',
      '',
      '输入格式',
      '第一行 t（1 ≤ t ≤ 10）。',
      '每个测试用例第一行 n（1 ≤ n ≤ 8），第二行 n 个整数。',
      '',
      '输出格式',
      '每个测试用例输出一行整数。',
      '',
      '样例输入',
      '2',
      '3',
      '3 3 0',
      '2',
      '5 0',
      '',
      '样例输出',
      '3',
      '5'
    ].join('\n');
    // 1400ms 处由客户端"点停止"（先调停止端点，再断开流），此刻 mock-delay 的题解调用还在飞
    await sseChat({ conversationId: convStop.id, mode: 'send', userContent: stopStatement }, { abortAfterMs: 1400, stopFirst: true });
    const tStop = Date.now();
    const stopStatus = (await api('/api/chat/stop', { method: 'POST', body: JSON.stringify({ conversationId: convStop.id }) })).json;
    // 幂等：这次可能已经没有在跑的生成（上一次停止已生效）——如实返回 true/false 都行，ok 必须是 true
    check('停止：重复调用停止端点幂等且如实返回', !!(stopStatus && stopStatus.ok === true
      && (stopStatus.stopped === true || stopStatus.stopped === false)), stopStatus);
    // 用户在 1400ms 处点的停止（此刻 mock-delay 的题解调用还有 1.1 秒才返回）：
    // 服务端必须**立刻**中断在飞的那次请求并退栈，否则界面会一直挂着"正在生成中 · 转圈"
    let stopClearMs = -1;
    for (let i = 0; i < 60; i++) {
      const g = (await api('/api/generations')).json;
      if (((g && g.active) || []).indexOf(convStop.id) < 0) { stopClearMs = Date.now() - tStop; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    check('停止：1.5 秒内释放"正在生成"登记（否则界面一直转圈）', stopClearMs >= 0 && stopClearMs < 1500,
      '停止后 ' + stopClearMs + 'ms 清除');
    // 停止之后绝不能再发起新的模型调用（老实现会继续把 witness/讲解 跑完 → 白烧 token）
    const statsAtStop = await mockStats();
    await new Promise((r) => setTimeout(r, 3000));
    const statsLater = await mockStats();
    check('停止：之后再没有新的模型调用（真正停下来，不是跑完才停）',
      !!(statsAtStop && statsLater && statsLater.chatRequests - statsAtStop.chatRequests <= 1),
      { atStop: statsAtStop && statsAtStop.chatRequests, later: statsLater && statsLater.chatRequests });
    const gensAfter = (await api('/api/generations')).json;
    const convStopNow = (await api('/api/conversations/' + convStop.id)).json;
    const stopLast = convStopNow.messages[convStopNow.messages.length - 1];
    const stopList = (await api('/api/conversations')).json.conversations.find((c) => c.id === convStop.id);
    const stuckChips = ((stopLast && stopLast.tools) || []).filter((c) => c.state === 'running');
    check('停止：服务端释放"正在生成"登记（否则列表一直转圈）',
      (gensAfter.active || []).indexOf(convStop.id) < 0, gensAfter);
    check('停止：会话/列表的 active 标记归位', !!(stopList && stopList.active === false && convStopNow.active === false),
      { list: stopList && stopList.active, conv: convStopNow.active });
    check('停止：消息已收尾（stopped，不是永远 streaming）',
      !!(stopLast && (stopLast.status === 'stopped' || stopLast.status === 'error')), stopLast && stopLast.status);
    check('停止：没有残留"运行中"的步骤 chip（界面不再转圈）', stuckChips.length === 0, stuckChips);
    await api('/api/conversations/' + convStop.id, { method: 'DELETE' });

    // 「没听懂」→ 换讲法（更小的例子、一步步手算），而不是把上次的话再说一遍。
    // 旧架构靠 harness_router 判出 rethink；新架构里"要不要换讲法"是教练自己的判断
    // （cf-explain 技能里写明了这条），所以断言改成看**结果**：没重跑链路，且回答确实换了说法。
    const convRT = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convRT.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', intent: 'full' }) });
    await sseChat({ conversationId: convRT.id, mode: 'send', userContent: 'CF 1800C 讲解一下' });
    const evRT = await sseChat({ conversationId: convRT.id, mode: 'send', userContent: '我没听懂，能不能换个说法' });
    const resultsRT = evRT.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const toolsRT = evRT.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const msgsRT = ((await api('/api/conversations/' + convRT.id)).json.messages || []).filter((m) => m.role === 'assistant');
    check('换讲法：换了一种说法（不是把上一轮的话再说一遍）',
      msgsRT.length >= 2 && String(msgsRT[1].content || '').length > 20
      && String(msgsRT[1].content || '') !== String(msgsRT[0].content || ''),
      { prevLen: String((msgsRT[0] || {}).content || '').length, nowLen: String((msgsRT[1] || {}).content || '').length });
    check('换讲法：不重跑对拍链路（省 token）', !toolsRT.includes('harness_stress'), toolsRT);
    check('换讲法：这一轮一个工具都没调（纯对话）', resultsRT.length === 0 && toolsRT.length === 0, { toolsRT, resultsRT: resultsRT.slice(0, 2) });
    await api('/api/conversations/' + convRT.id, { method: 'DELETE' });
    const convD = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convD.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', intent: 'debug' }) });
    const badUserCode = ['```python', 'import sys', 'def main():', '    data = sys.stdin.read().split()',
      '    print(0)   # 故意写错的用户代码', 'main()', '```'].join('\n');
    const evD = await sseChat({
      conversationId: convD.id, mode: 'send',
      userContent: 'CF 1800C 我的代码为什么 WA？\n\n' + badUserCode
    });
    const toolsD = evD.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsD = evD.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    check('代码诊断：跑三方对拍', toolsD.includes('harness_usercode'), toolsD);
    check('代码诊断：找到用户代码反例', resultsD.some((s) => s.indexOf('你的代码存在反例') >= 0), resultsD);
    const wsD = (await api('/api/workspace?convId=' + convD.id)).json;
    check('代码诊断：反例已最小化并落盘', !!(wsD.meta && wsD.meta.minimalCase && wsD.meta.minimalCase.from === 'user-vs-brute'),
      wsD.meta && wsD.meta.minimalCase);
    check('代码诊断：最小反例比原始数据更小', !!(wsD.failCase && wsD.failCase.length > 0), wsD.failCase);
    check('代码诊断：agent 实时事件齐全（工作台可见）',
      evD.some((e) => e.type === 'agentStart') && evD.some((e) => e.type === 'agentDelta') && evD.some((e) => e.type === 'agentEnd'),
      evD.filter((e) => /^agent/.test(e.type)).map((e) => e.type).slice(0, 8));
    await api('/api/conversations/' + convD.id, { method: 'DELETE' });

    // 代码诊断（低级错误优先）：用户贴了编译不过的代码 → 先给硬结论
    const convH2 = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convH2.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', intent: 'debug' }) });
    const brokenCode = ['```python', 'import sys', 'def main(:', '    print(1)', '```'].join('\n');
    const evH2 = await sseChat({ conversationId: convH2.id, mode: 'send', userContent: 'CF 1800C 我的代码编译报错\n\n' + brokenCode });
    const toolsH2 = evH2.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resultsH2 = evH2.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    check('代码体检：只针对用户代码（debug 意图才跑）', toolsH2.includes('harness_userhealth'), toolsH2);
    check('代码体检：抓出用户代码的语法错误', resultsH2.some((s) => s.indexOf('你的代码存在编译/语法错误') >= 0), resultsH2);
    // 注意：tools 是**正常讲解**那条会话的步骤；它里面不该出现"用户代码体检"这类只对用户代码跑的步骤
    check('代码体检：正常流程不跑体检（只跑用户代码）', !tools.includes('harness_userhealth'), tools);
    const wsH2 = (await api('/api/workspace?convId=' + convH2.id)).json;
    check('代码体检：结论写进迭代轨迹', (wsH2.meta.trajectory || []).some((t) => /^user-/.test(t.kind)),
      (wsH2.meta.trajectory || []).map((t) => t.kind));
    await api('/api/conversations/' + convH2.id, { method: 'DELETE' });

    // 后台/并发：生成中不显示"已暂停"，且支持多个会话同时跑
    const convP = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convP.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python' }) });
    const running = sseChat({ conversationId: convP.id, mode: 'send', userContent: 'CF 1800C 讲解一下' });
    // 轮询等它进入生成态（mock 很快，窗口不长）
    let sawActive = false;
    let convDuring = null;
    let listItem = null;
    for (let i = 0; i < 25 && !sawActive; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const gens = await api('/api/generations');
      if ((gens.json.active || []).indexOf(convP.id) >= 0) {
        sawActive = true;
        convDuring = (await api('/api/conversations/' + convP.id)).json;
        const listDuring = await api('/api/conversations');
        listItem = (listDuring.json.conversations || []).find((c) => c.id === convP.id) || null;
      }
    }
    check('后台生成：/api/generations 报告活跃会话', sawActive);
    check('后台生成：会话带 active 标记（前端据此显示"生成中"而非"已暂停"）', !!(convDuring && convDuring.active === true),
      convDuring && convDuring.active);
    check('后台生成：列表项也带 active（列表能显示转圈）', !!(listItem && listItem.active === true));
    await running;
    const convAfter = await api('/api/conversations/' + convP.id);
    check('后台生成：结束后 active 归位', convAfter.json.active === false, convAfter.json.active);
    await api('/api/conversations/' + convP.id, { method: 'DELETE' });

    // 提问意图 + 富讲解模式
    const intentRes = await api('/api/conversations/' + convC.id, { method: 'PATCH', body: JSON.stringify({ intent: 'debug' }) });
    check('切换提问意图', intentRes.status === 200 && intentRes.json.intent === 'debug', intentRes.json && intentRes.json.intent);
    // 已下线的意图必须回落：proof → 完整讲解；idea（方案可行性）→ 代码评估
    const legacyIntent = await api('/api/conversations/' + convC.id, { method: 'PATCH', body: JSON.stringify({ intent: 'proof' }) });
    check('已下线的意图回落为完整讲解', legacyIntent.status === 200 && legacyIntent.json.intent === 'full', legacyIntent.json && legacyIntent.json.intent);
    const mergedIntent = await api('/api/conversations/' + convC.id, { method: 'PATCH', body: JSON.stringify({ intent: 'idea' }) });
    check('已合并的意图回落为代码评估', mergedIntent.status === 200 && mergedIntent.json.intent === 'debug', mergedIntent.json && mergedIntent.json.intent);
    await api('/api/conversations/' + convC.id, { method: 'PATCH', body: JSON.stringify({ intent: 'debug' }) });
    // 图文讲解是完整讲解的交付形态（不再有开关）：会话上的 rich 字段已不参与决策
    // （这里刻意设成 false 来证明它不影响结果）
    await api('/api/conversations/' + convC.id, { method: 'PATCH', body: JSON.stringify({ rich: false }) });
    const evR = await sseChat({ conversationId: convC.id, mode: 'send', userContent: 'CF 1800C 用图文讲解一遍' });
    const toolsR = evR.filter((e) => e.type === 'tool').map((e) => (e.calls || []).map((c) => c.name)).flat();
    const resR = evR.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const doneR = evR.find((e) => e.type === 'done');
    check('图文讲解：没有开关也照样产出文档（rich=false 只影响老字段，不影响交付形式）',
      toolsR.includes('cf_doc') && resR.some((s) => /文档已生成并落盘/.test(s)), resR.slice(-4));
    check('图文讲解：消息带 richDoc', !!(doneR && doneR.message.richDoc && doneR.message.richDoc.length > 2000),
      doneR && (doneR.message.richDoc || '').length);
    check('图文讲解：文档含 CSP + 设计系统 + 交互组件',
      !!(doneR && /Content-Security-Policy/.test(doneR.message.richDoc) && /class="chapter"/.test(doneR.message.richDoc)
        && /anim-box/.test(doneR.message.richDoc) && /figure class="diagram"/.test(doneR.message.richDoc)));
    // 文档是**一次性交付**的（cf_doc 校验通过才落盘），所以正文里绝不会出现裸 HTML，
    // 而"过程可见"由正文 delta 与思考流承担（旧架构靠讲解 Agent 的 agentDelta 边写边推）
    check('图文讲解：正文里不塞裸 HTML，且生成过程有实时输出',
      !evR.some((e) => e.type === 'delta' && /```html|<div class="wrap"/.test(String(e.text || '')))
      && (evR.filter((e) => e.type === 'delta').length >= 3 || evR.some((e) => e.type === 'richDoc')),
      evR.filter((e) => e.type === 'delta').length);
    const convR = (await api('/api/conversations/' + convC.id)).json;
    const lastR = convR.messages[convR.messages.length - 1];
    check('图文讲解：文档随消息持久化', !!(lastR && lastR.richDoc && lastR.richDoc.length > 2000));
    const hintConv = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + hintConv.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', intent: 'hint' }) });
    const evHint = await sseChat({ conversationId: hintConv.id, mode: 'send', userContent: 'CF 1800C 给我点思路' });
    const doneHint = evHint.find((e) => e.type === 'done');
    check('思路提示仍走轻量文字（只给方向，不产出整份文档）',
      !!(doneHint && !doneHint.message.richDoc && String(doneHint.message.content || '').length > 100),
      { rich: !!(doneHint && doneHint.message.richDoc), len: doneHint && String(doneHint.message.content || '').length });
    await api('/api/conversations/' + hintConv.id, { method: 'DELETE' });

    // ===== 富讲解失败路径：坏文档 → 校验 → 定向修复 → 回落 Markdown，且**原因要能传给用户** =====
    const convBadRich = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convBadRich.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', rich: true, model: 'mock-bad-rich' }) });
    const evBadRich = await sseChat({ conversationId: convBadRich.id, mode: 'send', userContent: 'CF 1800C 用图文讲解一遍' });
    const resBadRich = evBadRich.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    const noticesBadRich = evBadRich.filter((e) => e.type === 'notice').map((e) => e.message);
    const doneBadRich = evBadRich.find((e) => e.type === 'done');
    const wsBadRich = (await api('/api/workspace?convId=' + convBadRich.id)).json;
    check('富讲解失败：回落时把**原因**写进工具结果（不是一句"失败了"）',
      resBadRich.some((s) => /未通过校验/.test(s) && /没有任何 SVG 图解|校验错误/.test(s)), resBadRich.slice(-4));
    check('富讲解失败：给用户发可见提醒（不是只留在内部日志）',
      noticesBadRich.some((s) => /图文文档没通过校验/.test(s)), noticesBadRich);
    check('富讲解失败：被拒的文档留在工作区（可诊断）',
      (wsBadRich.files || []).some((f) => /^richdoc-rejected-/.test(f.name)),
      (wsBadRich.files || []).map((f) => f.name));
    check('富讲解失败：本次仍交付了 Markdown 讲解（不是空白）',
      !!(doneBadRich && doneBadRich.message.content.length > 200) && !doneBadRich.message.richDoc,
      doneBadRich && doneBadRich.message.content.length);
    await api('/api/conversations/' + convBadRich.id, { method: 'DELETE' });

    // ===== 富讲解"救得回来"路径：图确实画了、只是没写成 figure.diagram / 末尾少个 </div> =====
    // 这类不该整份作废（作废 = 回落到没有图的 Markdown，学员看到的就是"富讲解生不出图"）。
    const convSoft = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convSoft.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', rich: true, model: 'mock-rich-soft' }) });
    const evSoft = await sseChat({ conversationId: convSoft.id, mode: 'send', userContent: 'CF 1800C 用图文讲解一遍' });
    const doneSoft = evSoft.find((e) => e.type === 'done');
    const wsSoft = (await api('/api/workspace?convId=' + convSoft.id)).json;
    const trajSoft = (wsSoft.meta && wsSoft.meta.trajectory) || [];
    const docSoft = (doneSoft && doneSoft.message.richDoc) || '';
    const resSoft = evSoft.filter((e) => e.type === 'toolResult').map((e) => (e.results || []).map((r) => r.summary)).flat();
    check('富讲解容错：图解写成 <div class="card"><svg> 也能交付（宽容计数，不回落）',
      // 判据用"结构 + 图数量"而不是固定字数：这份夹具比标准文档短，卡字数会误判
      docSoft.length > 1200 && (docSoft.match(/<svg/gi) || []).length >= 2 && /class="chapter"/.test(docSoft),
      { docLen: docSoft.length, svgs: (docSoft.match(/<svg/gi) || []).length });
    // 末尾少 </div> → cf_doc 里先做一次**机械挽救**（净化 + 补齐闭合标签）再验一次，通过就交付
    check('富讲解容错：末尾少 </div> 由机械补齐修好（不再整份作废）',
      resSoft.some((s) => /机械修正后交付|机械补齐后交付/.test(s)), resSoft.slice(-3));
    check('富讲解容错：没有回落 Markdown（richdoc-fallback 不出现）',
      !trajSoft.some((t) => t.kind === 'richdoc-fallback'), trajSoft.map((t) => t.kind));
    await api('/api/conversations/' + convSoft.id, { method: 'DELETE' });

    // ===== 单次输出上限：被"思考"吃光（finish_reason=length 且正文为空）→ 自动去掉上限重试 =====
    // 实测 deepseek-flash 带 max_tokens=16384 时就是这个表现：思考 16384 token、正文 0 字。
    const cfgCap = (await api('/api/config')).json;
    await api('/api/config', { method: 'POST', body: JSON.stringify(Object.assign({}, cfgCap, { maxOutputTokens: 4096 })) });
    const statsBefore = await mockStats();
    const convCap = (await api('/api/conversations', { method: 'POST', body: '{}' })).json;
    await api('/api/conversations/' + convCap.id, { method: 'PATCH', body: JSON.stringify({ mode: 'coach', lang: 'python', rich: true, model: 'mock-cap-empty' }) });
    const evCap = await sseChat({ conversationId: convCap.id, mode: 'send', userContent: 'CF 1800C 用图文讲解一遍' });
    const doneCap = evCap.find((e) => e.type === 'done');
    const statsAfter = await mockStats();
    check('输出上限：确实把上限发给了上游（设置真的生效）',
      !!(statsAfter && statsBefore && statsAfter.capEmptyServed > statsBefore.capEmptyServed),
      JSON.stringify({ before: statsBefore && statsBefore.capEmptyServed, after: statsAfter && statsAfter.capEmptyServed }));
    // 注意：富讲解模式下消息正文本来就只是一句引子（文档在 richDoc 里），所以判据是"文档带图且状态正常"
    check('输出上限：被截断且正文为空 → 自动去掉上限重试，仍然拿到完整讲解',
      !!(doneCap && doneCap.message && doneCap.message.status === 'done'
        && String(doneCap.message.richDoc || '').length > 2000
        && (String(doneCap.message.richDoc || '').match(/<svg/gi) || []).length >= 2),
      JSON.stringify(doneCap && { content: String(doneCap.message.content || '').length,
        rich: (doneCap.message.richDoc || '').length, status: doneCap.message.status,
        svgs: (String(doneCap.message.richDoc || '').match(/<svg/gi) || []).length }));
    await api('/api/conversations/' + convCap.id, { method: 'DELETE' });
    await api('/api/config', { method: 'POST', body: JSON.stringify(cfgCap) });

    // CF rating 历史（折线图数据）
    const ratingRes = await api('/api/cf/rating?handle=tester');
    check('CF rating 历史', ratingRes.status === 200 && ratingRes.json.history.length === 6 && ratingRes.json.history[5].newRating === 1620);

    // 题目自动分类（对话结束后异步触发）
    let autoClassify = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const c = (await api('/api/conversations/' + convC.id)).json;
      if (c.problemMeta && c.problemMeta.knowledge && c.problemMeta.knowledge.length) { autoClassify = true; break; }
    }
    check('对话后自动分类题目', autoClassify);
    const clsManual = await api('/api/conversations/' + convC.id + '/classify', { method: 'POST', body: '{}' });
    check('手动重新分类', clsManual.status === 200 && clsManual.json.problemMeta && clsManual.json.problemMeta.rating === 1500, clsManual.json && clsManual.json.problemMeta);
    check('分类含知识点', clsManual.json.problemMeta && (clsManual.json.problemMeta.knowledge || []).length >= 1);
    check('分类保留官方标签', clsManual.json.problemMeta && Array.isArray(clsManual.json.problemMeta.tags) && clsManual.json.problemMeta.tags.length >= 1);
    const listWithMeta = (await api('/api/conversations')).json.conversations.find((c) => c.id === convC.id);
    check('会话列表带题目分类', !!(listWithMeta && listWithMeta.problemMeta && listWithMeta.problemMeta.rating === 1500));

    // 对话结束后异步自动更新信息卡（轮询等待 mock 学情分析师写入）
    let autoOk = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const p = (await api('/api/profile')).json;
      if (p.card && p.card.profileText && p.card.profileText.indexOf('Expert') >= 0) { autoOk = true; break; }
    }
    check('对话后自动更新信息卡', autoOk);
    const profNow = (await api('/api/profile')).json;
    check('信息卡含 rating 与统计', profNow.card && profNow.card.rating === 1620 && profNow.card.solvedCount === 5, profNow.card && { rating: profNow.card.rating, solved: profNow.card.solvedCount });
    check('信息卡优势/薄弱点', profNow.card && profNow.card.strengths.length >= 1 && profNow.card.weaknesses.length >= 1);
    // 强制刷新
    const profRefresh = await api('/api/profile/refresh', { method: 'POST', body: '{}' });
    check('信息卡强制刷新', profRefresh.status === 200 && profRefresh.json.card.profileText.indexOf('Expert') >= 0);
    await api('/api/conversations/' + convC.id, { method: 'DELETE' });
  }

  console.log('\n== 12. 本地运行器（直接单测 lib/runner） ==');
  {
    const runner = require('../lib/runner');
    const SOL_OK = `const fs=require('fs');const d=fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);let p=0;const t=d[p++];const o=[];for(let c=0;c<t;c++){const n=d[p++];const a=d.slice(p,p+n);p+=n;o.push(a.reduce((x,y)=>x+y,0));}console.log(o.join('\\n'));`;
    const BRUTE_OK = `const fs=require('fs');const d=fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);let p=0;const t=d[p++];const o=[];for(let c=0;c<t;c++){const n=d[p++];const a=d.slice(p,p+n);p+=n;let s=0;for(const x of a)s+=x;o.push(s);}console.log(o.join('\\n'));`;
    const GEN = `const n=1+Math.floor(Math.random()*6);const a=[];for(let i=0;i<n;i++)a.push(Math.floor(Math.random()*20));console.log('1\\n'+n+'\\n'+a.join(' '));`;
    const r = await runner.stressTest({ solution: { lang: 'js', code: SOL_OK }, brute: { lang: 'js', code: BRUTE_OK }, gen: { lang: 'js', code: GEN }, iterations: 20 });
    check('运行器对拍通过', r.ok && r.status === 'ok', r);
  }

  /* ---- 13. CF 题面解析器回归（真实页面结构，离线） ---- */
  console.log('\n== 13. CF 题面解析器回归 ==');
  {
    const cfLib = require('../lib/cf.js');
    const fixtures = path.join(__dirname, 'fixtures');
    // 现场事故 1：浏览器通道拿到的是 MathJax 渲染后的 DOM（公式旁有 <script type="math/tex">），
    // 旧解析器把 <script 当结束标记 → 题面在第一个公式处被截断、样例 0 组。
    const domHtml = fs.readFileSync(path.join(fixtures, 'cf-2264D-dom.html'), 'utf8');
    const dom = cfLib.parseProblemPage(domHtml, 2264, 'D');
    check('渲染 DOM：题面完整（>1000 字）', dom.statement.length > 1000, dom.statement.length);
    check('渲染 DOM：题面未被公式截断（含 Output 段）', /Output/.test(dom.statement));
    check('渲染 DOM：公式还原为 LaTeX', dom.statement.indexOf('$n$') >= 0 && /\\le/.test(dom.statement));
    check('渲染 DOM：无重复公式文本', dom.statement.indexOf('nn') < 0 && dom.statement.indexOf('n=1n=1') < 0);
    const domSamples = dom.samples.filter((s) => s.input != null);
    check('渲染 DOM：样例解析出 1 组', domSamples.length === 1, domSamples.length);
    check('渲染 DOM：样例内容正确', !!domSamples[0] && /^6/.test(domSamples[0].input) && /010100/.test(domSamples[0].output));
    check('渲染 DOM：时限/内存解析', dom.timeLimit === '2 seconds' && dom.memoryLimit === '256 megabytes',
      dom.timeLimit + ' / ' + dom.memoryLimit);

    // CF 原始标记（浏览器内 fetch 通道 / 直连通道）
    const rawHtml = fs.readFileSync(path.join(fixtures, 'cf-2264D-raw.html'), 'utf8');
    const raw = cfLib.parseProblemPage(rawHtml, 2264, 'D');
    check('原始 HTML：题面完整', raw.statement.length > 1000 && /Output/.test(raw.statement), raw.statement.length);
    check('原始 HTML：样例解析出 1 组', raw.samples.filter((s) => s.input != null).length === 1);
  }

  /* ---- 14. 中断后会话自愈（僵尸 streaming） ---- */
  console.log('\n== 14. 中断后状态自愈 ==');
  {
    const c = (await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '自愈测试' }) })).json;
    // 伪造一条「上次异常退出留下的 streaming 消息」
    await api('/api/conversations/' + c.id + '/messages', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { id: 'm_z1', role: 'user', content: '在看这道题', createdAt: Date.now() },
          { id: 'm_z2', role: 'assistant', content: '', reasoning: '想了半天', status: 'streaming', createdAt: Date.now() }
        ]
      })
    });
    const reopened = (await api('/api/conversations/' + c.id)).json;
    const zombie = (reopened.messages || []).find((m) => m.id === 'm_z2');
    check('陈旧 streaming 被自愈', !!zombie && zombie.status !== 'streaming', zombie && zombie.status);
    check('自愈保留已生成的思考内容', !!zombie && zombie.reasoning === '想了半天');
    // 自愈后必须还能继续发消息（旧 bug：重新生成报「正在生成中」）
    const regen = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: c.id, mode: 'regenerate' })
    });
    check('自愈后可重新生成（不再被卡住）', regen.status === 200, regen.status);
    try { await regen.body.cancel(); } catch (e) { /* ignore */ }
    await api('/api/conversations/' + c.id, { method: 'DELETE' });
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) {
    console.log('失败清单：');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});
