const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');

class WebSocketServer {
  constructor(port, options = {}) {
    this.port = port;
    this.options = {
      clientTracking: true,
      verifyClient: null,
      ...options
    };
    
    this.wss = null;
    this.clients = new Map();
    
    this.onConnect = options.onConnect || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    
    this.start();
  }
  
  start() {
    this.wss = new WebSocket.Server({ 
      port: this.port,
      ...this.options
    });
    
    this.wss.on('connection', (ws, req) => {
      const clientId = uuidv4().slice(0, 8);
      const clientInfo = {
        id: clientId,
        ws,
        connectedAt: moment().toISOString(),
        ip: req.socket?.remoteAddress || 'unknown',
        lastPing: Date.now()
      };
      
      this.clients.set(clientId, clientInfo);
      
      console.log(`🔗 Tablet conectado: ${clientId} (${clientInfo.ip})`);
      
      // Setup event handlers
      ws.on('message', (data) => {
        clientInfo.lastPing = Date.now();
        this.onMessage(clientInfo, data.toString());
      });
      
      ws.on('close', () => {
        console.log(`🔌 Tablet desconectado: ${clientId}`);
        this.clients.delete(clientId);
        this.onDisconnect(clientInfo);
      });
      
      ws.on('error', (err) => {
        console.error(`❌ Erro no cliente ${clientId}:`, err.message);
        this.clients.delete(clientId);
      });
      
      // Heartbeat
      ws.isAlive = true;
      ws.on('pong', () => {
        const client = this.clients.get(clientId);
        if (client) client.ws.isAlive = true;
      });
      
      // Callback de conexão
      this.onConnect(clientInfo);
      
      // Enviar ID para o cliente
      ws.send(JSON.stringify({ 
        type: 'CONNECTED', 
        clientId,
        serverTime: moment().format('YYYY-MM-DD HH:mm:ss')
      }));
    });
    
    // Heartbeat interval para detectar conexões mortas
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
    
    console.log(`🚀 WebSocket Server rodando em ws://localhost:${this.port}`);
    console.log(`📱 Acesse no tablet: http://<IP_DO_PC>:${this.port}`);
  }
  
  // Enviar mensagem para um cliente específico
  send(clientId, message) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
      return true;
    }
    return false;
  }
  
  // Broadcast para todos os clientes conectados
  broadcast(message, excludeClientId = null) {
    let sent = 0;
    
    this.clients.forEach((client, clientId) => {
      if (clientId === excludeClientId) return;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
        sent++;
      }
    });
    
    return sent;
  }
  
  // Enviar apenas para tablets com status específico (ex: apenas salão)
  broadcastByFilter(message, filterFn) {
    let sent = 0;
    
    this.clients.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN && filterFn(client)) {
        client.ws.send(message);
        sent++;
      }
    });
    
    return sent;
  }
  
  // Obter estatísticas
  getStats() {
    return {
      connectedClients: this.clients.size,
      clients: Array.from(this.clients.values()).map(c => ({
        id: c.id,
        ip: c.ip,
        connectedAt: c.connectedAt,
        lastPing: c.lastPing
      })),
      uptime: process.uptime()
    };
  }
  
  // Fechar servidor
  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.wss) {
      this.wss.close(() => {
        console.log('🔚 WebSocket Server fechado');
      });
      
      // Fechar todas as conexões
      this.clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close();
        }
      });
      
      this.clients.clear();
    }
  }
  
  // Método utilitário para formatar mensagem
  static createMessage(type, payload = {}) {
    return JSON.stringify({
      type,
      timestamp: moment().toISOString(),
      ...payload
    });
  }
}

module.exports = WebSocketServer;