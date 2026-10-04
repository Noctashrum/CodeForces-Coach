/**
 * lib/serialqueue.js — 串行队列（把"共享同一个不可重入资源"的异步任务排队）
 *
 * 为什么需要它：cf-coach 支持**多题并行**（两个会话同时讲两道不同的题），
 * 但有两处资源是全局唯一的、不能并发使用：
 *   ① CF 抓取窗口（electron/main.js 里只有**一个** cfWindow，靠它的
 *      did-finish-load/did-fail-load 事件 + 轮询判断"这一页是不是题面"）
 *      —— 两个抓取同时进行会互相抢导航、互相读到对方的页面；
 *   ② 同一道题的**工作区**（按题号共享的缓存目录：brute.py / gen.py / meta.json）
 *      —— 两个会话同时写同一批文件，等于两边都在用被对方改过的标尺，
 *         最坏的结果是"各自以为验证通过"，即静默的错误结论。
 *
 * 设计：纯粹的 promise 链，不依赖任何业务；队列里一个任务抛错**不会**卡住后面的任务
 * （错误原样传给调用方，链上只记 settled）。这样它既能在 electron 主进程里用，
 * 也能在 lib/workspace.js 里按 key 各建一条链 —— 于是"多题并行"与"同题串行"同时成立。
 */
'use strict';

/**
 * @param {(info: {waited: boolean, pending: number}) => void} [onStart]
 *        任务真正开始执行时回调：waited=它是否排过队（用来打日志/上报），
 *        pending=此刻还排在它后面的任务数
 */
function createSerialQueue(onStart) {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    /** 排队执行 fn；返回 fn 的结果（错误原样抛出给调用方） */
    push(fn) {
      const waited = pending > 0;
      pending++;
      const start = () => {
        if (typeof onStart === 'function') {
          try { onStart({ waited: waited, pending: pending - 1 }); } catch (e) { /* 回调不该影响任务 */ }
        }
        return fn();
      };
      // 前一个任务失败也要继续（用 then 的两个分支都接同一个 start）
      const p = tail.then(start, start);
      const done = () => { pending--; };
      p.then(done, done);
      tail = p.then(() => undefined, () => undefined);
      return p;
    },
    /** 已入队但尚未结束的任务数（含正在执行的那个） */
    get pending() { return pending; }
  };
}

module.exports = { createSerialQueue };
