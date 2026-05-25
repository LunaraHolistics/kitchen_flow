const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class FileWatcher {
  constructor(watchPath, options = {}) {
    this.watchPath = watchPath;
    this.backupPath = path.join(process.env.USERPROFILE || 'C:\\', 'KitchenFlow', 'backup');
    
    // Criar pasta de backup se não existir
    if (!fs.existsSync(this.backupPath)) {
      try {
        fs.mkdirSync(this.backupPath, { recursive: true });
        console.log(`📁 Pasta de backup criada: ${this.backupPath}`);
      } catch (e) {
        console.error(`❌ Falha ao criar pasta de backup: ${e.message}`);
      }
    }

    this.options = {
      ignored: [],
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { 
        stabilityThreshold: 100, // ← Aumentado para arquivos que demoram a escrever
        pollInterval: 50         // ← Polling mais frequente para capturar arquivos rápidos
      },
      depth: 0,
      usePolling: true,          // ← Essencial no Windows para arquivos efêmeros
      ignorePermissionErrors: true,
      ...options
    };
    
    this.watcher = null;
    
    // ← CORREÇÃO: Tracking aprimorado com hash + timestamp
    this.processedFiles = new Map(); // Map<hash, {path, timestamp, size}>
    
    this.onNewFile = options.onNewFile || (() => {});
    this.isActive = false;
    
    // Contadores para diagnóstico
    this.stats = {
      totalDetected: 0,
      totalProcessed: 0,
      totalErrors: 0,
      antivirusBlocks: 0
    };
    
    this.start();
  }
  
  // ← NOVO: Gerar hash simples para identificar arquivo único
  _getFileHash(filePath, size) {
    const base = `${path.basename(filePath)}_${size}_${path.dirname(filePath)}`;
    return crypto.createHash('md5').update(base).digest('hex').slice(0, 12);
  }
  
  // ← NOVO: Verificar se arquivo é válido para processamento
  _isValidFile(filePath) {
    try {
      // Verificar existência
      if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ Arquivo não existe mais: ${path.basename(filePath)}`);
        return { valid: false, reason: 'not_found' };
      }
      
      // Verificar tamanho (arquivos .saiposprt devem ter pelo menos 100 bytes)
      const stats = fs.statSync(filePath);
      if (stats.size < 100) {
        console.warn(`⚠️ Arquivo muito pequeno (${stats.size} bytes): ${path.basename(filePath)}`);
        return { valid: false, reason: 'too_small' };
      }
      
      // Verificar extensão
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.saiposprt') {
        return { valid: false, reason: 'wrong_extension' };
      }
      
      return { valid: true, size: stats.size };
    } catch (e) {
      console.warn(`⚠️ Erro ao validar arquivo: ${e.message}`);
      return { valid: false, reason: 'validation_error', error: e.message };
    }
  }
  
  // ← NOVO: Verificar se arquivo já foi processado (debounce aprimorado)
  _wasRecentlyProcessed(filePath, size, windowMs = 3000) {
    const hash = this._getFileHash(filePath, size);
    const entry = this.processedFiles.get(hash);
    const now = Date.now();
    
    if (entry) {
      // Mesmo arquivo, mesmo tamanho, dentro da janela de tempo = duplicata
      if (entry.path === filePath && entry.size === size && (now - entry.timestamp) < windowMs) {
        console.log(`⏭️ Ignorando duplicata (hash:${hash.slice(0,6)}): ${path.basename(filePath)}`);
        return true;
      }
      // Mesmo hash mas caminho diferente = arquivo movido/copiado, permitir
      if (entry.path !== filePath) {
        console.log(`📁 Arquivo movido: ${entry.path} → ${filePath}`);
      }
    }
    
    return false;
  }
  
  // ← NOVO: Registrar arquivo como processado
  _markAsProcessed(filePath, size) {
    const hash = this._getFileHash(filePath, size);
    this.processedFiles.set(hash, {
      path: filePath,
      size,
      timestamp: Date.now()
    });
    
    // Limpar entries antigas (mais de 30 segundos)
    const now = Date.now();
    for (const [h, entry] of this.processedFiles.entries()) {
      if (now - entry.timestamp > 30000) {
        this.processedFiles.delete(h);
      }
    }
  }
  
  // ← NOVO: Tentar acessar arquivo com retry para antivírus
  async _safeFileAccess(filePath, operation, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        const errorCode = err.code || 'UNKNOWN';
        
        // Códigos que podem ser causados por antivírus
        const antivirusCodes = ['ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'EMFILE'];
        
        if (antivirusCodes.includes(errorCode) && attempt < maxRetries) {
          console.warn(`⚠️ Tentativa ${attempt}/${maxRetries} falhou (${errorCode}), aguardando...`);
          // Backoff exponencial: 200ms, 400ms, 800ms
          await new Promise(resolve => setTimeout(resolve, 200 * Math.pow(2, attempt - 1)));
          continue;
        }
        
        // Se não for código de antivírus ou esgotou tentativas, parar
        break;
      }
    }
    
    throw lastError;
  }
  
  start() {
    if (this.isActive) return;
    
    console.log(`🔍 Watcher iniciando em: ${this.watchPath}`);
    console.log(`📊 Config: polling=${this.options.usePolling}, stability=${this.options.awaitWriteFinish?.stabilityThreshold}ms`);
    
    if (!fs.existsSync(this.watchPath)) {
      console.error(`❌ PASTA NÃO EXISTE: ${this.watchPath}`);
      console.log(`💡 Dica: Verifique se o Saipos está baixando em ${this.watchPath}`);
      // ← CORREÇÃO: Tentar criar pasta como fallback
      try {
        fs.mkdirSync(this.watchPath, { recursive: true });
        console.log(`✅ Pasta criada: ${this.watchPath}`);
      } catch (e) {
        console.error(`❌ Falha ao criar pasta: ${e.message}`);
        return;
      }
    }
    
    this.watcher = chokidar.watch(this.watchPath, this.options);
    
    this.watcher
      .on('all', async (event, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        const fileName = path.basename(filePath);
        
        // Filtrar apenas eventos relevantes para .saiposprt
        if ((event === 'add' || event === 'change') && ext === '.saiposprt') {
          this.stats.totalDetected++;
          
          // ← CORREÇÃO: Validar arquivo antes de qualquer processamento
          const validation = this._isValidFile(filePath);
          if (!validation.valid) {
            console.warn(`⚠️ Arquivo inválido (${validation.reason}): ${fileName}`);
            
            if (validation.reason === 'not_found') {
              this.stats.antivirusBlocks++;
              console.error('🛡️ Possível bloqueio por antivírus detectado!');
              console.error('💡 Sugestão: Adicionar exclusão para .saiposprt e pasta de downloads');
            }
            
            this.stats.totalErrors++;
            return;
          }
          
          const fileSize = validation.size;
          console.log(`📡 EVENTO: ${event} | ${fileName} | Size: ${fileSize} bytes`);
          
          // ← CORREÇÃO: Debounce aprimorado com hash
          if (this._wasRecentlyProcessed(filePath, fileSize)) {
            return;
          }
          
          // Marcar como processado ANTES de chamar handler (evita duplicatas se handler demorar)
          this._markAsProcessed(filePath, fileSize);
          
          console.log(`🎯 MATCH! Processando: ${fileName}`);
          
          try {
            // ← CORREÇÃO: Usar safeFileAccess para chamar handler
            await this._safeFileAccess(filePath, () => {
              return this.onNewFile(filePath, 'watcher');
            });
            
            this.stats.totalProcessed++;
            console.log(`✅ Processado: ${fileName} | Stats: ${this.stats.totalProcessed}/${this.stats.totalDetected}`);
            
          } catch (err) {
            this.stats.totalErrors++;
            const errorCode = err.code || 'UNKNOWN';
            
            console.error(`❌ Erro ao processar ${fileName}: ${err.message} [${errorCode}]`);
            
            // ← CORREÇÃO: Log específico para diagnóstico de antivírus
            if (['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(errorCode)) {
              this.stats.antivirusBlocks++;
              console.error('🛡️ ERRO COMPATÍVEL COM ANTIVÍRUS!');
              console.error('💡 Instruções para o usuário:');
              console.error('   1. Abrir configurações do antivírus');
              console.error(`   2. Adicionar exclusão para: ${this.watchPath}`);
              console.error('   3. Adicionar exclusão para extensão: .saiposprt');
              console.error('   4. Reiniciar o Kitchen Flow Bridge');
            }
            
            // Não propagar erro para não quebrar o watcher
          }
        }
      })
      .on('error', (error) => {
        console.error('❌ Watcher error:', error);
        this.stats.totalErrors++;
        this.isActive = false;
        
        // ← CORREÇÃO: Tentar reiniciar watcher após erro crítico
        setTimeout(() => {
          if (!this.isActive && this.watchPath) {
            console.log('🔄 Tentando reiniciar watcher...');
            this.start();
          }
        }, 5000);
      })
      .on('ready', () => {
        this.isActive = true;
        console.log(`✅ WATCHER PRONTO | Monitorando: ${this.watchPath} | Extensão: .saiposprt`);
        console.log(`📊 Stats iniciais: ${JSON.stringify(this.stats)}`);
      });
  }
  
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.isActive = false;
      this.processedFiles.clear();
      console.log('🛑 Watcher parado');
      console.log(`📊 Stats finais: ${JSON.stringify(this.stats)}`);
    }
  }
  
  // ← NOVO: Método para obter estatísticas de diagnóstico
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalDetected > 0 
        ? Math.round((this.stats.totalProcessed / this.stats.totalDetected) * 100) 
        : 0,
      active: this.isActive,
      watchPath: this.watchPath
    };
  }
  
  triggerTest() {
    const testFile = path.join(this.watchPath, `test_${Date.now()}.saiposprt`);
    try {
      // Simular conteúdo Base64 real do Saipos
      const dummyData = JSON.stringify([{
        printRows: [
          "<n>=== TESTE DO SISTEMA ===</n>",
          "<n>Mesa: 99</n>",
          "<n>1 Batata Frita</n>",
          "<n>1 Refrigerante</n>"
        ]
      }]);
      const base64 = Buffer.from(dummyData).toString('base64');
      fs.writeFileSync(testFile, base64);
      console.log(`🧪 Arquivo de teste criado: ${testFile}`);
      return testFile;
    } catch(e) {
      console.error('❌ Falha ao criar teste:', e.message);
      return null;
    }
  }
  
  // Método para verificar se arquivo já foi processado recentemente (público)
  wasRecentlyProcessed(filePath, windowMs = 2000) {
    // Para compatibilidade com código externo
    const stats = fs.statSync(filePath);
    return this._wasRecentlyProcessed(filePath, stats.size, windowMs);
  }
}

module.exports = FileWatcher;