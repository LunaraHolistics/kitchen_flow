const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

class FileWatcher {
  constructor(watchPath, options = {}) {
    this.watchPath = watchPath;
    this.options = {
      ignored: /(^|[\/\\])\../, // Ignorar arquivos ocultos
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { 
        stabilityThreshold: 1000, // Aguardar 1s para arquivo estar pronto
        pollInterval: 100 
      },
      depth: 0, // Só monitorar a pasta raiz
      ...options
    };
    
    this.watcher = null;
    this.processed = new Set(); // Evitar processar duplicatas
    this.onNewFile = options.onNewFile || (() => {});
    this.isActive = false;
    
    this.start();
  }
  
  start() {
    if (this.isActive) return;
    
    // Criar pasta se não existir (para testes)
    if (!fs.existsSync(this.watchPath)) {
      console.warn(`⚠️ Pasta não existe: ${this.watchPath}`);
      return;
    }
    
    this.watcher = chokidar.watch(this.watchPath, this.options);
    
    this.watcher
      .on('add', (filePath) => {
        // Ignorar se já processado
        if (this.processed.has(filePath)) return;
        
        // Só processar extensão específica
        if (path.extname(filePath).toLowerCase() !== '.saiposnfeprt') return;
        
        console.log(`📥 Novo arquivo: ${path.basename(filePath)}`);
        this.processed.add(filePath);
        
        // Chamar handler (pode ser async)
        Promise.resolve(this.onNewFile(filePath))
          .catch(err => console.error('❌ Handler error:', err));
      })
      .on('error', (error) => {
        console.error('❌ Watcher error:', error);
      })
      .on('ready', () => {
        this.isActive = true;
        console.log(`✅ Watcher ativo: ${this.watchPath}`);
      });
  }
  
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.isActive = false;
      console.log('🛑 Watcher parado');
    }
  }
  
  // Método para testes: cria um arquivo fake
  triggerTest() {
    const testFile = path.join(
      this.watchPath, 
      `test_${Date.now()}.saiposnfeprt`
    );
    
    try {
      fs.writeFileSync(testFile, 'SAIPOS_MOCK_DATA');
      console.log(`🧪 Arquivo de teste criado: ${testFile}`);
      return testFile;
    } catch(e) {
      console.error('❌ Falha ao criar teste:', e.message);
      return null;
    }
  }
  
  // Resetar cache de processados (para reprocessar)
  resetProcessed() {
    this.processed.clear();
    console.log('🔄 Cache de processados limpo');
  }
}

module.exports = FileWatcher;