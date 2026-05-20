const { contextBridge, ipcRenderer } = require('electron');

// Expor API segura para o renderer process
contextBridge.exposeInMainWorld('bridgeAPI', {
  // ========== CONFIGURAÇÕES ==========
  getConfig: () => ipcRenderer.invoke('get-config'),
  
  // ========== STATUS ==========
  getStatus: () => ipcRenderer.invoke('get-status'),
  
  // ========== TESTES ==========
  triggerTest: () => ipcRenderer.invoke('trigger-test'),
  
  // ========== CARDÁPIO ==========
  reloadMenu: () => ipcRenderer.invoke('reload-menu'),
  getMenuInfo: () => ipcRenderer.invoke('get-menu-info'),
  
  // ========== HISTÓRICO ==========
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  
  // ========== CONFIGURAÇÃO DE PASTA ==========
  setDownloadPath: (newPath) => ipcRenderer.invoke('set-download-path', newPath),
  
  // ========== LICENÇA ==========
  getLicenseStatus: () => ipcRenderer.invoke('get-lic-status'),
  activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
  restartApp: () => ipcRenderer.send('restart-app'),
  
  // ========== EVENTOS (Listeners) ==========
  
  // Quando um novo arquivo é detectado pelo watcher
  onFileDetected: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('file-detected', listener);
    return () => ipcRenderer.removeListener('file-detected', listener);
  },
  
  // Quando o histórico é atualizado
  onHistoryUpdated: (callback) => {
    const listener = (event, history) => callback(history);
    ipcRenderer.on('history-updated', listener);
    return () => ipcRenderer.removeListener('history-updated', listener);
  },
  
  // Quando as configurações são carregadas
  onConfigLoaded: (callback) => {
    const listener = (event, config) => callback(config);
    ipcRenderer.on('config-loaded', listener);
    return () => ipcRenderer.removeListener('config-loaded', listener);
  },
  
  // Quando as configurações são atualizadas
  onConfigUpdated: (callback) => {
    const listener = (event, config) => callback(config);
    ipcRenderer.on('config-updated', listener);
    return () => ipcRenderer.removeListener('config-updated', listener);
  },
  
  // Quando a licença muda de status
  onLicenseChanged: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('license-changed', listener);
    return () => ipcRenderer.removeListener('license-changed', listener);
  }
});