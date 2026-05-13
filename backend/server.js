const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const Storage = require('./storage');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Config
const PORT = process.env.PORT || 4545;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const API_KEY = process.env.ELECTRON_API_KEY; // opcional
const storage = new Storage({
  type: process.env.STORAGE_TYPE || 'json',
  maxOrders: parseInt(process.env.MAX_ORDERS) || 500
});

// Middleware
app.use(cors({ origin: FRONTEND_URL === '*' ? '*' : [FRONTEND_URL] }));
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: moment().toISOString(), uptime: process.uptime() });
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await storage.getStats();
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 🔥 Endpoint principal: Electron envia novo pedido aqui
app.post('/api/orders', async (req, res) => {
  // Autenticação simples (opcional)
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { sourceFile, mockData, ...extra } = req.body;
    
    // Validação mínima
    if (!mockData?.itens || !Array.isArray(mockData.itens)) {
      return res.status(400).json({ error: 'Invalid order data' });
    }

    const order = {
      id: Date.now(),
      uuid: uuidv4(),
      mesa: mockData.mesa || 'Mesa ?',
      tipo: mockData.tipo || 'salao',
      status: 'novo',
      horario: moment().format('HH:mm'),
      createdAt: moment().toISOString(),
      sourceFile: sourceFile || 'unknown',
      itens: mockData.itens.map((it, i) => ({
        uuid: uuidv4(),
        setor: it.setor || 'Fogão',
        item: it.item || 'Item',
        quantidade: it.quantidade || 1
      })),
      ...extra
    };

    const saved = await storage.saveOrder(order);
    
    // Broadcast para todos os tablets conectados
    broadcast({ type: 'NEW_ORDER', order: saved });
    
    console.log(`✅ Pedido criado: ${order.mesa} (${order.itens.length} itens)`);
    res.status(201).json({ success: true, order: saved });
    
  } catch(e) {
    console.error('❌ Error creating order:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// WebSocket: tablets se conectam aqui
wss.on('connection', (ws, req) => {
  const clientId = uuidv4().slice(0, 8);
  const clientInfo = { id: clientId, ip: req.socket?.remoteAddress, connectedAt: moment().toISOString() };
  
  console.log(`🔗 Tablet conectado: ${clientId}`);
  
  // Enviar pedidos existentes ao conectar
  storage.getAll().then(orders => {
    ws.send(JSON.stringify({ type: 'INIT', orders, serverTime: moment().format('HH:mm:ss') }));
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await handleClientMessage(clientId, msg, ws);
    } catch(e) { console.error('WS message error:', e.message); }
  });

  ws.on('close', () => console.log(`🔌 Tablet desconectado: ${clientId}`));
  ws.on('error', (e) => console.error(`❌ WS error ${clientId}:`, e.message));
});

// Handler de mensagens dos tablets
async function handleClientMessage(clientId, msg, ws) {
  const { type, payload } = msg;
  
  switch(type) {
    case 'UPDATE_STATUS': {
      const { orderId, status, sector } = payload;
      const updates = { status };
      if (sector) updates.sectorStatus = { ...(await storage.getAll()).find(o=>o.id===orderId)?.sectorStatus || {}, [sector]: status };
      
      const updated = await storage.updateOrder(orderId, updates);
      broadcast({ type: 'ORDER_UPDATED', order: updated }, clientId);
      console.log(`📝 Pedido #${orderId}: ${status}${sector ? ` [${sector}]` : ''}`);
      break;
    }
    
    case 'DELETE_ORDER': {
      const { orderId } = payload;
      await storage.deleteOrder(orderId);
      broadcast({ type: 'ORDER_DELETED', orderId }, clientId);
      console.log(`🗑️ Pedido #${orderId} removido`);
      break;
    }
    
    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG', timestamp: moment().toISOString() }));
      break;
  }
}

// Broadcast para todos os clientes (exceto origin)
function broadcast(message, excludeClientId = null) {
  const payload = JSON.stringify({ ...message, timestamp: moment().toISOString() });
  let sent = 0;
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent++;
    }
  });
  
  return sent;
}

// Heartbeat para manter conexões ativas
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend rodando em porta ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 API: http://localhost:${PORT}/api/orders`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Encerrando...');
  server.close(() => {
    wss.close();
    process.exit(0);
  });
});

module.exports = { app, server, wss, storage };