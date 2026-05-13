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
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '[]');
    if (!fs.existsSync(this.logsPath)) fs.writeFileSync(this.logsPath, '[]');
  }

  _read(file) {
    if (this.type !== 'json') return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return []; }
  }

  _write(file, data) {
    if (this.type !== 'json') return true;
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return true;
    } catch(e) { console.error('Storage write error:', e.message); return false; }
  }

  async saveOrder(order) {
    if (this.type === 'memory') return order;
    
    const orders = this._read(this.filePath);
    orders.unshift(order);
    if (orders.length > this.maxOrders) orders.length = this.maxOrders;
    
    if (this._write(this.filePath, orders)) {
      await this._log('ORDER_SAVED', { id: order.id, mesa: order.mesa });
      return order;
    }
    throw new Error('Failed to save order');
  }

  async updateOrder(orderId, updates) {
    if (this.type === 'memory') return updates;
    
    const orders = this._read(this.filePath);
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx === -1) throw new Error('Order not found');
    
    orders[idx] = { ...orders[idx], ...updates, updatedAt: moment().toISOString() };
    
    if (this._write(this.filePath, orders)) {
      await this._log('ORDER_UPDATED', { id: orderId, ...updates });
      return orders[idx];
    }
    throw new Error('Failed to update order');
  }

  async deleteOrder(orderId) {
    if (this.type === 'memory') return true;
    
    const orders = this._read(this.filePath);
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

  async _log(type, data) {
    if (this.type !== 'json') return;
    const entry = { timestamp: moment().toISOString(), type, data };
    const logs = this._read(this.logsPath);
    logs.push(entry);
    if (logs.length > 2000) logs.shift();
    this._write(this.logsPath, logs);
  }

  async getStats() {
    const orders = await this.getAll();
    return {
      total: orders.length,
      byStatus: orders.reduce((acc, o) => { acc[o.status] = (acc[o.status]||0)+1; return acc; }, {}),
      byType: orders.reduce((acc, o) => { acc[o.tipo] = (acc[o.tipo]||0)+1; return acc; }, {}),
      lastUpdate: orders[0]?.updatedAt || null
    };
  }
}

module.exports = Storage;