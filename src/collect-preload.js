'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 收集弹窗专用 preload。
 * 只暴露它自己用得上的能力，跟主窗口的 bridge 分开，避免互相牵连。
 */
contextBridge.exposeInMainWorld('collect', {
  /** 取拖入对象的真实磁盘路径。必须在 drop 回调里同步调用。 */
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  defaults: () => ipcRenderer.invoke('collect:defaults'),
  pick: (kind) => ipcRenderer.invoke('collect:pick', kind),
  inspect: (p) => ipcRenderer.invoke('collect:inspect', p),
  start: (opts) => ipcRenderer.invoke('collect:start', opts),
  cancel: () => ipcRenderer.invoke('collect:cancel'),
  remember: (opts) => ipcRenderer.invoke('collect:remember', opts),
  reveal: (p) => ipcRenderer.invoke('collect:reveal', p),
  close: () => ipcRenderer.invoke('collect:close'),

  onProgress(cb) {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('collect:progress', h);
    return () => ipcRenderer.removeListener('collect:progress', h);
  },
});
