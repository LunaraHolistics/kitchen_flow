const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const Watcher = require('./watcher');
const WebSocketServer = require('./server');

// Configurações globais
const CONFIG = {
  DOWNLOAD_PATH: 'C:\\downloads',
  PROCESSED_PATH: path.join(__dirname, 'processed'),
  STORAGE_PATH: path.join(__dirname, 'storage'),
  ORDERS_FILE: path.join(__dirname, 'storage', 'orders.json'),
  LOGS_FILE: path.join(__dirname, 'storage', 'logs.json'),
  WS_PORT: 4545,
  WINDOW_WIDTH: 1200,
  WINDOW_HEIGHT: 800
};

// Garantir que pastas existam
function ensureDirectories() {
  [CONFIG.PROCESSED_PATH, CONFIG.STORAGE_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logEvent('SYSTEM', `Pasta criada: ${dir}`);
    }
  });
  
  // Garantir arquivos de storage
  if (!fs.existsSync(CONFIG.ORDERS_FILE)) {
    fs.writeFileSync(CONFIG.ORDERS_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(CONFIG.LOGS_FILE)) {
    fs.writeFileSync(CONFIG.LOGS_FILE, JSON.stringify([], null, 2));
  }
}

// Logger centralizado
function logEvent(type, message, data = null) {
  const logEntry = {
    timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
    type,
    message,
    data
  };
  
  try {
    const logs = JSON.parse(fs.readFileSync(CONFIG.LOGS_FILE, 'utf8'));
    logs.push(logEntry);
    // Manter apenas últimos 1000 logs
    if (logs.length > 1000) logs.shift();
    fs.writeFileSync(CONFIG.LOGS_FILE, JSON.stringify(logs, null, 2));
    console.log(`[${logEntry.timestamp}] ${type}: ${message}`);
  } catch (err) {
    console.error('Erro ao escrever log:', err);
  }
  
  return logEntry;
}

// Carregar pedidos do storage
function loadOrders() {
  try {
    if (fs.existsSync(CONFIG.ORDERS_FILE)) {
      const data = fs.readFileSync(CONFIG.ORDERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    logEvent('ERROR', 'Erro ao carregar orders.json', err.message);
  }
  return [];
}

// Salvar pedidos no storage
function saveOrders(orders) {
  try {
    fs.writeFileSync(CONFIG.ORDERS_FILE, JSON.stringify(orders, null, 2));
    return true;
  } catch (err) {
    logEvent('ERROR', 'Erro ao salvar orders.json', err.message);
    return false;
  }
}

// Gerar pedido mockado (V1 - sem parser real do .saiposnfeprt)
function generateMockOrder(filePath) {
  const sectors = ['Frios', 'Saladas', 'Fritadeira', 'Entradas', 'Fogão', 'Sobremesas'];
  const salonItems = [
    { setor: 'Fritadeira', item: 'Batata frita', quantidade: Math.floor(Math.random() * 3) + 1 },
    { setor: 'Fritadeira', item: 'Anel de cebola', quantidade: Math.floor(Math.random() * 2) + 1 },
    { setor: 'Fogão', item: 'Picanha', quantidade: 1 },
    { setor: 'Fogão', item: 'Frango grelhado', quantidade: Math.floor(Math.random() * 2) + 1 },
    { setor: 'Fogão', item: 'Medalhão', quantidade: 1 },
    { setor: 'Saladas', item: 'Salada verde', quantidade: Math.floor(Math.random() * 2) + 1 },
    { setor: 'Saladas', item: 'Salada caesar', quantidade: 1 },
    { setor: 'Frios', item: 'Tábua de frios', quantidade: 1 },
    { setor: 'Entradas', item: 'Bruschetta', quantidade: Math.floor(Math.random() * 2) + 1 },
    { setor: 'Sobremesas', item: 'Petit gâteau', quantidade: Math.floor(Math.random() * 2) + 1 },
    { setor: 'Sobremesas', item: 'Mousse de maracujá', quantidade: 1 }
  ];
  
  // 20% de chance de ser delivery
  const isDelivery = Math.random() < 0.2;
  const mesa = isDelivery ? `Delivery #${Math.floor(Math.random() * 500) + 1}` : `Mesa ${Math.floor(Math.random() * 20) + 1}`;
  
  // Selecionar 2-5 itens aleatórios
  const numItems = Math.floor(Math.random() * 4) + 2;
  const shuffled = salonItems.sort(() => 0.5 - Math.random());
  const selectedItems = shuffled.slice(0, numItems);
  
  return {
    id: Date.now(),
    uuid: uuidv4(),
    mesa,
    tipo: isDelivery ? 'delivery' : 'salao',
    status: 'novo',
    horario: moment().format('HH:mm'),
    createdAt: moment().toISOString(),
    sourceFile: path.basename(filePath),
    itens: selectedItems.map(item => ({
      ...item,
      uuid: uuidv4()
    }))
  };
}

// Mover arquivo para pasta processados
function moveFileToProcessed(filePath) {
  const fileName = path.basename(filePath);
  const destPath = path.join(CONFIG.PROCESSED_PATH, `${moment().format('YYYYMMDD_HHmmss')}_${fileName}`);
  
  try {
    fs.copyFileSync(filePath, destPath);
    fs.unlinkSync(filePath);
    logEvent('FILE', `Arquivo processado: ${fileName}`);
    return true;
  } catch (err) {
    logEvent('ERROR', `Erro ao mover arquivo: ${fileName}`, err.message);
    return false;
  }
}

// Variáveis globais
let mainWindow;
let wsServer;
let watcher;
let orders = [];

// Criar janela principal (opcional - para debug/admin)
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: CONFIG.WINDOW_WIDTH,
    height: CONFIG.WINDOW_HEIGHT,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs') // Opcional para IPC seguro
    },
    icon: path.join(__dirname, 'frontend', 'icon.png'),
    title: 'Kitchen Flow Monitor - Admin',
    show: process.env.NODE_ENV === 'development'
  });

  // Carregar interface de admin (opcional)
  // mainWindow.loadFile('frontend/admin.html');
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Inicializar sistema
async function initialize() {
  ensureDirectories();
  orders = loadOrders();
  
  // Iniciar servidor WebSocket
  wsServer = new WebSocketServer(CONFIG.WS_PORT, {
    onConnect: (client) => {
      logEvent('WS', `Tablet conectado: ${client.id}`);
      // Enviar estado atual
      client.send(JSON.stringify({ type: 'INIT', orders }));
    },
    onMessage: async (client, message) => {
      await handleClientMessage(client, message);
    },
    onDisconnect: (client) => {
      logEvent('WS', `Tablet desconectado: ${client.id}`);
    }
  });
  
  // Iniciar watcher de arquivos
  watcher = new Watcher(CONFIG.DOWNLOAD_PATH, {
    onNewFile: async (filePath) => {
      await handleNewFile(filePath);
    }
  });
  
  logEvent('SYSTEM', 'Kitchen Flow Monitor iniciado', {
    wsPort: CONFIG.WS_PORT,
    watchPath: CONFIG.DOWNLOAD_PATH,
    ordersLoaded: orders.length
  });
  
  // Criar janela principal se em modo dev
  if (process.argv.includes('--dev') || process.env.NODE_ENV === 'development') {
    createMainWindow();
  }
  
  // Manter app rodando mesmo sem janelas
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      // Não fechar o app, só a janela
    }
  });
}

// Handler para mensagens do tablet
async function handleClientMessage(client, message) {
  try {
    const { type, payload } = JSON.parse(message);
    
    switch (type) {
      case 'UPDATE_STATUS':
        await updateOrderStatus(payload.orderId, payload.status, payload.sector);
        break;
        
      case 'DELETE_ORDER':
        await deleteOrder(payload.orderId);
        break;
        
      case 'REQUEST_FULL_SYNC':
        client.send(JSON.stringify({ type: 'INIT', orders }));
        break;
        
      case 'PING':
        client.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        break;
    }
  } catch (err) {
    logEvent('ERROR', 'Erro ao processar mensagem do cliente', err.message);
  }
}

// Atualizar status do pedido
async function updateOrderStatus(orderId, newStatus, sector = null) {
  const orderIndex = orders.findIndex(o => o.id === orderId);
  if (orderIndex === -1) return false;
  
  const oldStatus = orders[orderIndex].status;
  orders[orderIndex].status = newStatus;
  orders[orderIndex].updatedAt = moment().toISOString();
  
  if (sector) {
    if (!orders[orderIndex].sectorStatus) {
      orders[orderIndex].sectorStatus = {};
    }
    orders[orderIndex].sectorStatus[sector] = newStatus;
  }
  
  const saved = saveOrders(orders);
  
  if (saved) {
    logEvent('ORDER', `Pedido #${orderId}: ${oldStatus} → ${newStatus}`, { sector });
    
    // Broadcast para todos os tablets
    wsServer.broadcast(JSON.stringify({
      type: 'ORDER_UPDATED',
      order: orders[orderIndex]
    }));
    
    return true;
  }
  return false;
}

// Excluir pedido (após concluído)
async function deleteOrder(orderId) {
  const orderIndex = orders.findIndex(o => o.id === orderId);
  if (orderIndex === -1) return false;
  
  const order = orders[orderIndex];
  orders.splice(orderIndex, 1);
  
  const saved = saveOrders(orders);
  
  if (saved) {
    logEvent('ORDER', `Pedido #${orderId} removido (concluído)`);
    
    wsServer.broadcast(JSON.stringify({
      type: 'ORDER_DELETED',
      orderId
    }));
    
    return true;
  }
  return false;
}

// Handler para novo arquivo detectado
async function handleNewFile(filePath) {
  logEvent('FILE', 'Novo arquivo detectado', filePath);
  
  // Validar extensão
  if (!filePath.toLowerCase().endsWith('.saiposnfeprt')) {
    logEvent('FILE', 'Arquivo ignorado (extensão não válida)', filePath);
    return;
  }
  
  // Gerar pedido mockado (V1)
  const newOrder = generateMockOrder(filePath);
  
  // Adicionar à lista
  orders.unshift(newOrder); // Novo no topo
  const saved = saveOrders(orders);
  
  if (saved) {
    logEvent('ORDER', 'Pedido criado', { 
      id: newOrder.id, 
      mesa: newOrder.mesa, 
      itens: newOrder.itens.length 
    });
    
    // Mover arquivo para processados
    moveFileToProcessed(filePath);
    
    // Notificar todos os tablets
    wsServer.broadcast(JSON.stringify({
      type: 'NEW_ORDER',
      order: newOrder
    }));
    
    // Simular impressão térmica (futuro: parser ESC/POS)
    simulateThermalPrint(newOrder);
    
  } else {
    logEvent('ERROR', 'Falha ao salvar novo pedido', { id: newOrder.id });
  }
}

// Simular impressão térmica (placeholder para V2)
function simulateThermalPrint(order) {
  // V2: Integrar com node-escpos para impressão real na Epson M249A (192.168.0.252)
  const printLog = `
═══════════════════════════════
🍳 KITCHEN FLOW - NOVO PEDIDO
═══════════════════════════════
${order.mesa.toUpperCase()} | ${order.tipo.toUpperCase()} | ${order.horario}
───────────────────────────────
${order.itens.map(i => `• ${i.setor}: ${i.item} x${i.quantidade}`).join('\n')}
───────────────────────────────
ID: ${order.id} | Prioridade: ${order.tipo === 'salao' ? '🔥 ALTA' : '📦 NORMAL'}
═══════════════════════════════
`;
  console.log(printLog);
  logEvent('PRINT', 'Comanda simulada', { orderId: order.id });
}

// Lifecycle do Electron
app.whenReady().then(() => {
  initialize();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Manter backend rodando
  if (process.platform !== 'darwin') {
    // app.quit();
  }
});

app.on('before-quit', () => {
  // Cleanup
  logEvent('SYSTEM', 'Encerrando Kitchen Flow Monitor');
  watcher?.stop();
  wsServer?.close();
});

// IPC Handlers (para janela admin, se usada)
ipcMain.handle('get-orders', () => orders);
ipcMain.handle('get-logs', (limit = 100) => {
  try {
    const logs = JSON.parse(fs.readFileSync(CONFIG.LOGS_FILE, 'utf8'));
    return logs.slice(-limit);
  } catch {
    return [];
  }
});
ipcMain.handle('get-config', () => CONFIG);

// Exportar para testes
module.exports = { CONFIG, generateMockOrder, logEvent };