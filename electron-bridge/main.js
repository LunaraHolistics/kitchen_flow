const LicenseManager = require('./license-manager');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const Watcher = require('./watcher');
const http = require('http');
const { exec } = require('child_process');
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
  version: '2.1.7', // ← Atualizado para versão com correções de rede
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
    } catch (e) {
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
    } catch (e) {
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

// ← NOVO: Cache de pedidos ativos para o endpoint do garçom
let activeOrdersCache = [];
const CACHE_TTL = 5000; // 5 segundos
let lastCacheUpdate = 0;

// ← NOVO: Sistema de PIN Diário para Página do Garçom (com pin-state.json)
const PIN_STATE_FILE = path.join(app.getPath('userData'), 'pin-state.json');
const PIN_HISTORY_FILE = path.join(app.getPath('userData'), 'pin-history.json');
const MAX_PIN_HISTORY = 7;

let currentPinState = {
  pin: null,
  validFor: null,
  generatedAt: null,
  source: 'auto',
  lastNotified: null
};

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

// ← NOVO: Função para tentar liberar firewall automaticamente (Windows)
function tryOpenFirewallPort(port, protocol = 'TCP') {
  if (process.platform !== 'win32') return; // Só funciona no Windows
  
  log('INFO', `🔐 Tentando liberar porta ${port} no firewall do Windows...`);
  
  const command = `netsh advfirewall firewall add rule name="KitchenFlow-Bridge-${port}" dir=in action=allow protocol=${protocol} localport=${port} profile=any`;
  
  exec(command, { windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      log('WARN', `⚠️ Não foi possível liberar firewall automaticamente: ${error.message}`);
      log('INFO', '💡 Instrução manual: Execute como Admin no PowerShell:');
      log('INFO', `   netsh advfirewall firewall add rule name="KitchenFlow-Bridge-${port}" dir=in action=allow protocol=${protocol} localport=${port} profile=any`);
    } else {
      log('INFO', `✅ Porta ${port} liberada no firewall do Windows`);
    }
  });
}

// ← NOVO: Verificar se porta está em uso por outro processo
function isPortInUse(port, callback) {
  const server = http.createServer();
  
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      callback(true);
    } else {
      callback(false);
    }
    server.close();
  });
  
  server.once('listening', () => {
    server.close();
    callback(false);
  });
  
  server.listen(port, '0.0.0.0');
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
  } catch (e) { }
}, 60 * 60 * 1000);

// ============================================================================
// ← NOVO: FUNÇÕES PARA GERENCIAR PIN DIÁRIO (com pin-state.json)
// ============================================================================

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

// Carregar estado do PIN do arquivo
function loadPinState() {
  try {
    if (fs.existsSync(PIN_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(PIN_STATE_FILE, 'utf8'));
      // Validar se ainda é para hoje
      if (state.validFor === getTodayDate()) {
        currentPinState = state;
        log('INFO', `🔑 PIN carregado do estado: **${state.pin?.slice(-2)} (${state.source})`);
        return true;
      }
    }
  } catch (e) {
    log('WARN', `Falha ao carregar estado do PIN: ${e.message}`);
  }
  return false;
}

// Salvar estado do PIN no arquivo
function savePinState() {
  try {
    fs.writeFileSync(PIN_STATE_FILE, JSON.stringify(currentPinState, null, 2), 'utf8');
  } catch (e) {
    log('WARN', `Falha ao salvar estado do PIN: ${e.message}`);
  }
}

function loadPinHistory() {
  try {
    if (fs.existsSync(PIN_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(PIN_HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    log('WARN', `Falha ao carregar histórico de PINs: ${e.message}`);
  }
  return [];
}

function savePinHistory(history) {
  try {
    const trimmed = history.slice(-MAX_PIN_HISTORY);
    fs.writeFileSync(PIN_HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) {
    log('WARN', `Falha ao salvar histórico de PINs: ${e.message}`);
  }
}

function isPinUsedRecently(pin, history) {
  return history.some(entry => entry.pin === pin);
}

function generateUniquePin() {
  const history = loadPinHistory();
  let attempts = 0;
  const maxAttempts = 100;
  
  while (attempts < maxAttempts) {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    if (!isPinUsedRecently(pin, history)) {
      return pin;
    }
    attempts++;
  }
  return Date.now().toString().slice(-4);
}

// ← NOVO: Gerar PIN e notificar a UI automaticamente
function generateAndNotifyPin() {
  if (currentPinState.pin && currentPinState.validFor === getTodayDate()) {
    return currentPinState.pin;
  }
  
  const newPin = generateUniquePin();
  
  currentPinState = {
    pin: newPin,
    validFor: getTodayDate(),
    generatedAt: new Date().toISOString(),
    source: 'auto',
    lastNotified: new Date().toISOString()
  };
  
  savePinState();
  
  // Notificar janela principal
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pin-updated', {
      pin: newPin,
      maskedPin: `**${newPin.slice(-2)}`,
      source: 'auto',
      validFor: getTodayDate(),
      message: '🔑 PIN gerado automaticamente. Compartilhe com a equipe!'
    });
  }
  
  showNotification('PIN do Garçom Gerado', `Código: **${newPin.slice(-2)} • Válido até 23:59`, 'info');
  log('INFO', `🔑 PIN automático gerado: ${newPin} • UI notificada`);
  return newPin;
}

function getWaiterPin() {
  // Primeiro tentar carregar do estado persistido
  if (loadPinState() && currentPinState.pin) {
    return currentPinState.pin;
  }
  
  const today = getTodayDate();
  
  // Verificar .env como fallback
  const envPin = process.env.KFM_WAITER_PIN;
  if (envPin && /^\d{4}$/.test(envPin)) {
    const history = loadPinHistory();
    if (!isPinUsedRecently(envPin, history)) {
      currentPinState = {
        pin: envPin,
        validFor: today,
        generatedAt: new Date().toISOString(),
        source: 'env',
        lastNotified: null
      };
      savePinState();
      log('INFO', `🔑 PIN carregado do .env: ${envPin}`);
      return envPin;
    }
  }
  
  // Gerar novo PIN único
  return generateAndNotifyPin();
}

function setWaiterPin(newPin) {
  if (!/^\d{4}$/.test(newPin)) {
    return { success: false, error: 'PIN deve ter exatamente 4 dígitos' };
  }
  
  const history = loadPinHistory();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yesterdayEntry = history.find(h => h.date === yesterdayStr);
  
  if (yesterdayEntry && yesterdayEntry.pin === newPin) {
    return { success: false, error: 'PIN não pode ser igual ao de ontem. Escolha outro código.' };
  }
  
  if (isPinUsedRecently(newPin, history)) {
    return { success: false, error: 'Este PIN já foi usado recentemente. Escolha outro código.' };
  }
  
  // Atualizar estado
  currentPinState = {
    pin: newPin,
    validFor: getTodayDate(),
    generatedAt: new Date().toISOString(),
    source: 'manual',
    lastNotified: new Date().toISOString()
  };
  savePinState();
  
  // Salvar no histórico
  history.push({ date: getTodayDate(), pin: newPin, generated: false });
  savePinHistory(history);
  
  // Notificar UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pin-updated', {
      pin: newPin,
      maskedPin: `**${newPin.slice(-2)}`,
      source: 'manual',
      validFor: getTodayDate(),
      message: '✅ PIN atualizado pela gerente'
    });
  }
  
  log('INFO', `🔑 PIN manual definido: ${newPin} • UI notificada`);
  return { success: true, message: 'PIN atualizado com sucesso' };
}

function getWaiterPinInfo() {
  // Garantir que há PIN válido
  if (!currentPinState.pin || currentPinState.validFor !== getTodayDate()) {
    loadPinState();
  }
  
  const history = loadPinHistory();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yesterdayPin = history.find(h => h.date === yesterdayStr)?.pin;
  
  return {
    success: true,
    maskedPin: `**${currentPinState.pin?.slice(-2) || '??'}`,
    validUntil: currentPinState.validFor || getTodayDate(),
    isToday: currentPinState.validFor === getTodayDate(),
    source: currentPinState.source,
    yesterdayPin: yesterdayPin ? `**${yesterdayPin.slice(-2)}` : null,
    historyCount: history.length
  };
}

// ============================================================================
// ← NOVO: FUNÇÕES PARA O ENDPOINT DO GARÇOM
// ============================================================================

// ← NOVO: Verificar se item tem prioridade (Kids/Porções)
function isPriorityItem(itemName) {
  const keywords = ['kids', 'infantil', 'criança', 'batata', 'porção', 'tirinhas', 'salada', 'entrada', 'frango', 'nugget', 'mini'];
  const lower = itemName.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// ← NOVO: Obter pedidos ativos (com cache de 5s para performance)
function getActiveOrders() {
  const now = Date.now();

  // Retornar cache se válido
  if (activeOrdersCache.length > 0 && (now - lastCacheUpdate) < CACHE_TTL) {
    return activeOrdersCache;
  }

  // Carregar do histórico recente (últimos 30 min)
  const recentHistory = downloadHistory.filter(h =>
    h.status === 'success' &&
    (now - new Date(h.timestamp).getTime()) < 30 * 60 * 1000
  );

  // Mapear para estrutura simplificada
  activeOrdersCache = recentHistory.map(entry => {
    // Tentar extrair dados do message (formato: "Mesa X • Y itens")
    const mesaMatch = entry.message?.match(/Mesa\s*(\d+)/i);
    const itensMatch = entry.message?.match(/(\d+)\s*itens?/i);

    return {
      id: entry.id,
      mesa: mesaMatch ? `Mesa ${mesaMatch[1]}` : 'Desconhecida',
      status: 'em-preparo', // Simplificado: assume em preparo se está no histórico recente
      garcom: 'Desconhecido', // Será preenchido pelo parser se disponível
      tipo: 'salao',
      timestamp: entry.timestamp,
      itens: [], // Será preenchido se tivermos os dados completos
      hasPriority: false // Será calculado abaixo
    };
  });

  lastCacheUpdate = now;
  return activeOrdersCache;
}

// ← NOVO: Atualizar cache quando novo pedido é processado
function updateActiveOrdersCache(orderData) {
  activeOrdersCache = [];
  lastCacheUpdate = 0;
  // Força recarregamento na próxima chamada
}

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
  } catch (e) {
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
          original: rawItem,
          // ← NOVO: Marcar prioridade no item
          priority: isPriorityItem(comp.item)
        });
      });
      if (matchedPrato.categoria && menuMap.acompanhamentos_fixos_por_categoria?.[matchedPrato.categoria]) {
        menuMap.acompanhamentos_fixos_por_categoria[matchedPrato.categoria].forEach(acc => {
          itensFinais.push({
            uuid: uuidv4(),
            setor: acc.setor,
            item: acc.item,
            quantidade: (acc.quantidade || 1) * qty,
            original: rawItem,
            priority: isPriorityItem(acc.item)
          });
        });
      }
    } else {
      itensFinais.push({
        uuid: uuidv4(),
        setor: 'Fogão',
        item: rawItem,
        quantidade: qty,
        original: rawItem,
        priority: isPriorityItem(rawItem)
      });
    }
  });

  return {
    mesa: parsedData.mesa,
    garcom: parsedData.garcom,
    tipo: 'salao',
    itens: itensFinais,
    rawItems: parsedData.itemsRaw,
    // ← NOVO: Marcar se pedido tem prioridade
    hasPriority: itensFinais.some(i => i.priority)
  };
}

function generateRandomFallback() {
  return {
    mesa: `Mesa ${Math.floor(Math.random() * 20) + 1}`,
    tipo: 'salao',
    itens: [{ uuid: uuidv4(), setor: 'Fogão', item: 'Pedido Genérico', quantidade: 1, priority: false }],
    hasPriority: false
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

    // ← NOVO: Se nenhum PIN foi definido para hoje, gerar e notificar automaticamente
    if (!currentPinState.pin || currentPinState.validFor !== getTodayDate()) {
      generateAndNotifyPin();
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

    // ← NOVO: Atualizar cache do endpoint do garçom
    updateActiveOrdersCache(orderData);

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
    parserVersion: '2.1.7' // ← Atualizado
  };

  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'KitchenFlowBridge/2.1.7' };
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
  } catch (e) {
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
    {
      label: '🔑 Definir PIN do Garçom',
      click: async () => {
        const result = await dialog.showInputBox({
          title: 'Definir PIN de Acesso',
          message: 'Digite o código de 4 dígitos para acesso dos garçons hoje:',
          default: '',
          type: 'text',
          properties: ['noLink', 'normalizeAccessKeys']
        });

        if (result.response === 0 && result.input) {
          const pinResult = setWaiterPin(result.input);
          if (pinResult.success) {
            showNotification('✅ PIN Atualizado', `Código: **${result.input.slice(-2)}`, 'success');
          } else {
            dialog.showMessageBox({
              type: 'warning',
              title: 'PIN Inválido',
              message: pinResult.error,
              detail: 'Escolha um código de 4 dígitos diferente dos últimos 7 dias.'
            });
          }
        }
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

  for (const envPath of possiblePaths) {
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
  log('INFO', `✅ V2.1.7 Ativo | Monitorando: ${CONFIG.DOWNLOAD_PATH}`);
}

// ============================================================================
// SERVIDOR HTTP PARA EXTENSÃO DO NAVEGADOR + GARÇOM
// ============================================================================
function startHttpServer() {
  // ← NOVO: Verificar conflito de porta antes de iniciar
  isPortInUse(4545, (inUse) => {
    if (inUse) {
      log('WARN', '⚠️ Porta 4545 já em uso por outro processo. Verifique se Java, Saipos ou outro app está usando esta porta.');
      log('INFO', '💡 Solução: O sistema tentará usar a porta 4546 automaticamente.');
    }
    
    // ← NOVO: Tentar liberar firewall para a porta principal
    tryOpenFirewallPort(4545);
    
    startServerOnPort(4545);
  });
}

function startServerOnPort(port) {
  httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // ← NOVO: Endpoint para página do garçom consultar PIN
    if (req.url === '/api/waiter/pin' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        pin: getWaiterPin(),
        validUntil: getTodayDate()
      }));
      return;
    }

    // ← NOVO: Endpoint para página do garçom listar garçons
    if (req.url === '/api/waiter/waiters' && req.method === 'GET') {
      try {
        // Extrair garçons únicos do histórico recente
        const recentHistory = downloadHistory.filter(h =>
          h.status === 'success' &&
          h.message &&
          (Date.now() - new Date(h.timestamp).getTime()) < 7 * 24 * 60 * 60 * 1000 // 7 dias
        );

        const waiters = [...new Set(
          recentHistory
            .map(h => {
              const match = h.message?.match(/Garçom:\s*([^\•]+)/i);
              return match ? match[1].trim() : null;
            })
            .filter(Boolean)
        )].sort();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, waiters }));

      } catch (e) {
        log('ERROR', `Erro no endpoint /api/waiter/waiters: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // ← NOVO: Endpoint para página do garçom consultar pedidos
    if (req.url.startsWith('/api/waiter/orders') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const garcomFilter = url.searchParams.get('garcom');

        // Obter pedidos ativos (com cache)
        const orders = getActiveOrders();

        // Filtrar por garçom se especificado
        const filtered = garcomFilter
          ? orders.filter(o => o.garcom?.toLowerCase() === garcomFilter.toLowerCase())
          : orders;

        // ← NOVO: Enriquecer dados com prioridade e status simplificado
        const enriched = filtered.map(order => ({
          ...order,
          // Calcular prioridade baseado nos itens
          hasPriority: order.itens?.some(i => i.priority) || false,
          // Status simplificado para mobile
          statusDisplay: order.status === 'concluido' ? 'Pronto' :
            order.status === 'em-preparo' ? 'Em preparo' : 'Pendente',
          // Tempo desde o pedido
          elapsedMinutes: Math.floor((Date.now() - new Date(order.timestamp).getTime()) / 60000)
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          orders: enriched,
          timestamp: new Date().toISOString(),
          total: enriched.length,
          filtered: !!garcomFilter
        }));

      } catch (e) {
        log('ERROR', `Erro no endpoint /api/waiter/orders: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }

    // Endpoint: POST /api/download (recebe captura da extensão)
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

    }
    // Endpoint: GET /api/history (retorna histórico para extensão)
    else if (req.url === '/api/history' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        history: getHistory().slice(0, 50) // Últimos 50
      }));

    }
    // Endpoint: GET /api/status (health check)
    else if (req.url === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        bridgeId: BRIDGE_ID,
        watching: watcher?.isActive || false,
        downloadPath: CONFIG.DOWNLOAD_PATH,
        timestamp: new Date().toISOString()
      }));

    }
    // ← NOVO: Servidor de Arquivos Estáticos para Frontend (Garçom/Block)
    else {
      // Determinar caminho correto (desenvolvimento vs produção)
      const staticPath = app.isPackaged 
        ? path.join(process.resourcesPath, 'frontend') 
        : path.join(__dirname, '..', 'frontend');
      
      // Normalizar URL (remover query strings e tratar root)
      const urlPath = req.url.split('?')[0];
      const filePath = path.join(staticPath, urlPath === '/' ? 'waiter.html' : urlPath);
      
      // Proteção contra path traversal e servir arquivo se existir
      if (!filePath.includes('..') && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const extname = path.extname(filePath);
        const mimeTypes = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.txt': 'text/plain'
        };
        
        res.writeHead(200, { 
          'Content-Type': mimeTypes[extname] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=300' // Cache de 5 minutos para assets
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      
      // 404 para outras rotas
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Kitchen Flow Bridge API - Endpoint not found');
    }
  });

  httpServer.listen(port, '0.0.0.0', () => {
    log('INFO', `🌐 API HTTP rodando em http://0.0.0.0:${port}`);
    log('INFO', `📱 Endpoint do garçom: GET /api/waiter/orders?garcom=Nome`);
    log('INFO', `🔑 Endpoint do PIN: GET /api/waiter/pin`);
    log('INFO', `📄 Servidor de arquivos: frontend/ → /waiter.html, /waiter.js, etc.`);
    log('INFO', `🔗 URL para tablet/garçom: http://[IP-DO-PC]:${port}/waiter.html`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WARN', `⚠️ Porta ${port} já em uso. Tentando porta ${port === 4545 ? 4546 : 4547}...`);
      // ← CORREÇÃO #1: Usar '0.0.0.0' também no fallback
      const nextPort = port === 4545 ? 4546 : 4547;
      tryOpenFirewallPort(nextPort); // ← NOVO: Tentar liberar firewall para próxima porta também
      startServerOnPort(nextPort);
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

// ← NOVO: Endpoint para listar garçons únicos (para o select da página do garçom)
ipcMain.handle('get-waiters-list', () => {
  const waiters = [...new Set(
    downloadHistory
      .filter(h => h.status === 'success' && h.message?.includes('Garçom:'))
      .map(h => {
        const match = h.message?.match(/Garçom:\s*([^\•]+)/i);
        return match ? match[1].trim() : null;
      })
      .filter(Boolean)
  )];

  return { success: true, waiters };
});

// ← NOVO: IPC para definir PIN do garçom (via interface do Bridge)
ipcMain.handle('set-waiter-pin', (event, newPin) => {
  return setWaiterPin(newPin);
});

// ← NOVO: IPC para obter informações do PIN (para exibir na UI)
ipcMain.handle('get-waiter-pin-info', () => {
  return getWaiterPinInfo();
});

// ← NOVO: IPC para obter PIN atual (para a UI copiar)
ipcMain.handle('get-current-pin', () => {
  if (!currentPinState.pin || currentPinState.validFor !== getTodayDate()) {
    loadPinState();
  }
  
  return {
    success: true,
    fullPin: currentPinState.pin,
    maskedPin: `**${currentPinState.pin?.slice(-2) || '??'}`,
    source: currentPinState.source,
    validFor: currentPinState.validFor
  };
});

// ← NOVO: IPC para limpar histórico de PINs (apenas para debug/admin)
ipcMain.handle('clear-pin-history', () => {
  try {
    if (fs.existsSync(PIN_HISTORY_FILE)) {
      fs.unlinkSync(PIN_HISTORY_FILE);
    }
    if (fs.existsSync(PIN_STATE_FILE)) {
      fs.unlinkSync(PIN_STATE_FILE);
    }
    currentPinState = {
      pin: null,
      validFor: null,
      generatedAt: null,
      source: 'auto',
      lastNotified: null
    };
    log('INFO', '🧹 Histórico de PINs limpo');
    return { success: true };
  } catch (e) {
    log('ERROR', `Falha ao limpar histórico de PINs: ${e.message}`);
    return { success: false, error: e.message };
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

  log('INFO', '🚀 Kitchen Flow Bridge V2.1.7 iniciando...');

  // ← NOVO: Inicializar PIN do garçom no startup
  getWaiterPin();

  createTray();
  createWindow();
  startWatcher();
  startHttpServer();

  showNotification('Kitchen Flow V2.1.7', 'Conexão externa + Firewall auto + Anti-conflito • Pronto');
});

// ============================================================================
// LIFECYCLE
// ============================================================================
app.on('window-all-closed', () => { });

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
  updateDownloadPath,
  // ← NOVO: Exportar para testes
  getActiveOrders,
  isPriorityItem,
  getWaiterPin,
  setWaiterPin,
  getWaiterPinInfo
};