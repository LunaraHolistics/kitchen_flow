// Configurações padrão
const DEFAULT_DOWNLOAD_PATH = 'C:\\Users\\Na Fazenda\\Downloads'
const MAX_HISTORY = 50

// Estado inicial
let downloadPath = DEFAULT_DOWNLOAD_PATH
let autoClearOnStartup = false
let autoClearOnClose = false

// Carregar configurações salvas ao iniciar
chrome.storage.local.get(['downloadPath', 'history', 'autoClearOnStartup', 'autoClearOnClose'], (result) => {
  if (result.downloadPath) {
    downloadPath = result.downloadPath
  }
  
  if (result.autoClearOnStartup !== undefined) {
    autoClearOnStartup = result.autoClearOnStartup
  }
  
  if (result.autoClearOnClose !== undefined) {
    autoClearOnClose = result.autoClearOnClose
  }
  
  // Limpar histórico ao iniciar se configurado
  if (autoClearOnStartup && result.history && result.history.length > 0) {
    clearHistory()
    console.log(' Histórico limpo automaticamente ao iniciar')
  }
  
  console.log('🍳 KitchenFlow Monitor iniciado')
  console.log('📁 Pasta configurada:', downloadPath)
})

// Intercepta todos os downloads
chrome.downloads.onCreated.addListener((downloadItem) => {
  console.log('📥 Download detectado:', downloadItem.filename)
  
  // Verifica se é arquivo .saiposprt
  if (downloadItem.filename && downloadItem.filename.toLowerCase().endsWith('.saiposprt')) {
    handleSaiposprtDownload(downloadItem)
  }
})

// Função para lidar com arquivos .saiposprt
function handleSaiposprtDownload(downloadItem) {
  const filename = downloadItem.filename.split(/[\\/]/).pop()
  const timestamp = new Date().toISOString()
  
  console.log('🎯 Arquivo de pedido detectado:', filename)
  
  // Cancela o download original
  chrome.downloads.cancel(downloadItem.id, () => {
    if (chrome.runtime.lastError) {
      console.error('Erro ao cancelar download:', chrome.runtime.lastError)
    }
    
    // Faz download para a pasta configurada
    const targetPath = `${downloadPath}\\${filename}`
    
    chrome.downloads.download({
      url: downloadItem.url,
      filename: targetPath,
      conflictAction: 'uniquify',
      saveAs: false
    }, (newDownloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Erro ao redirecionar download:', chrome.runtime.lastError)
        addToHistory(filename, 'error', `Erro: ${chrome.runtime.lastError.message}`, timestamp)
        showNotification('Erro ao capturar pedido', filename)
      } else {
        console.log('✅ Download redirecionado para:', targetPath)
        addToHistory(filename, 'success', targetPath, timestamp)
        showNotification('Pedido capturado com sucesso!', filename)
        
        // Notifica o Bridge (se estiver rodando)
        notifyBridge(filename, targetPath)
      }
    })
  })
}

// Adiciona ao histórico
function addToHistory(filename, status, path, timestamp) {
  chrome.storage.local.get(['history'], (result) => {
    const history = result.history || []
    
    history.unshift({
      filename,
      status,
      path,
      timestamp,
      id: Date.now()
    })
    
    // Mantém apenas os últimos MAX_HISTORY
    if (history.length > MAX_HISTORY) {
      history.splice(MAX_HISTORY)
    }
    
    chrome.storage.local.set({ history }, () => {
      console.log('📋 Histórico atualizado:', history.length, 'itens')
      
      // Atualiza badge
      const errorCount = history.filter(h => h.status === 'error').length
      if (errorCount > 0) {
        chrome.action.setBadgeText({ text: errorCount.toString() })
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
      } else {
        chrome.action.setBadgeText({ text: '' })
      }
    })
  })
}

// Mostra notificação
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title,
    message: message,
    priority: 2,
    requireInteraction: false
  })
}

// Notifica o Bridge (comunicação nativa)
function notifyBridge(filename, path) {
  // Envia mensagem para o Bridge via native messaging (se configurado)
  // Ou via porta local (localhost:4545)
  fetch('http://localhost:4545/api/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename,
      path,
      timestamp: new Date().toISOString()
    })
  }).catch(err => {
    console.log('⚠️  Bridge não respondendo em localhost:4545', err.message)
  })
}

// Limpa histórico
function clearHistory() {
  chrome.storage.local.set({ history: [] }, () => {
    chrome.action.setBadgeText({ text: '' })
    console.log('🧹 Histórico limpo')
  })
}

// Listener para mensagens do popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getHistory') {
    chrome.storage.local.get(['history'], (result) => {
      sendResponse(result.history || [])
    })
    return true
  }
  
  if (message.action === 'clearHistory') {
    clearHistory()
    sendResponse({ success: true })
    return true
  }
  
  if (message.action === 'getConfig') {
    sendResponse({
      downloadPath,
      autoClearOnStartup,
      autoClearOnClose
    })
    return true
  }
  
  if (message.action === 'setConfig') {
    if (message.downloadPath) {
      downloadPath = message.downloadPath
    }
    if (message.autoClearOnStartup !== undefined) {
      autoClearOnStartup = message.autoClearOnStartup
    }
    if (message.autoClearOnClose !== undefined) {
      autoClearOnClose = message.autoClearOnClose
    }
    
    chrome.storage.local.set({
      downloadPath,
      autoClearOnStartup,
      autoClearOnClose
    }, () => {
      sendResponse({ success: true })
    })
    return true
  }
  
  if (message.action === 'testDownload') {
    // Simula um download de teste
    const testFilename = `teste_${Date.now()}.saiposprt`
    addToHistory(testFilename, 'success', downloadPath + '\\' + testFilename, new Date().toISOString())
    showNotification('Teste de captura', 'Extensão funcionando corretamente!')
    sendResponse({ success: true })
    return true
  }
})

// Limpar histórico ao fechar o navegador (se configurado)
if (autoClearOnClose) {
  window.addEventListener('beforeunload', () => {
    clearHistory()
  })
}

console.log('✅ KitchenFlow Monitor - Background Service Worker ativo')