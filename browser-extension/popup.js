// Elementos DOM
const downloadPathEl = document.getElementById('downloadPath')
const historyListEl = document.getElementById('historyList')
const changePathBtn = document.getElementById('changePathBtn')
const clearHistoryBtn = document.getElementById('clearHistoryBtn')
const testBtn = document.getElementById('testBtn')
const refreshBtn = document.getElementById('refreshBtn')
const autoClearOnStartupEl = document.getElementById('autoClearOnStartup')
const autoClearOnCloseEl = document.getElementById('autoClearOnClose')

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  loadConfig()
  loadHistory()
  setupEventListeners()
})

// Carregar configurações
function loadConfig() {
  chrome.runtime.sendMessage({ action: 'getConfig' }, (response) => {
    if (response) {
      downloadPathEl.textContent = response.downloadPath || 'Não configurada'
      autoClearOnStartupEl.checked = response.autoClearOnStartup || false
      autoClearOnCloseEl.checked = response.autoClearOnClose || false
    }
  })
}

// Carregar histórico
function loadHistory() {
  chrome.runtime.sendMessage({ action: 'getHistory' }, (history) => {
    renderHistory(history || [])
  })
}

// Renderizar histórico
function renderHistory(history) {
  if (history.length === 0) {
    historyListEl.innerHTML = '<div class="empty">Nenhum arquivo capturado ainda</div>'
    return
  }

  const html = history.map(item => {
    const date = new Date(item.timestamp)
    const timeStr = date.toLocaleTimeString('pt-BR', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit'
    })
    
    return `
      <div class="history-item ${item.status}">
        <div class="history-filename">${escapeHtml(item.filename)}</div>
        <div class="history-time">🕐 ${timeStr} - ${item.status === 'success' ? '✅ Sucesso' : '❌ Erro'}</div>
        ${item.path ? `<div class="history-path">📁 ${escapeHtml(item.path)}</div>` : ''}
      </div>
    `
  }).join('')

  historyListEl.innerHTML = html
}

// Configurar event listeners
function setupEventListeners() {
  // Alterar pasta
  changePathBtn.addEventListener('click', async () => {
    try {
      // Simula seleção de pasta (em produção, usaria file picker nativo)
      const newPath = prompt('Digite o caminho da pasta de downloads:', downloadPathEl.textContent)
      
      if (newPath && newPath.trim()) {
        await saveConfig({ downloadPath: newPath.trim() })
        downloadPathEl.textContent = newPath.trim()
        showNotification('Pasta atualizada com sucesso!', 'success')
      }
    } catch (error) {
      showNotification('Erro ao alterar pasta: ' + error.message, 'error')
    }
  })

  // Limpar histórico
  clearHistoryBtn.addEventListener('click', async () => {
    if (confirm('Deseja limpar todo o histórico?')) {
      await chrome.runtime.sendMessage({ action: 'clearHistory' })
      loadHistory()
      showNotification('Histórico limpo!', 'success')
    }
  })

  // Testar captura
  testBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'testDownload' })
    loadHistory()
  })

  // Atualizar
  refreshBtn.addEventListener('click', () => {
    loadConfig()
    loadHistory()
    showNotification('Atualizado!', 'success')
  })

  // Auto-clear on startup
  autoClearOnStartupEl.addEventListener('change', async () => {
    await saveConfig({ autoClearOnStartup: autoClearOnStartupEl.checked })
  })

  // Auto-clear on close
  autoClearOnCloseEl.addEventListener('change', async () => {
    await saveConfig({ autoClearOnClose: autoClearOnCloseEl.checked })
  })
}

// Salvar configuração
function saveConfig(config) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'setConfig', ...config }, (response) => {
      if (response && response.success) {
        resolve(response)
      } else {
        reject(new Error('Falha ao salvar configuração'))
      }
    })
  })
}

// Mostrar notificação
function showNotification(message, type = 'info') {
  // Cria elemento temporário
  const notif = document.createElement('div')
  notif.textContent = message
  notif.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: ${type === 'success' ? '#00d9a5' : type === 'error' ? '#dc2626' : '#e94560'};
    color: white;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    z-index: 1000;
    animation: slideDown 0.3s ease;
  `
  
  document.body.appendChild(notif)
  
  setTimeout(() => {
    notif.remove()
  }, 3000)
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// Adicionar animação CSS
const style = document.createElement('style')
style.textContent = `
  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translate(-50%, -20px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
`
document.head.appendChild(style)