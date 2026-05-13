const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const Watcher = require('./watcher');

// Config
const CONFIG = {
  DOWNLOAD_PATH: process.env.KFM_DOWNLOAD_PATH || 'C:\\downloads',
  BACKEND_URL: process.env.KFM_BACKEND_URL || 'http://localhost:4545',
  API_KEY: process.env.KFM_API_KEY || '',
  AUTO_START: process.env.KFM_AUTO_START !== 'false'
};

let mainWindow, tray, watcher;
let isQuitting = false;
const BRIDGE_ID = uuidv4().slice(0, 8);

function log(level, msg, data = null) {
  const entry = `[${moment().format('HH:mm:ss')}] [${level}] ${msg}`;
  console.log(entry);
  if (data) console.log('  →', JSON.stringify(data));
}

function ensureWatchPath() {
  if (!fs.existsSync(CONFIG.DOWNLOAD_PATH)) {
    log('WARN', `Pasta não existe: ${CONFIG.DOWNLOAD_PATH}`);
    return false;
  }
  return true;
}

function generateMockOrder(filePath) {
  const items = [
    { setor: 'Fritadeira', item: 'Batata frita', quantidade: 2 },
    { setor: 'Fritadeira', item: 'Anel de cebola', quantidade: 1 },
    { setor: 'Fogão', item: 'Picanha', quantidade: 1 },
    { setor: 'Fogão', item: 'Frango grelhado', quantidade: 2 },
    { setor: 'Saladas', item: 'Salada verde', quantidade: 1 },
    { setor: 'Frios', item: 'Tábua de frios', quantidade: 1 },
    { setor: 'Entradas', item: 'Bruschetta', quantidade: 2 },
    { setor: 'Sobremesas', item: 'Petit gâteau', quantidade: 1 }
  ];
  
  const isDelivery = Math.random() < 0.2;
  const numItems = Math.floor(Math.random() * 4) + 2;
  const shuffled = items.sort(() => 0.5 - Math.random());
  
  return {
    mesa: isDelivery ? `Delivery #${Math.floor(Math.random()*500)+1}` : `Mesa ${Math.floor(Math.random()*20)+1}`,
    tipo: isDelivery ? 'delivery' : 'salao',
    itens: shuffled.slice(0, numItems).map(i => ({ ...i }))
  };
}

async function sendOrderToBackend(filePath, mockData) {
  const url = `${CONFIG.BACKEND_URL.replace(/\/$/, '')}/api/orders`;
  
  const payload = {
    sourceFile: path.basename(filePath),
    mockData,
    bridgeId: BRIDGE_ID,
    timestamp: moment().toISOString()
  };
  
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'KitchenFlowBridge/2.0'
  };
  
  if (CONFIG.API_KEY) {
    headers['X-API-Key'] = CONFIG.API_KEY;
  }
  
  try {
    log('INFO', `Enviando para ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeout: 10000
    });
    
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    
    const result = await response.json();
    log('SUCCESS', `Pedido enviado: ${result.order?.mesa}`);
    return result;
    
  } catch(error) {
    log('ERROR', `Falha ao enviar: ${error.message}`);
    if (!error._retried) {
      error._retried = true;
      await new Promise(r => setTimeout(r, 2000));
      return sendOrderToBackend(filePath, mockData);
    }
    throw error;
  }
}

function moveProcessedFile(filePath) {
  const processedDir = path.join(__dirname, 'processed');
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }
  
  const fileName = path.basename(filePath);
  const dest = path.join(processedDir, `${moment().format('YYYYMMDD_HHmmss')}_${fileName}`);
  
  try {
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
    log('INFO', `Arquivo movido: ${fileName}`);
    return true;
  } catch(e) {
    log('ERROR', `Falha ao mover: ${e.message}`);
    return false;
  }
}

async function handleNewFile(filePath) {
  if (!filePath.toLowerCase().endsWith('.saiposnfeprt')) return;
  
  log('INFO', `Novo arquivo: ${path.basename(filePath)}`);
  
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('file-detected', {
      fileName: path.basename(filePath),
      time: moment().format('HH:mm:ss')
    });
  }
  
  try {
    const mockData = generateMockOrder(filePath);
    await sendOrderToBackend(filePath, mockData);
    moveProcessedFile(filePath);
    
    showNotification('Pedido processado!', `📋 ${mockData.mesa} • ${mockData.itens.length} itens`);
    
  } catch(error) {
    log('ERROR', `Erro: ${error.message}`);
    showNotification('Erro ao processar', error.message, 'error');
  }
}

function showNotification(title, body, type = 'info') {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: path.join(__dirname, 'icon.png') }).show();
  }
  
  if (tray) {
    tray.setToolTip(`Kitchen Flow: ${title}`);
    setTimeout(() => tray.setToolTip('Kitchen Flow Bridge'), 3000);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: process.argv.includes('--dev'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png'),
    title: 'Kitchen Flow Bridge',
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    resizable: false
  });
  
  mainWindow.loadFile('index.html');
  
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
  
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  } else {
    icon = icon.resize({ width: 16, height: 16 });
  }
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mostrar',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: 'separator' },
    { label: `Pasta: ${CONFIG.DOWNLOAD_PATH}`, enabled: false },
    { label: `Backend: ${CONFIG.BACKEND_URL}`, enabled: false },
    { type: 'separator' },
    { label: CONFIG.API_KEY ? '✓ Autenticado' : '⚠ Sem API Key', enabled: false },
    { label: `Bridge ID: ${BRIDGE_ID}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => { isQuitting = true; app.quit(); }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
  tray.setToolTip('Kitchen Flow Bridge');
  
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function startWatcher() {
  if (!ensureWatchPath()) {
    log('ERROR', 'Não foi possível iniciar monitoramento');
    showNotification('Erro', `Pasta não encontrada: ${CONFIG.DOWNLOAD_PATH}`, 'error');
    return;
  }
  
  watcher = new Watcher(CONFIG.DOWNLOAD_PATH, { onNewFile: handleNewFile });
  log('INFO', `Monitorando: ${CONFIG.DOWNLOAD_PATH}`);
}

ipcMain.handle('get-config', () => ({ ...CONFIG, bridgeId: BRIDGE_ID }));
ipcMain.handle('get-status', () => ({
  watching: watcher?.isActive || false,
  backend: CONFIG.BACKEND_URL,
  uptime: process.uptime(),
  bridgeId: BRIDGE_ID
}));
ipcMain.handle('trigger-test', () => watcher?.triggerTest?.());

app.whenReady().then(async () => {
  log('INFO', 'Kitchen Flow Bridge iniciando...');
  log('INFO', `Backend: ${CONFIG.BACKEND_URL}`);
  log('INFO', `Bridge ID: ${BRIDGE_ID}`);
  
  createTray();
  createWindow();
  startWatcher();
  
  showNotification('Kitchen Flow Bridge', 'Monitoramento ativo');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Manter rodando no tray
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  watcher?.stop();
  log('INFO', 'Encerrando...');
});

module.exports = { CONFIG, BRIDGE_ID, handleNewFile };