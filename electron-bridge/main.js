const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const Watcher = require('./watcher');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CONFIG = {
  DOWNLOAD_PATH: process.env.KFM_DOWNLOAD_PATH || 'C:\\downloads',
  BACKEND_URL: process.env.KFM_BACKEND_URL || 'http://localhost:4545',
  API_KEY: process.env.KFM_API_KEY || '',
  AUTO_START: process.env.KFM_AUTO_START !== 'false'
};

// ============================================================================
// CARREGAR DICIONÁRIO DO CARDÁPIO
// ============================================================================
const MENU_MAP_PATH = path.join(__dirname, 'menu-map.json');
let menuMap = { pratos: {}, acompanhamentos_avulsos: {}, acompanhamentos_fixos_por_categoria: {} };

function loadMenuMap() {
  try {
    if (fs.existsSync(MENU_MAP_PATH)) {
      menuMap = JSON.parse(fs.readFileSync(MENU_MAP_PATH, 'utf8'));
      console.log(`📖 Cardápio carregado: ${Object.keys(menuMap.pratos || {}).length} pratos`);
      return true;
    }
    return false;
  } catch(e) {
    console.error('❌ Erro ao carregar menu-map.json:', e.message);
    return false;
  }
}
loadMenuMap();

// ============================================================================
// VARIÁVEIS GLOBAIS
// ============================================================================
let mainWindow = null; // ← Garante instância única
let tray = null;
let watcher = null;
let isQuitting = false;
const BRIDGE_ID = uuidv4().slice(0, 8);
const BACKUP_DIR = path.join(process.env.USERPROFILE || 'C:\\', 'KitchenFlow', 'backup');

// ============================================================================
// FUNÇÕES DE UTILIDADE
// ============================================================================
function log(level, msg, data = null) {
  const entry = `[${moment().format('HH:mm:ss')}] [${level}] ${msg}`;
  console.log(entry);
  if (data) console.log('  →', JSON.stringify(data));
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Limpeza automática de backups antigos (>24h)
setInterval(() => {
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      const files = fs.readdirSync(BACKUP_DIR);
      const now = Date.now();
      files.forEach(f => {
        const filePath = path.join(BACKUP_DIR, f);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          console.log(`🧹 Backup limpo: ${f}`);
        }
      });
    }
  } catch(e) {}
}, 60 * 60 * 1000);

// ============================================================================
// PARSER SAIPos V2.1 (BASE64 + JSON + HTML STRIP)
// ============================================================================
function parseSaiposFile(filePath) {
  try {
    const rawContent = fs.readFileSync(filePath, 'utf8').trim();
    if (!rawContent) { console.warn('⚠️ Arquivo vazio'); return null; }

    const decodedBuffer = Buffer.from(rawContent, 'base64');
    const decodedJson = decodedBuffer.toString('utf8');
    
    const dataArray = JSON.parse(decodedJson);
    const data = Array.isArray(dataArray) ? dataArray[0] : dataArray;

    if (!data.printRows) { console.warn('⚠️ Sem printRows'); return null; }

    const cleanRows = data.printRows.map(row => 
      row.replace(/<[^>]+>/g, '')
         .replace(/&nbsp;/g, ' ')
         .replace(/\s+/g, ' ')
         .trim()
    );

    let mesa = 'Desconhecida';
    let garcom = 'Desconhecido';
    let itemsRaw = [];

    cleanRows.forEach(row => {
      if (row.includes('Mesa:')) {
        const match = row.match(/Mesa:\s*(\d+)/);
        if (match) mesa = `Mesa ${match[1]}`;
      }
      if (row.includes('Garçom:')) {
        garcom = row.split('Garçom:')[1].split('-')[0].trim();
      }
      if (/^\d+\s+[A-Za-zÀ-ú]/.test(row) && !row.includes('Quantidade de itens') && !row.includes('ID do Pedido')) {
        itemsRaw.push(row);
      }
    });

    return { mesa, garcom, itemsRaw, fullData: data };
  } catch(e) {
    console.error('❌ Falha ao parsear:', e.message);
    return null;
  }
}

// ============================================================================
// GERADOR DE PEDIDO (PARSER + MAPA)
// ============================================================================
function generateOrderFromParsedData(parsedData) {
  if (!parsedData || !parsedData.itemsRaw.length) {
    console.warn('⚠️ Nenhum item encontrado, usando fallback');
    return generateRandomFallback();
  }

  const itensFinais = [];

  parsedData.itemsRaw.forEach(rawItem => {
    const match = rawItem.match(/^(\d+)\s+(.+)/);
    if (!match) return;
    
    const qty = parseInt(match[1]);
    const descricao = match[2].toLowerCase().trim();
    
    let matchedPrato = null;
    for (const [key, prato] of Object.entries(menuMap.pratos)) {
      const pratoKey = key.toLowerCase();
      if (descricao.includes(pratoKey) || pratoKey.includes(descricao.split(' ')[0])) {
        matchedPrato = prato;
        break;
      }
    }

    if (matchedPrato) {
      matchedPrato.composicao.forEach(comp => {
        itensFinais.push({
          uuid: uuidv4(),
          setor: comp.setor,
          item: comp.item,
          quantidade: (comp.quantidade || 1) * qty,
          original: rawItem
        });
      });
      if (matchedPrato.categoria && menuMap.acompanhamentos_fixos_por_categoria?.[matchedPrato.categoria]) {
        menuMap.acompanhamentos_fixos_por_categoria[matchedPrato.categoria].forEach(acc => {
          itensFinais.push({
            uuid: uuidv4(),
            setor: acc.setor,
            item: acc.item,
            quantidade: (acc.quantidade || 1) * qty,
            original: rawItem
          });
        });
      }
    } else {
      itensFinais.push({
        uuid: uuidv4(),
        setor: 'Fogão',
        item: rawItem,
        quantidade: qty,
        original: rawItem
      });
    }
  });

  return {
    mesa: parsedData.mesa,
    garcom: parsedData.garcom,
    tipo: 'salao',
    itens: itensFinais,
    rawItems: parsedData.itemsRaw
  };
}

function generateRandomFallback() {
  return {
    mesa: `Mesa ${Math.floor(Math.random() * 20) + 1}`,
    tipo: 'salao',
    itens: [{ uuid: uuidv4(), setor: 'Fogão', item: 'Pedido Genérico', quantidade: 1 }]
  };
}

// ============================================================================
// HANDLER PRINCIPAL (COM BACKUP ATÔMICO)
// ============================================================================
async function handleNewFile(originalPath) {
  log('INFO', `📄 Detectado: ${path.basename(originalPath)}`);
  
  ensureBackupDir();
  const fileName = path.basename(originalPath);
  const backupPath = path.join(BACKUP_DIR, `${moment().format('YYYYMMDD_HHmmss')}_${fileName}`);
  
  try {
    fs.copyFileSync(originalPath, backupPath);
    log('INFO', `📦 Backup criado: ${backupPath}`);
    
    const parsedData = parseSaiposFile(backupPath);
    if (!parsedData) {
      log('ERROR', 'Falha ao extrair dados do pedido');
      return;
    }
    
    log('INFO', `✅ Pedido extraído: ${parsedData.mesa} | Garçom: ${parsedData.garcom} | ${parsedData.itemsRaw.length} itens`);
    
    const orderData = generateOrderFromParsedData(parsedData);
    await sendOrderToBackend(originalPath, orderData);
    showNotification('Pedido Real Capturado!', `📋 ${orderData.mesa} • ${parsedData.garcom} • ${orderData.itens.length} componentes`);
    
    try { if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath); } catch(e) {}
    
  } catch(error) {
    log('ERROR', `Falha no pipeline: ${error.message}`);
    showNotification('Erro ao processar pedido', error.message, 'error');
  }
}

// ============================================================================
// ENVIO PARA BACKEND
// ============================================================================
async function sendOrderToBackend(filePath, mockData) {
  const url = `${CONFIG.BACKEND_URL.replace(/\/$/, '')}/api/orders`;
  const payload = {
    sourceFile: path.basename(filePath),
    mockData,
    bridgeId: BRIDGE_ID,
    timestamp: moment().toISOString(),
    parserVersion: '2.1'
  };
  
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'KitchenFlowBridge/2.1' };
  if (CONFIG.API_KEY) headers['X-API-Key'] = CONFIG.API_KEY;

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), timeout: 10000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

// ============================================================================
// NOTIFICAÇÕES
// ============================================================================
function showNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: path.join(__dirname, 'icon.png'), silent: false }).show();
    }
  } catch(e) {}
  if (tray) tray.setToolTip(`Kitchen Flow: ${title}`);
}

// ============================================================================
// CRIAÇÃO DA JANELA (CORRIGIDA: ÚNICA INSTÂNCIA + OCULTA)
// ============================================================================
function createWindow() {
  // ← GARANTE APENAS 1 JANELA
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  
  mainWindow = new BrowserWindow({
    width: 420,
    height: 340,
    show: false, // ← COMEÇA OCULTA (vai direto para bandeja)
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
    resizable: false,
    autoHideMenuBar: true // ← Esconde barra de menu
  });
  
  mainWindow.loadFile('index.html');
  
  // ← SÓ MOSTRA SE RODADO COM --dev (para debug)
  if (process.argv.includes('--dev')) {
    mainWindow.show();
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

// ============================================================================
// CRIAÇÃO DA BANDEJA (TRAY)
// ============================================================================
function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let icon = fs.existsSync(iconPath) 
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) 
    : nativeImage.createEmpty();
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '👁️ Mostrar Painel',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    { label: `📁 Monitora: ${CONFIG.DOWNLOAD_PATH}`, enabled: false },
    { label: `💾 Backup: ${BACKUP_DIR}`, enabled: false },
    { label: `🌐 Backend: ${new URL(CONFIG.BACKEND_URL).hostname}`, enabled: false },
    { type: 'separator' },
    {
      label: '🚪 Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
  tray.setToolTip('Kitchen Flow Bridge');
  
  // Clique no tray alterna mostrar/esconder
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// ============================================================================
// INICIAR WATCHER
// ============================================================================
function startWatcher() {
  if (!fs.existsSync(CONFIG.DOWNLOAD_PATH)) {
    log('ERROR', `Pasta não existe: ${CONFIG.DOWNLOAD_PATH}. Criando para testes...`);
    fs.mkdirSync(CONFIG.DOWNLOAD_PATH, { recursive: true });
  }
  watcher = new Watcher(CONFIG.DOWNLOAD_PATH, { onNewFile: handleNewFile });
  log('INFO', `✅ V2.1 Ativo | Monitorando: ${CONFIG.DOWNLOAD_PATH}`);
}

// ============================================================================
// IPC HANDLERS
// ============================================================================
ipcMain.handle('get-config', () => ({ 
  ...CONFIG, 
  bridgeId: BRIDGE_ID,
  menuLoaded: Object.keys(menuMap.pratos || {}).length > 0
}));

ipcMain.handle('get-status', () => ({
  watching: watcher?.isActive || false,
  backend: CONFIG.BACKEND_URL,
  uptime: process.uptime(),
  bridgeId: BRIDGE_ID,
  backupDir: BACKUP_DIR,
  memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
}));

ipcMain.handle('trigger-test', () => watcher?.triggerTest?.());

// ============================================================================
// INICIALIZAÇÃO DO APP
// ============================================================================
app.whenReady().then(() => {
  // Evitar múltiplas instâncias do app
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.log('⚠️ Outra instância já está rodando. Encerrando.');
    app.quit();
    return;
  }
  
  app.on('second-instance', () => {
    // Se tentar abrir outra instância, foca na janela existente
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  
  log('INFO', ' Kitchen Flow Bridge V2.1 iniciando...');
  createTray();
  createWindow();
  startWatcher();
  showNotification('Kitchen Flow V2.1', 'Parser Real Ativo • Pronto para pedidos');
});

// ============================================================================
// LIFECYCLE
// ============================================================================
app.on('window-all-closed', () => {
  // Manter app rodando no tray (Windows/Linux)
  if (process.platform !== 'darwin') {
    // Não fecha
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (watcher) watcher.stop();
  log('INFO', '🛑 Encerrando Kitchen Flow Bridge...');
});

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = { 
  CONFIG, 
  BRIDGE_ID, 
  handleNewFile,
  parseSaiposFile,
  generateOrderFromParsedData
};