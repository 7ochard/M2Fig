const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getContext: () => ipcRenderer.invoke('bridge:context'),
  chooseDirectory: () => ipcRenderer.invoke('bridge:choose-directory'),
  startExport: (request) => ipcRenderer.invoke('bridge:start', request),
  openOutput: () => ipcRenderer.invoke('bridge:open-output'),
  copyPluginPath: () => ipcRenderer.invoke('bridge:copy-plugin-path'),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('bridge:event', listener);
    return () => ipcRenderer.removeListener('bridge:event', listener);
  },
});
