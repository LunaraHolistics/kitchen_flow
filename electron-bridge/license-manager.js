const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Caminho oculto para a licença (difícil do usuário achar)
const LICENSE_DIR = path.join(process.env.APPDATA || process.env.HOME, '.kf-secure-license');
const LICENSE_FILE = path.join(LICENSE_DIR, 'kf-system.dat');

// 🔒 SENHA MESTRA (NUNCA COMPARTILHE ISSO)
// Essa é a chave que gera a segurança. Se alguém não tiver essa string, não gera chaves válidas.
const SECRET_SALT = 'KitchenFlow-2026-Enterprise-Master-Key-Secret'; 

class LicenseManager {
  constructor() {
    if (!fs.existsSync(LICENSE_DIR)) {
      fs.mkdirSync(LICENSE_DIR, { recursive: true });
    }
  }

  // Gera ou lê o ID único deste computador
  getMachineId() {
    let data = this.getData();
    if (!data.machineId) {
      // Cria ID baseado na data + random + info do SO
      const raw = `${Date.now()}-${Math.random()}-${os.hostname()}-${os.cpus()[0].model}`;
      data.machineId = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 12).toUpperCase();
      this.saveData(data);
    }
    return data.machineId;
  }

  getData() {
    if (fs.existsSync(LICENSE_FILE)) {
      return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    }
    // Padrão: Novo usuário tem 7 dias de teste
    return { installDate: new Date().toISOString(), status: 'trial', machineId: null };
  }

  saveData(data) {
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data));
  }

  // Verifica se o sistema está liberado
  checkStatus() {
    const data = this.getData();
    const machineId = this.getMachineId();

    // Se já está pago/ativado, volta tudo ok
    if (data.status === 'active') {
      return { valid: true, type: 'licensed', daysLeft: 999, machineId };
    }

    // Cálculo de dias restantes
    const start = new Date(data.installDate);
    const now = new Date();
    const diffTime = Math.abs(now - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
    
    const TRIAL_DAYS = 7; // <-- AQUI VOCÊ DEFINE O PRAZO (7 dias)
    const daysLeft = TRIAL_DAYS - diffDays;

    if (daysLeft >= 0) {
      return { valid: true, type: 'trial', daysLeft, machineId };
    } else {
      return { valid: false, type: 'expired', machineId };
    }
  }

  // Tenta ativar com a chave digitada
  activate(key) {
    const machineId = this.getMachineId();
    const expectedKey = this.generateKey(machineId);
    
    if (key === expectedKey) {
      const data = this.getData();
      data.status = 'active';
      data.activatedAt = new Date().toISOString();
      this.saveData(data);
      return true;
    }
    return false;
  }

  // Gera a chave correta para um ID de máquina (Use isso no seu celular depois)
  generateKey(machineId) {
    const raw = `${machineId}::${SECRET_SALT}`;
    const hash = crypto.createHash('md5').update(raw).digest('hex');
    // Formato: XXXX-XXXX-XXXX-XXXX
    return hash.substring(0, 16).match(/.{1,4}/g).join('-').toUpperCase();
  }
}

module.exports = new LicenseManager();