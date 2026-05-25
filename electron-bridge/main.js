const LicenseManager = require('./license-manager');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const Watcher = require('./watcher');
const http = require('http');
const dotenv = require('dotenv');

// ============================================================================
// CARREGAR .env CORRETAMENTE (Com fallback para dev e produção)
// ============================================================================
function loadEnvConfig() {
  const possiblePaths = [
    path.join(process.resourcesPath, '.env'),
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(app.getAppPath(), '.env')
  ];
  
  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      console.log(`📄 Carregando .env de: ${envPath}`);
      dotenv.config({ path: envPath });
      return true;
    }
  }
  console.log('⚠️ Nenhum .env encontrado, usando variáveis de ambiente ou defaults');
  return false;
}

loadEnvConfig();

// ============================================================================
// METADADOS DO APP
// ============================================================================
const APP_META = {
  name: 'Kitchen Flow Bridge',
  version: '2.1.2',
  author: 'CLB Studio - by Celso Luiz',
  description: 'Bridge para monitorar downloads do Saipos'
};

// ============================================================================
// CONFIGURAÇÕES (Com fallback seguro)
// ============================================================================
const CONFIG = {
  DOWNLOAD_PATH: process.env.KFM_DOWNLOAD_PATH || 'C:\\Users\\Na Fazenda\\Downloads',
  BACKEND_URL: process.env.KFM_BACKEND_URL || 'http://localhost:4545',
  API_KEY: process.env.KFM_API_KEY || '',
  AUTO_START: process.env.KFM_AUTO_START !== 'false'
};

// ============================================================================
// CARREGAR DICIONÁRIO DO CARDÁPIO (COM SUPORTE A MENU EXTERNO)
// ============================================================================
const MENU_MAP_BUNDLED = path.join(__dirname, 'menu-map.json');
const MENU_MAP_EXTERNAL = path.join(app.getPath('userData'), 'menu-map.json');

let menuMap = { pratos: {}, acompanhamentos_avulsos: {}, acompanhamentos_fixos_por_categoria: {} };
let menuSource = 'bundled';

function loadMenuMap() {
  if (fs.existsSync(MENU_MAP_EXTERNAL)) {
    try {
      const external = JSON.parse(fs.readFileSync(MENU_MAP_EXTERNAL, 'utf8'));
      console.log(`📖 Cardápio carregado (EXTERNO): ${Object.keys(external.pratos || {}).length} pratos`);
      menuMap = external;
      menuSource = 'external';
      return true;
    } catch(e) {
      console.error('❌ Erro ao carregar menu externo:', e.message);
    }
  }
  
  if (fs.existsSync(MENU_MAP_BUNDLED)) {
    try {
      const bundled = JSON.parse(fs.readFileSync(MENU_MAP_BUNDLED, 'utf8'));
      console.log(`📖 Cardápio carregado (EMBATIDO): ${Object.keys(bundled.pratos || {}).length} pratos`);
      menuMap = bundled;
      menuSource = 'bundled';
      return true;
    } catch(e) {
      console.error('❌ Erro ao carregar menu embutido:', e.message);
    }
  }
  
  console.warn('⚠️ Nenhum cardápio encontrado. Usando estrutura vazia.');
  return false;
}

function reloadMenuMap() {
  const success = loadMenuMap();
  log('INFO', `🔄 Cardápio recarregado: ${menuSource} | ${Object.keys(menuMap.pratos || {}).length} pratos`);
  return { success, source: menuSource, count: Object.keys(menuMap.pratos || {}).length };
}

loadMenuMap();

// ============================================================================
// VARIÁVEIS GLOBAIS
// ============================================================================
let mainWindow = null;
let tray = null;
let watcher = null;
let httpServer = null;
let isQuitting = false;
const BRIDGE_ID = uuidv4().slice(0, 8);
const BACKUP_DIR = path.join(process.env.USERPROFILE || 'C:\\', 'KitchenFlow', 'backup');

// ============================================================================
// SISTEMA DE HISTÓRICO DE DOWNLOADS
// ============================================================================
let downloadHistory = [];
const MAX_HISTORY_ITEMS = 100;

function addToHistory(filename, status, filePath, message = '') {
  const entry = {
    id: Date.now() + Math.random().toString(36).substr(2, 5),
    filename,
    status,
    filePath,
    message,
    timestamp: new Date().toISOString(),
    bridgeId: BRIDGE_ID
  };
  
  downloadHistory.unshift(entry);
  
  if (downloadHistory.length > MAX_HISTORY_ITEMS) {
    downloadHistory = downloadHistory.slice(0, MAX_HISTORY_ITEMS);
  }
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history-updated', downloadHistory);
  }
  
  console.log(`📋 Histórico: ${status.toUpperCase()} - ${filename}`);
}

function clearHistory() {
  downloadHistory = [];
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history-updated', downloadHistory);
  }
  log('INFO', '🧹 Histórico limpo');
}

function getHistory() {
  return downloadHistory;
}

// ============================================================================
// FUNÇÕES DE UTILIDADE
// ============================================================================
function log(level, msg, data = null) {
  const entry = `[${moment().format('HH:mm:ss')}] [${level}] ${msg}`;
  console.log(entry);
  if (data) console.log('  →', JSON.stringify(data));
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      console.log(`📁 Pasta de backup criada: ${BACKUP_DIR}`);
    } catch (e) {
      console.error('❌ Falha ao criar pasta de backup:', e.message);
    }
  }
}

// Limpeza automática de backups antigos (roda a cada hora)
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
// PARSER SAIPos V2.1
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
      row.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
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
// GERADOR DE PEDIDO
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
// HANDLER PRINCIPAL (COM TRATAMENTO DE ERRO ENOENT E RETRY)
// ============================================================================
async function handleNewFile(originalPath, source = 'watcher') {
  const fileName = path.basename(originalPath);
  log('INFO', `📄 Detectado (${source}): ${fileName}`);
  
  ensureBackupDir();
  const backupPath = path.join(BACKUP_DIR, `${moment().format('YYYYMMDD_HHmmss')}_${fileName}`);
  
  try {
    // ← CORREÇÃO #4: Verificar se arquivo existe ANTES de processar
    if (!fs.existsSync(originalPath)) {
      const errorMsg = 'Arquivo não encontrado - possível bloqueio por antivírus ou deletado pelo Saipos';
      console.warn(`⚠️ ${errorMsg}: ${originalPath}`);
      addToHistory(fileName, 'error', originalPath, errorMsg);
      showNotification('Arquivo não processado', 'Antivírus pode ter bloqueado o arquivo', 'warning');
      return;
    }
    
    // ← CORREÇÃO #4: Retry logic para copiar arquivo (antivírus pode travar acesso)
    let copySuccess = false;
    let copyError = null;
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        fs.copyFileSync(originalPath, backupPath);
        copySuccess = true;
        log('INFO', `📦 Backup criado: ${backupPath} (tentativa ${attempt})`);
        break;
      } catch (err) {
        copyError = err;
        console.warn(`⚠️ Tentativa ${attempt}/${maxRetries} falhou ao copiar: ${err.message}`);
        
        if (attempt < maxRetries) {
          // Aguardar antes de retry
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
    
    if (!copySuccess) {
      const errorMsg = `Falha ao criar backup após ${maxRetries} tentativas: ${copyError?.message || 'Erro desconhecido'}`;
      log('ERROR', errorMsg);
      addToHistory(fileName, 'error', originalPath, errorMsg);
      showNotification('Erro ao processar pedido', 'Falha ao salvar backup', 'error');
      return;
    }
    
    // Parsear arquivo de backup (não o original)
    const parsedData = parseSaiposFile(backupPath);
    if (!parsedData) {
      log('ERROR', 'Falha ao extrair dados do pedido');
      addToHistory(fileName, 'error', originalPath, 'Falha ao parsear conteúdo');
      return;
    }
    
    log('INFO', `✅ Pedido extraído: ${parsedData.mesa} | Garçom: ${parsedData.garcom} | ${parsedData.itemsRaw.length} itens`);
    
    // Gerar ordem
    const orderData = generateOrderFromParsedData(parsedData);
    await sendOrderToBackend(backupPath, orderData);
    
    // Notificar sucesso
    showNotification('Pedido Capturado!', `📋 ${orderData.mesa} • ${parsedData.garcom} • ${orderData.itens.length} componentes`);
    addToHistory(fileName, 'success', originalPath, `${orderData.mesa} • ${orderData.itens.length} itens`);
    
    // Remover original APÓS processamento bem-sucedido (apenas se veio do watcher)
    if (source === 'watcher' && fs.existsSync(originalPath)) {
      try {
        fs.unlinkSync(originalPath);
        log('INFO', `🗑️ Arquivo original removido: ${fileName}`);
      } catch (delErr) {
        log('WARN', `Não foi possível remover original: ${delErr.message}`);
        // Não falhar o processo se não conseguir deletar
      }
    }
    
  } catch (error) {
    // ← CORREÇÃO #4: Log detalhado para diagnóstico de antivírus
    const errorCode = error.code || 'UNKNOWN';
    const isAntivirusRelated = ['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(errorCode);
    
    log('ERROR', `Falha no pipeline: ${error.message} (código: ${errorCode})`);
    
    if (isAntivirusRelated) {
      console.error('🛡️ Possível interferência de antivírus detectada!');
      console.error('💡 Sugestão: Adicionar exclusão para pasta de downloads e extensão .saiposprt');
    }
    
    addToHistory(fileName, 'error', originalPath, `${error.message} [${errorCode}]`);
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
    parserVersion: '2.1.2'
  };
  
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'KitchenFlowBridge/2.1.2' };
  if (CONFIG.API_KEY) headers['X-API-Key'] = CONFIG.API_KEY;

  try {
    const response = await fetch(url, { 
      method: 'POST', 
      headers, 
      body: JSON.stringify(payload),
      timeout: 10000
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    return response.json();
  } catch (err) {
    console.error('❌ Falha ao enviar para backend:', err.message);
    throw err;
  }
}

// ============================================================================
// NOTIFICAÇÕES
// ============================================================================
function showNotification(title, body, urgency = 'info') {
  try {
    if (Notification.isSupported()) {
      new Notification({ 
        title, 
        body, 
        icon: path.join(__dirname, 'icon.png'), 
        silent: urgency === 'error',
        urgency: urgency
      }).show();
    }
  } catch(e) {
    console.log('⚠️ Notificação não exibida:', e.message);
  }
  if (tray) tray.setToolTip(`Kitchen Flow: ${title}`);
}

// ============================================================================
// CRIAÇÃO DA JANELA
// ============================================================================
function createWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  
  mainWindow = new BrowserWindow({
    width: 420,
    height: 340,
    show: false,
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
    autoHideMenuBar: true
  });
  
  mainWindow.loadFile('index.html');
  
  if (process.argv.includes('--dev') || process.env.NODE_ENV === 'development') {
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
  
  mainWindow.on('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config-loaded', {
        downloadPath: CONFIG.DOWNLOAD_PATH,
        backendUrl: CONFIG.BACKEND_URL,
        version: APP_META.version
      });
    }
  });
}

// ============================================================================
// CRIAÇÃO DA JANELA DE BLOQUEIO (Licença Expirada)
// ============================================================================
function createBlockWindow() {
  const blockWin = new BrowserWindow({
    width: 500,
    height: 600,
    title: 'Kitchen Flow - Ativação Necessária',
    resizable: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  blockWin.loadFile('block.html');
  blockWin.on('closed', () => {
    if (!isQuitting) app.quit();
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
    {
      label: '🔄 Recarregar Cardápio',
      click: async () => {
        const result = reloadMenuMap();
        showNotification(
          result.success ? '✅ Cardápio Atualizado' : '❌ Falha ao Atualizar',
          `${result.count} pratos carregados (${result.source})`
        );
      }
    },
    {
      label: '📁 Alterar Pasta de Monitoramento...',
      click: async () => {
        const result = await dialog.showOpenDialog(mainWindow || undefined, {
          properties: ['openDirectory'],
          title: 'Selecione a pasta para monitorar downloads',
          defaultPath: CONFIG.DOWNLOAD_PATH
        });
        
        if (!result.canceled && result.filePaths[0]) {
          const newPath = result.filePaths[0];
          await updateDownloadPath(newPath);
          showNotification('Pasta atualizada', `Monitorando: ${newPath}`);
        }
      }
    },
    {
      label: '🛡️ Configurar Antivírus...',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Configurar Antivírus',
          message: 'Para evitar bloqueios, adicione estas exclusões no seu antivírus:',
          detail: `1. Pasta: ${CONFIG.DOWNLOAD_PATH}\n2. Extensão: .saiposprt\n3. Processo: Kitchen Flow Bridge`,
          buttons: ['OK', 'Copiar Instruções']
        }).then(result => {
          if (result.response === 1) {
            const text = `Exclusões para Kitchen Flow Bridge:\n- Pasta: ${CONFIG.DOWNLOAD_PATH}\n- Extensão: .saiposprt\n- Processo: Kitchen Flow Bridge`;
            require('electron').clipboard.writeText(text);
            showNotification('Instruções copiadas', 'Cole nas configurações do seu antivírus');
          }
        });
      }
    },
    { type: 'separator' },
    { label: `📁 Monitora: ${path.basename(CONFIG.DOWNLOAD_PATH)}`, enabled: false },
    { label: `💾 Backup: ${path.basename(BACKUP_DIR)}`, enabled: false },
    { label: `🌐 Backend: ${new URL(CONFIG.BACKEND_URL).hostname}`, enabled: false },
    { label: `📖 Cardápio: ${menuSource === 'external' ? 'Externo' : 'Embutido'}`, enabled: false },
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
  tray.setToolTip('Kitchen Flow Bridge - Pronto');
  
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
// ATUALIZAR CAMINHO DE DOWNLOAD (COM PERSISTÊNCIA)
// ============================================================================
async function updateDownloadPath(newPath) {
  if (!fs.existsSync(newPath)) {
    try {
      fs.mkdirSync(newPath, { recursive: true });
      log('INFO', `📁 Pasta criada: ${newPath}`);
    } catch (e) {
      log('ERROR', `Falha ao criar pasta: ${e.message}`);
      return { success: false, error: e.message };
    }
  }
  
  CONFIG.DOWNLOAD_PATH = newPath;
  process.env.KFM_DOWNLOAD_PATH = newPath;
  
  const possibleEnvPaths = [
    path.join(process.resourcesPath, '.env'),
    path.join(__dirname, '.env'),
    path.join(app.getAppPath(), '.env')
  ];
  
  const envContent = `KFM_BACKEND_URL=${CONFIG.BACKEND_URL}\nKFM_DOWNLOAD_PATH=${newPath}\n`;
  
  for (const envPath of possibleEnvPaths) {
    try {
      if (fs.existsSync(path.dirname(envPath))) {
        fs.writeFileSync(envPath, envContent, 'utf8');
        log('INFO', `📝 .env atualizado em: ${envPath}`);
        break;
      }
    } catch (e) {
      log('WARN', `Não foi possível escrever em ${envPath}: ${e.message}`);
    }
  }
  
  if (watcher) watcher.stop();
  startWatcher();
  createTray();
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', { downloadPath: newPath });
  }
  
  log('INFO', `📁 Pasta de download atualizada: ${newPath}`);
  return { success: true, path: newPath };
}

// ============================================================================
// INICIAR WATCHER
// ============================================================================
function startWatcher() {
  if (!fs.existsSync(CONFIG.DOWNLOAD_PATH)) {
    log('WARN', `Pasta não existe: ${CONFIG.DOWNLOAD_PATH}. Criando...`);
    try {
      fs.mkdirSync(CONFIG.DOWNLOAD_PATH, { recursive: true });
    } catch (e) {
      log('ERROR', `Falha ao criar pasta: ${e.message}`);
    }
  }
  watcher = new Watcher(CONFIG.DOWNLOAD_PATH, { onNewFile: handleNewFile });
  log('INFO', `✅ V2.1.2 Ativo | Monitorando: ${CONFIG.DOWNLOAD_PATH}`);
}

// ============================================================================
// SERVIDOR HTTP PARA EXTENSÃO DO NAVEGADOR
// ============================================================================
function startHttpServer() {
  httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.url === '/api/download' && req.method === 'POST') {
      let body = '';
      
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { filename, filePath, timestamp } = data;
          
          log('INFO', `📥 Extensão capturou: ${filename}`);
          
          if (filePath && fs.existsSync(filePath)) {
            await handleNewFile(filePath, 'extension');
            addToHistory(filename, 'extension', filePath, 'Capturado pela extensão');
          } else {
            log('WARN', `Arquivo não encontrado: ${filePath}`);
            addToHistory(filename || 'unknown', 'error', filePath || '', 'Arquivo não encontrado');
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Processado' }));
          
        } catch (e) {
          log('ERROR', `Erro ao processar da extensão: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      
    } else if (req.url === '/api/history' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, history: getHistory().slice(0, 50) }));
      
    } else if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        bridgeId: BRIDGE_ID,
        watching: watcher?.isActive || false,
        downloadPath: CONFIG.DOWNLOAD_PATH,
        timestamp: new Date().toISOString()
      }));
      
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Kitchen Flow Bridge API - Endpoint not found');
    }
  });
  
  httpServer.listen(4545, 'localhost', () => {
    log('INFO', `🌐 API HTTP rodando em http://localhost:4545`);
  });
  
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WARN', '⚠️ Porta 4545 já em uso. Tentando 4546...');
      httpServer.listen(4546, 'localhost', () => {
        log('INFO', `🌐 API HTTP rodando em http://localhost:4546`);
        CONFIG.BACKEND_URL = CONFIG.BACKEND_URL.replace('4545', '4546');
      });
    } else {
      log('ERROR', `Erro no servidor HTTP: ${err.message}`);
    }
  });
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.handle('get-config', () => ({ 
  ...CONFIG, 
  bridgeId: BRIDGE_ID,
  menuLoaded: Object.keys(menuMap.pratos || {}).length > 0,
  version: APP_META.version
}));

ipcMain.handle('get-status', () => ({
  watching: watcher?.isActive || false,
  backend: CONFIG.BACKEND_URL,
  uptime: process.uptime(),
  bridgeId: BRIDGE_ID,
  backupDir: BACKUP_DIR,
  memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  httpPort: httpServer?.address()?.port || 4545
}));

ipcMain.handle('trigger-test', () => watcher?.triggerTest?.());
ipcMain.handle('reload-menu', () => reloadMenuMap());

ipcMain.handle('get-menu-info', () => ({
  source: menuSource,
  path: menuSource === 'external' ? MENU_MAP_EXTERNAL : MENU_MAP_BUNDLED,
  pratos: Object.keys(menuMap.pratos || {}).length,
  lastLoaded: new Date().toISOString()
}));

ipcMain.handle('get-history', () => getHistory());

ipcMain.handle('clear-history', () => {
  clearHistory();
  return { success: true };
});

ipcMain.handle('set-download-path', async (event, newPath) => {
  return await updateDownloadPath(newPath);
});

// ← NOVO: Endpoint para diagnóstico de antivírus
ipcMain.handle('check-antivirus-exclusions', async () => {
  const downloadPath = CONFIG.DOWNLOAD_PATH;
  
  try {
    // Testar escrita na pasta
    const testFile = path.join(downloadPath, `.kfm_test_${Date.now()}.tmp`);
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    
    return {
      canWrite: true,
      path: downloadPath,
      message: 'Acesso à pasta OK'
    };
  } catch (e) {
    return {
      canWrite: false,
      path: downloadPath,
      error: e.message,
      code: e.code,
      message: 'Possível bloqueio por antivírus'
    };
  }
});

ipcMain.handle('get-lic-status', () => LicenseManager.checkStatus());
ipcMain.handle('activate-license', (event, key) => LicenseManager.activate(key));
ipcMain.on('restart-app', () => { app.relaunch(); app.exit(0); });

// ============================================================================
// INICIALIZAÇÃO DO APP
// ============================================================================
app.whenReady().then(() => {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.log('⚠️ Outra instância já está rodando. Encerrando.');
    app.quit();
    return;
  }
  
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  
  const licStatus = LicenseManager.checkStatus();
  console.log(`🔐 Status da Licença: ${licStatus.type} | ID: ${licStatus.machineId}`);
  
  if (!licStatus.valid) {
    log('ERROR', '🚫 Sistema Bloqueado: Período de teste expirado');
    showNotification('Sistema Bloqueado', 'Período de teste expirado. Ative para continuar.', 'error');
    createBlockWindow();
    return;
  }
  
  if (licStatus.type === 'trial') {
    log('INFO', `🧪 Modo Teste: ${licStatus.daysLeft} dias restantes`);
    showNotification(`Teste: ${licStatus.daysLeft} dias restantes`, 'Entre em contato para ativar.', 'info');
  }
  
  log('INFO', '🚀 Kitchen Flow Bridge V2.1.2 iniciando...');
  
  createTray();
  createWindow();
  startWatcher();
  startHttpServer();
  
  showNotification('Kitchen Flow V2.1.2', 'Parser Real + Extensão + Antivírus Fix • Pronto');
});

// ============================================================================
// LIFECYCLE
// ============================================================================
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  if (watcher) watcher.stop();
  if (httpServer) {
    httpServer.close(() => log('INFO', '🔌 Servidor HTTP fechado'));
  }
  log('INFO', '🛑 Encerrando Kitchen Flow Bridge...');
});

process.on('SIGINT', () => {
  log('INFO', '🛑 Recebido SIGINT, encerrando...');
  app.quit();
});

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = { 
  CONFIG, 
  BRIDGE_ID, 
  handleNewFile,
  parseSaiposFile,
  generateOrderFromParsedData,
  getHistory,
  updateDownloadPath
};