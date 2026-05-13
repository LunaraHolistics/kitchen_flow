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
        stabilityThreshold: 500,
        pollInterval: 100
      },
      ...options
    };
    
    this.watcher = null;
    this.processedFiles = new Set();
    this.onNewFile = options.onNewFile || (() => {});
    
    this.start();
  }
  
  start() {
    // Verificar se pasta existe
    if (!fs.existsSync(this.watchPath)) {
      console.error(`⚠️ Pasta de monitoramento não existe: ${this.watchPath}`);
      console.log('💡 Criando pasta para testes...');
      fs.mkdirSync(this.watchPath, { recursive: true });
    }
    
    this.watcher = chokidar.watch(this.watchPath, this.options);
    
    this.watcher
      .on('add', (filePath) => this.handleNewFile(filePath))
      .on('error', (error) => this.handleError(error))
      .on('ready', () => {
        console.log(`✅ Watcher ativo: ${this.watchPath}`);
        console.log(`📁 Monitorando arquivos .saiposnfeprt`);
      });
  }
  
  handleNewFile(filePath) {
    // Ignorar se já processado
    if (this.processedFiles.has(filePath)) {
      return;
    }
    
    // Validar extensão
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.saiposnfeprt') {
      return;
    }
    
    console.log(`📥 Novo arquivo: ${path.basename(filePath)}`);
    this.processedFiles.add(filePath);
    
    // Chamar callback
    if (typeof this.onNewFile === 'function') {
      this.onNewFile(filePath).catch(err => {
        console.error('❌ Erro no handler onNewFile:', err);
      });
    }
  }
  
  handleError(error) {
    console.error('❌ Erro no watcher:', error);
  }
  
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('🛑 Watcher parado');
    }
  }
  
  // Método para testar manualmente (dev)
  triggerTestFile() {
    const testPath = path.join(this.watchPath, `test_${Date.now()}.saiposnfeprt`);
    fs.writeFileSync(testPath, 'SAIPOS_MOCK_DATA');
    console.log(`🧪 Arquivo de teste criado: ${testPath}`);
    return testPath;
  }
}

module.exports = FileWatcher;