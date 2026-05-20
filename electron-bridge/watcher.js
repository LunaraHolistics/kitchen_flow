const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

class FileWatcher {
  constructor(watchPath, options = {}) {
    this.watchPath = watchPath;
    this.backupPath = path.join(process.env.USERPROFILE || 'C:\\', 'KitchenFlow', 'backup');
    
    // Criar pasta de backup se não existir
    if (!fs.existsSync(this.backupPath)) {
      fs.mkdirSync(this.backupPath, { recursive: true });
      console.log(`📁 Pasta de backup criada: ${this.backupPath}`);
    }

    this.options = {
      ignored: [],
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { 
        stabilityThreshold: 50,
        pollInterval: 20 
      },
      depth: 0,
      usePolling: true,
      ...options
    };
    
    this.watcher = null;
    this.processedFiles = new Map(); // Map<filePath, timestamp>
    this.onNewFile = options.onNewFile || (() => {});
    this.isActive = false;
    
    this.start();
  }
  
  start() {
    if (this.isActive) return;
    
    console.log(`🔍 Watcher iniciando em: ${this.watchPath}`);
    
    if (!fs.existsSync(this.watchPath)) {
      console.error(`❌ PASTA NÃO EXISTE: ${this.watchPath}`);
      console.log(`💡 Dica: Verifique se o Saipos está baixando em ${this.watchPath}`);
      return;
    }
    
    this.watcher = chokidar.watch(this.watchPath, this.options);
    
    this.watcher
      .on('all', (event, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        const fileName = path.basename(filePath);
        const now = Date.now();
        
        // Logar eventos para debug (apenas add/change em .saiposprt)
        if ((event === 'add' || event === 'change') && ext === '.saiposprt') {
          console.log(`📡 EVENTO: ${event} | ${fileName} | Size: ${fs.statSync(filePath)?.size || 0} bytes`);
          
          // Evitar processar o mesmo arquivo múltiplas vezes (debounce de 2s)
          const lastProcessed = this.processedFiles.get(filePath);
          if (lastProcessed && (now - lastProcessed) < 2000) {
            console.log(`⏭️ Ignorando duplicata: ${fileName}`);
            return;
          }
          
          this.processedFiles.set(filePath, now);
          
          // Limpar entry antiga após 10s
          setTimeout(() => this.processedFiles.delete(filePath), 10000);
          
          console.log(`🎯 MATCH! Processando: ${fileName}`);
          
          // CHAMAR HANDLER
          this.onNewFile(filePath, 'watcher').catch(err => {
            console.error('❌ Erro no handler:', err.message);
          });
        }
      })
      .on('error', (error) => {
        console.error('❌ Watcher error:', error);
        this.isActive = false;
      })
      .on('ready', () => {
        this.isActive = true;
        console.log(`✅ WATCHER PRONTO | Monitorando: ${this.watchPath} | Extensão: .saiposprt`);
      });
  }
  
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.isActive = false;
      this.processedFiles.clear();
      console.log('🛑 Watcher parado');
    }
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
  
  // Método para verificar se arquivo já foi processado recentemente
  wasRecentlyProcessed(filePath, windowMs = 2000) {
    const lastTime = this.processedFiles.get(filePath);
    return lastTime && (Date.now() - lastTime) < windowMs;
  }
}

module.exports = FileWatcher;