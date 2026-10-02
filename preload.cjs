'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('mmm', Object.freeze({
  chooseStorage: () => ipcRenderer.invoke('public:choose-storage'),
  saveText: value => ipcRenderer.invoke('public:save-text', value),
  openService: (kind, browser = 'default') => ipcRenderer.invoke('public:open-service', { kind, browser }),
  cliStatus: kind => ipcRenderer.invoke('public:cli-status', kind),
  openCli: (kind, action) => ipcRenderer.invoke('public:open-cli', { kind, action }),
  grantSourceRead: (projectId, sourceId) => ipcRenderer.invoke('public:grant-source-read', { projectId, sourceId }),
  chooseSources: kind => ipcRenderer.invoke('public:choose-sources', kind),
  releaseSources: tokens => ipcRenderer.invoke('public:release-sources', tokens),
  dropSources: files => {
    try {
      if (!Array.isArray(files) || !files.length || files.length > 100) return Promise.resolve({ error: 'INVALID_SOURCE_SELECTION' });
      // File.path was removed by Electron. Only OS-backed File objects yield a
      // path; a web-created File cannot invent an arbitrary host path here.
      const paths = files.map(file => webUtils.getPathForFile(file));
      if (paths.some(value => !value)) return Promise.resolve({ error: 'NATIVE_SOURCE_SELECTION_REQUIRED' });
      return ipcRenderer.invoke('public:drop-sources', paths);
    } catch { return Promise.resolve({ error: 'INVALID_SOURCE_SELECTION' }); }
  }
}));
