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
// CARREGAR DICIONÁRIO DO CARDÁPIO (menu-map.json)
// ============================================================================
const MENU_MAP_PATH = path.join(__dirname, 'menu-map.json');
let menuMap = { 
  pratos: {}, 
  acompanhamentos_avulsos: {}, 
  acompanhamentos_fixos_por_categoria: {},
  setores: {}
};

function loadMenuMap() {
  try {
    if (fs.existsSync(MENU_MAP_PATH)) {
      menuMap = JSON.parse(fs.readFileSync(MENU_MAP_PATH, 'utf8'));
      const totalPratos = Object.keys(menuMap.pratos || {}).length;
      console.log(`📖 Cardápio carregado: ${totalPratos} pratos mapeados`);
      return true;
    } else {
      console.warn('⚠️ menu-map.json não encontrado em:', MENU_MAP_PATH);
      return false;
    }
  } catch(e) {
    console.error('❌ Erro ao carregar menu-map.json:', e.message);
    return false;
  }
}

// Carregar ao iniciar
const menuLoaded = loadMenuMap();

// ============================================================================
// VARIÁVEIS GLOBAIS
// ============================================================================
let mainWindow, tray, watcher;
let isQuitting = false;
const BRIDGE_ID = uuidv4().slice(0, 8);

// ============================================================================
// LOGGER
// ============================================================================
function log(level, msg, data = null) {
  const entry = `[${moment().format('HH:mm:ss')}] [${level}] ${msg}`;
  console.log(entry);
  if (data) console.log('  →', JSON.stringify(data));
}

// ============================================================================
// VALIDAR PASTA DE DOWNLOADS
// ============================================================================
function ensureWatchPath() {
  if (!fs.existsSync(CONFIG.DOWNLOAD_PATH)) {
    log('WARN', `Pasta não existe: ${CONFIG.DOWNLOAD_PATH}`);
    return false;
  }
  return true;
}

// ============================================================================
// GERADOR DE PEDIDOS COM CARDÁPIO REAL (V1.5)
// ============================================================================
function generateMockOrder(filePath) {
  const pratosChaves = Object.keys(menuMap.pratos || {});
  
  // Fallback se não houver cardápio carregado
  if (pratosChaves.length === 0) {
    log('WARN', 'Usando fallback aleatório (cardápio não carregado)');
    return generateRandomFallback();
  }

  // Escolhe um prato aleatório do cardápio real (simulando leitura do arquivo)
  const pratoChave = pratosChaves[Math.floor(Math.random() * pratosChaves.length)];
  const prato = menuMap.pratos[pratoChave];
  
  if (!prato || !prato.composicao) {
    log('ERROR', `Prato "${pratoChave}" sem composição válida`);
    return generateRandomFallback();
  }
  
  // Monta a composição base do prato
  let itens = [...prato.composicao];
  
  // Adiciona acompanhamentos fixos por categoria (ex: pão para pratos "compartilhar")
  const categoria = prato.categoria;
  if (categoria && menuMap.acompanhamentos_fixos_por_categoria?.[categoria]) {
    itens = [...itens, ...menuMap.acompanhamentos_fixos_por_categoria[categoria]];
  }

  // Define se é delivery ou salão (20% de chance de delivery)
  const isDelivery = Math.random() < 0.2;
  
  return {
    mesa: isDelivery 
      ? `Delivery #${Math.floor(Math.random() * 500) + 1}` 
      : `Mesa ${Math.floor(Math.random() * 20) + 1}`,
    tipo: isDelivery ? 'delivery' : 'salao',
    pratoOriginal: prato.nome_tablet, // Para debug/futuro parser
    categoria: categoria,
    itens: itens.map(i => ({
      uuid: uuidv4(),
      setor: i.setor || 'Fogão',
      item: i.item || 'Item',
      quantidade: parseInt(i.quantidade) || 1
    }))
  };
}

// Fallback antigo (mantido por segurança)
function generateRandomFallback() {
  const items = [
    { setor: 'Fritadeira', item: 'Batata frita', quantidade: 2 },
    { setor: 'Fogão', item: 'Picanha', quantidade: 1 },
    { setor: 'Saladas', item: 'Salada verde', quantidade: 1 }
  ];
  
  const isDelivery = Math.random() < 0.2;
  const numItems = Math.floor(Math.random() * 3) + 2;
  const shuffled = items.sort(() => 0.5 - Math.random());
  
  return {
    mesa: isDelivery ? `Delivery #${Math.floor(Math.random()*500)+1}` : `Mesa ${Math.floor(Math.random()*20)+1}`,
    tipo: isDelivery ? 'delivery' : 'salao',
    pratoOriginal: 'Pedido Aleatório',
    itens: shuffled.slice(0, numItems).map(i => ({
      uuid: uuidv4(),
      ...i
    }))
  };
}

// ============================================================================
// ENVIO DE PEDIDO PARA BACKEND
// ============================================================================
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

// ============================================================================
// MOVER ARQUIVO PROCESSADO
// ============================================================================
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

// ============================================================================
// HANDLER: NOVO ARQUIVO DETECTADO
// ============================================================================
async function handleNewFile(filePath) {
  if (!filePath.toLowerCase().endsWith('.saiposnfeprt')) return;
  
  log('INFO', `Novo arquivo: ${path.basename(filePath)}`);
  
  // Notificar janela (se aberta)
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('file-detected', {
      fileName: path.basename(filePath),
      time: moment().format('HH:mm:ss')
    });
  }
  
  try {
    // Gerar pedido com cardápio real
    const mockData = generateMockOrder(filePath);
    
    // Enviar para backend
    await sendOrderToBackend(filePath, mockData);
    
    // Mover arquivo original
    moveProcessedFile(filePath);
    
    // Notificação visual
    showNotification(
      'Pedido processado!', 
      `📋 ${mockData.mesa} • ${mockData.pratoOriginal || mockData.itens.length} itens`
    );
    
  } catch(error) {
    log('ERROR', `Erro ao processar arquivo: ${error.message}`);
    showNotification('Erro ao processar', error.message, 'error');
  }
}

// ============================================================================
// NOTIFICAÇÕES DO SISTEMA
// ============================================================================
function showNotification(title, body, type = 'info') {
  try {
    if (Notification.isSupported()) {
      new Notification({ 
        title, 
        body, 
        icon: path.join(__dirname, 'icon.png'),
        silent: false
      }).show();
    }
  } catch(e) {
    log('WARN', `Notificação falhou: ${e.message}`);
  }
  
  // Atualizar tooltip do tray
  if (tray) {
    tray.setToolTip(`Kitchen Flow: ${title}`);
    setTimeout(() => tray.setToolTip('Kitchen Flow Bridge'), 3000);
  }
}

// ============================================================================
// CRIAR JANELA PRINCIPAL
// ============================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 320,
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
    resizable: false,
    alwaysOnTop: false
  });
  
  mainWindow.loadFile('index.html');
  
  // Esconder ao minimizar (vai para tray)
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
  
  // Fechar vai para tray, não encerra o app
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

// ============================================================================
// CRIAR ÍCONE NA BANDEJA (TRAY)
// ============================================================================
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
      label: '👁️ Mostrar Painel',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: 'separator' },
    {
      label: `📁 Pasta: ${CONFIG.DOWNLOAD_PATH}`,
      enabled: false
    },
    {
      label: `🌐 Backend: ${new URL(CONFIG.BACKEND_URL).hostname}`,
      enabled: false
    },
    {
      label: `🆔 Bridge: ${BRIDGE_ID}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: menuLoaded ? '✅ Cardápio: Carregado' : '⚠️ Cardápio: Não encontrado',
      enabled: false
    },
    {
      label: CONFIG.API_KEY ? '🔐 API Key: Ativada' : '🔓 API Key: Desativada',
      enabled: false
    },
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
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

// ============================================================================
// INICIAR WATCHER DE ARQUIVOS
// ============================================================================
function startWatcher() {
  if (!ensureWatchPath()) {
    log('ERROR', 'Não foi possível iniciar monitoramento');
    showNotification('Erro de configuração', `Pasta não encontrada: ${CONFIG.DOWNLOAD_PATH}`, 'error');
    return;
  }
  
  watcher = new Watcher(CONFIG.DOWNLOAD_PATH, { onNewFile: handleNewFile });
  log('INFO', `✅ Monitorando: ${CONFIG.DOWNLOAD_PATH}`);
}

// ============================================================================
// IPC HANDLERS (COMUNICAÇÃO COM JANELA)
// ============================================================================
ipcMain.handle('get-config', () => ({ 
  ...CONFIG, 
  bridgeId: BRIDGE_ID,
  menuLoaded 
}));

ipcMain.handle('get-status', () => ({
  watching: watcher?.isActive || false,
  backend: CONFIG.BACKEND_URL,
  uptime: process.uptime(),
  bridgeId: BRIDGE_ID,
  menuLoaded,
  memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
}));

ipcMain.handle('trigger-test', () => watcher?.triggerTest?.());

ipcMain.handle('reload-menu', () => {
  const success = loadMenuMap();
  return { success, loaded: Object.keys(menuMap.pratos || {}).length };
});

// ============================================================================
// INICIALIZAÇÃO DO APP
// ============================================================================
app.whenReady().then(async () => {
  log('INFO', '🚀 Kitchen Flow Bridge iniciando...');
  log('INFO', `Backend: ${CONFIG.BACKEND_URL}`);
  log('INFO', `Bridge ID: ${BRIDGE_ID}`);
  log('INFO', `Cardápio: ${menuLoaded ? 'Carregado' : 'Não encontrado'}`);
  
  createTray();
  createWindow();
  startWatcher();
  
  showNotification('Kitchen Flow Bridge', 'Monitoramento ativo • Pronto para pedidos');
});

// ============================================================================
// LIFECYCLE EVENTS
// ============================================================================
app.on('window-all-closed', () => {
  // Manter app rodando no tray (Windows/Linux)
  if (process.platform !== 'darwin') {
    // Não fecha
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  watcher?.stop();
  log('INFO', '🛑 Encerrando Kitchen Flow Bridge...');
});

// ============================================================================
// EXPORTS PARA TESTES
// ============================================================================
module.exports = { 
  CONFIG, 
  BRIDGE_ID, 
  handleNewFile,
  generateMockOrder,
  menuMap
};