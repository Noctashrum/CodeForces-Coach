/**
 * electron/preload.js — 页面与主进程之间的安全桥接
 * 暴露最小 API：最小化到托盘 / 用系统浏览器打开链接
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatbox', {
  hideToTray: () => {
    try { ipcRenderer.send('hide-to-tray'); } catch (e) { /* ignore */ }
  },
  openExternal: (url) => {
    try {
      if (/^https?:\/\//i.test(String(url || ''))) ipcRenderer.send('open-external', String(url));
    } catch (e) { /* ignore */ }
  },
  // 打开本地文件/文件夹（限定在应用数据目录内，主进程会再校验一次）
  openPath: (p) => {
    try { ipcRenderer.send('open-path', String(p || '')); } catch (e) { /* ignore */ }
  },
  // 清理内嵌 CF 抓取会话的 cookie/缓存（不触碰用户浏览器）
  clearCfSession: () => {
    try { return ipcRenderer.invoke('cf-clear-session'); } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  // 抓取单条提交的源码（复用内嵌抓取窗口过 Cloudflare 挑战）
  // 入参 { contestId, submissionId } → 成功 { ok:true, code, lang, verdict, problem, url }；
  // 失败 { ok:false, reason: 'not-found' | 'source-unavailable' | 'timeout' | '<短消息>' }，永不抛异常
  fetchSubmissionSource: (p) => {
    try { return ipcRenderer.invoke('cf-fetch-submission', p); } catch (e) { return Promise.resolve({ ok: false, reason: String((e && e.message) || e) }); }
  },
  // 抓取官方题解（**不是每道题都有**：老比赛常常没有，侧边栏找不到链接就是没有）
  // 入参 { contestId, index } 或 { entryId } → 成功 { ok:true, entryId, url, content, sliced }
  // 失败 { ok:false, reason: 'no-tutorial-link' | 'not-found' | 'timeout' | '<短消息>' }
  fetchEditorial: (p) => {
    try { return ipcRenderer.invoke('cf-fetch-editorial', p); } catch (e) { return Promise.resolve({ ok: false, reason: String((e && e.message) || e) }); }
  },
  // 反爬挑战的人工兜底：打开一个**可见**窗口让 Cloudflare 挑战真正跑完
  // （隐藏窗口经常过不了挑战；通过后 cookie 留在同一个会话分区，后续抓取直接可用）
  // 入参 { url, waitMs } → { ok, finalUrl, note } 或 { ok:false, error }
  openChallengeWindow: (p) => {
    try { return ipcRenderer.invoke('cf-open-challenge-window', p); } catch (e) { return Promise.resolve({ ok: false, error: String((e && e.message) || e) }); }
  },
  // 打开 Codeforces 登录页，让用户在**应用内浏览器**里登录一次。
  // 必须有这条：CF 要求登录后才能看提交源码，未登录访问提交页会被 302 到首页
  // （实测：连别人的公开提交也一样），于是"取源码"永远失败。
  // 入参 { waitMs } → { ok, loggedIn, handle, finalUrl, note }
  openCfLogin: (p) => {
    try { return ipcRenderer.invoke('cf-open-login', p); } catch (e) { return Promise.resolve({ ok: false, error: String((e && e.message) || e) }); }
  }
});
