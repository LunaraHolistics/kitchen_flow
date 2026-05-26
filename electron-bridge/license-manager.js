/**
 * Kitchen Flow Bridge - License Manager v2.1.2
 * Features: Trial configurável, planos mensais/semestrais/anuais, modo desenvolvedor
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================

const LICENSE_FILE = path.join(app.getPath('userData'), 'license.dat');
const CONFIG_FILE = path.join(app.getPath('userData'), 'license-config.json');

// ← PERÍODO DE TRIAL CONFIGURÁVEL (em dias)
// Altere aqui para estender o trial sem criar chave
const DEFAULT_TRIAL_DAYS = process.env.KFM_TRIAL_DAYS 
  ? parseInt(process.env.KFM_TRIAL_DAYS) 
  : 30; // ← Mude para 7, 15, 30, 60 conforme necessário

// ← MODO DESENVOLVEDOR (pula verificação de licença)
// Use apenas para testes internos!
const DEV_MODE = process.env.KFM_DEV_MODE === 'true';

// ← PLANOS DISPONÍVEIS
const PLANS = {
  monthly:   { days: 30,   name: 'Mensal',   price: 119.90 },
  semiannual:{ days: 180,  name: 'Semestral',price: 659.90 }, // 10% desconto
  annual:    { days: 365,  name: 'Anual',    price: 1199.90 } // 17% desconto
};

// ============================================================================
// FUNÇÕES AUXILIARES
// ============================================================================

function log(msg) {
  console.log(`[License] ${msg}`);
}

function getFileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function getMachineId() {
  // ID único baseado em: caminho do app + hostname (simplificado)
  const base = `${app.getAppPath()}_${require('os').hostname()}`;
  return crypto.createHash('md5').update(base).digest('hex').slice(0, 16);
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('pt-BR');
}

function daysUntil(expirationDate) {
  const now = new Date();
  const exp = new Date(expirationDate);
  const diff = exp - now;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ============================================================================
// CARREGAR/SALVAR CONFIGURAÇÃO LOCAL
// ============================================================================

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    log(`Erro ao carregar config: ${e.message}`);
  }
  return { trialStart: null, extended: false };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    log(`Erro ao salvar config: ${e.message}`);
    return false;
  }
}

// ============================================================================
// VALIDAÇÃO DE LICENÇA
// ============================================================================

function checkStatus() {
  // ← MODO DESENVOLVEDOR: sempre válido
  if (DEV_MODE) {
    log('⚙️ DEV MODE: Licença bypassada');
    return {
      valid: true,
      type: 'dev',
      machineId: getMachineId(),
      message: 'Modo desenvolvedor ativo'
    };
  }

  const machineId = getMachineId();
  const config = loadConfig();

  // 1. Verificar licença ativa
  if (fs.existsSync(LICENSE_FILE)) {
    try {
      const license = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
      
      // Validar assinatura (simples)
      const expectedSig = crypto
        .createHmac('sha256', license.secret || 'kfm-secret')
        .update(`${license.machineId}:${license.plan}:${license.expires}`)
        .digest('hex');
      
      if (license.signature !== expectedSig) {
        log('❌ Assinatura da licença inválida');
        return { valid: false, type: 'invalid', machineId };
      }

      // Validar máquina
      if (license.machineId !== machineId) {
        log(`❌ Licença de outra máquina: ${license.machineId}`);
        return { valid: false, type: 'wrong_machine', machineId };
      }

      // Validar expiração
      const expires = new Date(license.expires);
      const now = new Date();
      
      if (now > expires) {
        log(`❌ Licença expirada em ${formatDate(license.expires)}`);
        return {
          valid: false,
          type: 'expired',
          machineId,
          expiredAt: license.expires,
          daysOverdue: daysUntil(license.expires) * -1
        };
      }

      // ✅ Licença válida
      const plan = PLANS[license.plan] || PLANS.monthly;
      return {
        valid: true,
        type: license.plan,
        machineId,
        plan: plan.name,
        expires: license.expires,
        daysLeft: daysUntil(license.expires),
        message: `Licença ${plan.name} válida até ${formatDate(license.expires)}`
      };

    } catch (e) {
      log(`Erro ao ler licença: ${e.message}`);
    }
  }

  // 2. Verificar trial
  const trialStart = config.trialStart ? new Date(config.trialStart) : new Date();
  const trialEnd = new Date(trialStart);
  trialEnd.setDate(trialEnd.getDate() + DEFAULT_TRIAL_DAYS);
  const now = new Date();

  if (now <= trialEnd) {
    // ← Salvar início do trial se for primeira vez
    if (!config.trialStart) {
      config.trialStart = trialStart.toISOString();
      saveConfig(config);
      log(`🧪 Trial iniciado: ${DEFAULT_TRIAL_DAYS} dias`);
    }

    const daysLeft = daysUntil(trialEnd);
    return {
      valid: true,
      type: 'trial',
      machineId,
      trialStart: config.trialStart,
      trialEnd: trialEnd.toISOString(),
      daysLeft,
      message: `Modo teste: ${daysLeft} dia(s) restante(s)`
    };
  }

  // 3. Trial expirado
  log(`❌ Trial expirado há ${daysUntil(trialEnd) * -1} dia(s)`);
  return {
    valid: false,
    type: 'trial_expired',
    machineId,
    trialEnd: trialEnd.toISOString(),
    daysOverdue: daysUntil(trialEnd) * -1,
    message: 'Período de teste expirado'
  };
}

// ============================================================================
// GERAR LICENÇA (APÓS COMPRA)
// ============================================================================

/**
 * Gera uma chave de licença para o cliente
 * @param {string} plan - 'monthly' | 'semiannual' | 'annual'
 * @param {string} clientEmail - Email do cliente (para registro)
 * @param {string} secret - Chave secreta para assinar a licença (guarde em local seguro!)
 * @returns {object} Dados da licença para enviar ao cliente
 */
function generateLicenseKey(plan, clientEmail, secret = 'kfm-secret-prod') {
  const planConfig = PLANS[plan];
  if (!planConfig) {
    throw new Error(`Plano inválido: ${plan}. Use: ${Object.keys(PLANS).join(', ')}`);
  }

  const machineId = 'CLIENT_MACHINE_ID'; // ← Substituir pelo ID real do cliente
  const issuedAt = new Date().toISOString();
  const expires = new Date();
  expires.setDate(expires.getDate() + planConfig.days);

  // Assinar licença
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${machineId}:${plan}:${expires.toISOString()}`)
    .digest('hex');

  const license = {
    version: '2.1.2',
    clientEmail,
    machineId,
    plan,
    planName: planConfig.name,
    price: planConfig.price,
    issuedAt,
    expires: expires.toISOString(),
    signature,
    secret: secret.slice(0, 8) + '...' // Apenas para referência, não exponha a chave real
  };

  log(`✅ Licença gerada: ${planConfig.name} para ${clientEmail}`);
  log(`   Expires: ${formatDate(expires)} (${planConfig.days} dias)`);
  
  return license;
}

// ============================================================================
// ATIVAR LICENÇA (NO APP DO CLIENTE)
// ============================================================================

/**
 * Ativa uma licença recebida do cliente
 * @param {object} licenseData - Objeto da licença (JSON)
 * @returns {object} Resultado da ativação
 */
function activateLicense(licenseData) {
  try {
    // Validar estrutura mínima
    if (!licenseData?.machineId || !licenseData?.plan || !licenseData?.expires || !licenseData?.signature) {
      return { success: false, error: 'Licença inválida: dados incompletos' };
    }

    // Revalidar assinatura
    const secret = 'kfm-secret-prod'; // ← Mesma chave usada em generateLicenseKey
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${licenseData.machineId}:${licenseData.plan}:${licenseData.expires}`)
      .digest('hex');
    
    if (licenseData.signature !== expectedSig) {
      return { success: false, error: 'Assinatura da licença inválida' };
    }

    // Validar máquina atual
    const currentMachineId = getMachineId();
    if (licenseData.machineId !== 'CLIENT_MACHINE_ID' && licenseData.machineId !== currentMachineId) {
      // ← Em produção, descomente a linha abaixo para travar na máquina:
      // return { success: false, error: 'Licença válida para outra máquina' };
      log('⚠️ Licença de outra máquina (modo flexível)');
    }

    // Validar expiração
    const expires = new Date(licenseData.expires);
    if (new Date() > expires) {
      return { success: false, error: `Licença expirada em ${formatDate(licenseData.expires)}` };
    }

    // Salvar licença
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2), 'utf8');
    
    // Limpar config de trial
    const config = loadConfig();
    config.activated = true;
    saveConfig(config);

    log(`✅ Licença ativada: ${licenseData.planName} até ${formatDate(expires)}`);
    
    return {
      success: true,
      plan: licenseData.planName,
      expires: licenseData.expires,
      daysLeft: daysUntil(licenseData.expires),
      message: `Licença ${licenseData.planName} ativada com sucesso!`
    };

  } catch (e) {
    log(`Erro ao ativar licença: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// EXTENDER TRIAL (SEM CRIAR LICENÇA)
// ============================================================================

/**
 * Estende o período de trial manualmente
 * USE APENAS PARA TESTES INTERNOS OU CLIENTES ESPECIAIS
 * @param {number} extraDays - Dias adicionais para adicionar ao trial
 * @returns {object} Resultado da extensão
 */
function extendTrial(extraDays = 7) {
  if (DEV_MODE) {
    return { success: true, message: 'DEV MODE: Trial já é infinito' };
  }

  const config = loadConfig();
  
  // Calcular nova data de término
  const currentEnd = config.trialStart 
    ? new Date(config.trialStart) 
    : new Date();
    
  currentEnd.setDate(currentEnd.getDate() + DEFAULT_TRIAL_DAYS + extraDays);
  
  // Salvar extensão
  config.trialEndExtended = currentEnd.toISOString();
  config.extended = true;
  config.extensionReason = `Extendido manualmente em ${new Date().toISOString()}`;
  
  if (saveConfig(config)) {
    log(`🧪 Trial estendido em ${extraDays} dias (até ${formatDate(currentEnd)})`);
    return {
      success: true,
      newEnd: currentEnd.toISOString(),
      daysLeft: daysUntil(currentEnd),
      message: `Trial estendido até ${formatDate(currentEnd)}`
    };
  }
  
  return { success: false, error: 'Falha ao salvar extensão' };
}

// ============================================================================
// RESETAR LICENÇA (PARA TESTES)
// ============================================================================

function resetLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    log('🔄 Licença e config resetadas');
    return { success: true };
  } catch (e) {
    log(`Erro ao resetar: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Validação
  checkStatus,
  
  // Geração e ativação
  generateLicenseKey,
  activateLicense,
  
  // Gestão de trial
  extendTrial,
  
  // Utilitários
  resetLicense,
  getPlans: () => PLANS,
  getDefaultTrialDays: () => DEFAULT_TRIAL_DAYS,
  
  // Config
  DEV_MODE,
  LICENSE_FILE,
  CONFIG_FILE
};