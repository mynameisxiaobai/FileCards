'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 渲染进程唯一的能力出口。
 * sandbox: true 下 webUtils 仍在 Electron 的白名单里，所以不需要关沙箱。
 */
contextBridge.exposeInMainWorld('bridge', {
  /**
   * 取拖入文件的真实磁盘路径。
   * 必须在 drop 事件里同步调用 —— DataTransferItemList 在回调返回后即失效。
   * 虚拟文件（浏览器图片、Outlook 附件）会返回空串。
   */
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  init: () => ipcRenderer.invoke('app:init'),

  pickDir: (cardId) => ipcRenderer.invoke('card:pick-dir', cardId),
  addCard: () => ipcRenderer.invoke('card:add'),
  removeCard: (cardId) => ipcRenderer.invoke('card:remove', cardId),
  renameCard: (cardId, label) => ipcRenderer.invoke('card:rename', cardId, label),
  cardMenu: (cardId) => ipcRenderer.invoke('card:menu', cardId),

  moveToCard: (cardId, paths) => ipcRenderer.invoke('move:to-card', cardId, paths),

  openCollect: () => ipcRenderer.invoke('collect:open'),

  applyLayout: () => ipcRenderer.invoke('win:layout'),
  getBounds: () => ipcRenderer.invoke('win:get-bounds'),
  setBounds: (b) => ipcRenderer.invoke('win:set-bounds', b),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('win:always-on-top', v),
  hideToTray: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),

  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),

  onStateChanged(cb) {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state:changed', h);
    return () => ipcRenderer.removeListener('state:changed', h);
  },
  onProgress(cb) {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('move:progress', h);
    return () => ipcRenderer.removeListener('move:progress', h);
  },
  onEditLabel(cb) {
    const h = (_e, id, label) => cb(id, label);
    ipcRenderer.on('card:edit-label', h);
    return () => ipcRenderer.removeListener('card:edit-label', h);
  },
});
