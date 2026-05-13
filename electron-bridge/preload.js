const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  triggerTest: () => ipcRenderer.invoke('trigger-test'),
  onFileDetected: (cb) => {
    const listener = (event, data) => cb(data);
    ipcRenderer.on('file-detected', listener);
    return () => ipcRenderer.removeListener('file-detected', listener);
  }
});