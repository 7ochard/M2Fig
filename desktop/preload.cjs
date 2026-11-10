const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getContext: () => ipcRenderer.invoke('bridge:context'),
  chooseDirectory: () => ipcRenderer.invoke('bridge:choose-directory'),
  useDefaultDirectory: () => ipcRenderer.invoke('bridge:use-default-directory'),
  startExport: (request) => ipcRenderer.invoke('bridge:start', request),
  openOutput: () => ipcRenderer.invoke('bridge:open-output'),
  openFigmaTarget: (url) => ipcRenderer.invoke('bridge:open-figma-target', url),
  openMasterGoTarget: (url) => ipcRenderer.invoke('bridge:open-mastergo-target', url),
  copyPluginPath: () => ipcRenderer.invoke('bridge:copy-plugin-path'),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('bridge:event', listener);
    return () => ipcRenderer.removeListener('bridge:event', listener);
  },
});
