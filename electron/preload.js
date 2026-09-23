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
  }
});
