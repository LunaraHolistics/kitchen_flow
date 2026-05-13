const fs = require('fs');
const path = require('path');
const moment = require('moment');

class Storage {
  constructor(options = {}) {
    this.type = options.type || 'json';
    this.filePath = options.filePath || path.join(__dirname, 'storage', 'orders.json');
    this.logsPath = options.logsPath || path.join(__dirname, 'storage', 'logs.json');
    this.maxOrders = options.maxOrders || 500;
    this._ensureFile();
  }

  _ensureFile() {
    if (this.type !== 'json') return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Pasta criada: ${dir}`);
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]');
      console.log('📄 orders.json criado');
    }
    if (!fs.existsSync(this.logsPath)) {
      fs.writeFileSync(this.logsPath, '[]');
      console.log('📄 logs.json criado');
    }
  }

  _read(file) {
    if (this.type !== 'json') return [];
    try { 
      const data = fs.readFileSync(file, 'utf8');
      return JSON.parse(data); 
    } catch { 
      return []; 
    }
  }

  _write(file, data) {
    if (this.type !== 'json') return true;
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return true;
    } catch(e) { 
      console.error('Storage write error:', e.message); 
      return false; 
    }
  }

  async saveOrder(order) {
    if (this.type === 'memory') return order;
    
    const orders = this._read(this.filePath);
    orders.unshift(order);
    
    // Limitar quantidade
    if (orders.length > this.maxOrders) {
      orders.length = this.maxOrders;
    }
    
    if (this._write(this.filePath, orders)) {
      await this._log('ORDER_SAVED', { 
        id: order.id, 
        mesa: order.mesa,
        itens: order.itens.length 
      });
      return order;
    }
    throw new Error('Failed to save order');
  }

  async updateOrder(orderId, updates) {
    if (this.type === 'memory') return updates;
    
    const orders = await this.getAll();
    const idx = orders.findIndex(o => o.id === orderId);
    
    if (idx === -1) {
      throw new Error(`Order ${orderId} not found`);
    }
    
    orders[idx] = { 
      ...orders[idx], 
      ...updates, 
      updatedAt: moment().toISOString() 
    };
    
    if (this._write(this.filePath, orders)) {
      await this._log('ORDER_UPDATED', { 
        id: orderId, 
        status: updates.status,
        sector: updates.sectorStatus 
      });
      return orders[idx];
    }
    throw new Error('Failed to update order');
  }

  async deleteOrder(orderId) {
    if (this.type === 'memory') return true;
    
    const orders = await this.getAll();
    const filtered = orders.filter(o => o.id !== orderId);
    
    if (filtered.length < orders.length && this._write(this.filePath, filtered)) {
      await this._log('ORDER_DELETED', { id: orderId });
      return true;
    }
    return false;
  }

  async getAll() {
    if (this.type === 'memory') return [];
    return this._read(this.filePath);
  }

  async getById(orderId) {
    const orders = await this.getAll();
    return orders.find(o => o.id === orderId);
  }

  async _log(type, data) {
    if (this.type !== 'json') return;
    
    const entry = { 
      timestamp: moment().toISOString(), 
      type, 
      data 
    };
    
    const logs = this._read(this.logsPath);
    logs.push(entry);
    
    // Manter apenas últimos 2000 logs
    if (logs.length > 2000) {
      logs.splice(0, logs.length - 2000);
    }
    
    this._write(this.logsPath, logs);
  }

  async getStats() {
    const orders = await this.getAll();
    
    const stats = {
      total: orders.length,
      byStatus: {},
      byType: {},
      bySector: {},
      recent: [],
      lastUpdate: orders[0]?.updatedAt || null
    };
    
    // Contar por status
    orders.forEach(o => {
      stats.byStatus[o.status] = (stats.byStatus[o.status] || 0) + 1;
    });
    
    // Contar por tipo
    orders.forEach(o => {
      stats.byType[o.tipo] = (stats.byType[o.tipo] || 0) + 1;
    });
    
    // Contar por setor
    orders.forEach(o => {
      o.itens.forEach(it => {
        stats.bySector[it.setor] = (stats.bySector[it.setor] || 0) + it.quantidade;
      });
    });
    
    // Últimos 10 pedidos
    stats.recent = orders.slice(0, 10).map(o => ({
      id: o.id,
      mesa: o.mesa,
      status: o.status,
      horario: o.horario
    }));
    
    return stats;
  }

  async clearCompleted(olderThanHours = 24) {
    const orders = await this.getAll();
    const cutoff = moment().subtract(olderThanHours, 'hours').toISOString();
    
    const filtered = orders.filter(o => {
      if (o.status !== 'concluido') return true;
      const concludedAt = o.updatedAt || o.createdAt;
      return moment(concludedAt).isAfter(cutoff);
    });
    
    const removed = orders.length - filtered.length;
    
    if (removed > 0 && this._write(this.filePath, filtered)) {
      await this._log('CLEANUP', { 
        action: 'clear_completed',
        removed,
        olderThanHours 
      });
      console.log(`🧹 Limpos ${removed} pedidos concluídos`);
    }
    
    return removed;
  }
}

module.exports = Storage;