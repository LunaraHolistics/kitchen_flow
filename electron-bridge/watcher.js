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
      ignored: [], // Não ignorar nada inicialmente
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { 
        stabilityThreshold: 50, // Muito rápido para capturar arquivos efêmeros
        pollInterval: 20 
      },
      depth: 0,
      usePolling: true, // Mais confiável no Windows para arquivos rápidos
      ...options
    };
    
    this.watcher = null;
    this.processedFiles = new Set();
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
        
        // Logar tudo para debug
        if (event === 'add' || event === 'change') {
          console.log(`📡 EVENTO: ${event} | ${fileName} | Ext: ${ext}`);
          
          // Filtrar apenas .saiposprt
          if (ext === '.saiposprt') {
            // Evitar processar o mesmo arquivo múltiplas vezes
            if (this.processedFiles.has(filePath)) return;
            this.processedFiles.add(filePath);
            
            // Limpar cache após 10s
            setTimeout(() => this.processedFiles.delete(filePath), 10000);
            
            console.log(`🎯 MATCH! Capturando: ${fileName}`);
            
            // CHAMAR HANDLER (que fará o backup imediato)
            this.onNewFile(filePath).catch(err => {
              console.error('❌ Erro no handler:', err.message);
            });
          }
        }
      })
      .on('error', (error) => console.error('❌ Watcher error:', error))
      .on('ready', () => {
        this.isActive = true;
        console.log('✅ WATCHER PRONTO E MONITORANDO .saiposprt...');
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
    const testFile = path.join(this.watchPath, `test_${Date.now()}.saiposprt`);
    try {
      // Simular conteúdo Base64 real
      const dummyData = JSON.stringify([{printRows: ["<n>1 Teste de Sistema</n>"]}]);
      const base64 = Buffer.from(dummyData).toString('base64');
      fs.writeFileSync(testFile, base64);
      console.log(` Arquivo de teste criado: ${testFile}`);
      return testFile;
    } catch(e) {
      console.error('❌ Falha ao criar teste:', e.message);
      return null;
    }
  }
}

module.exports = FileWatcher;