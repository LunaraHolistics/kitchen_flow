const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

class FileWatcher {
  constructor(watchPath, options = {}) {
    this.watchPath = watchPath;
    this.options = {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { 
        stabilityThreshold: 1000,
        pollInterval: 100 
      },
      depth: 0,
      ...options
    };
    
    this.watcher = null;
    this.processed = new Set();
    this.onNewFile = options.onNewFile || (() => {});
    this.isActive = false;
    
    this.start();
  }
  
  start() {
    if (this.isActive) return;
    
    if (!fs.existsSync(this.watchPath)) {
      console.warn(`⚠️ Pasta não existe: ${this.watchPath}`);
      return;
    }
    
    this.watcher = chokidar.watch(this.watchPath, this.options);
    
    this.watcher
      .on('add', (filePath) => {
        if (this.processed.has(filePath)) return;
        if (path.extname(filePath).toLowerCase() !== '.saiposnfeprt') return;
        
        console.log(`📥 Novo: ${path.basename(filePath)}`);
        this.processed.add(filePath);
        
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
  
  triggerTest() {
    const testFile = path.join(this.watchPath, `test_${Date.now()}.saiposnfeprt`);
    try {
      fs.writeFileSync(testFile, 'SAIPOS_MOCK_DATA');
      console.log(`🧪 Teste criado: ${testFile}`);
      return testFile;
    } catch(e) {
      console.error('❌ Falha no teste:', e.message);
      return null;
    }
  }
  
  resetProcessed() {
    this.processed.clear();
    console.log('🔄 Cache limpo');
  }
}

module.exports = FileWatcher;