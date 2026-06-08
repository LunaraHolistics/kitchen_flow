/**
 * Kitchen Flow Monitor - Frontend Tablet v2.1.9
 * Deploy: https://cozinha-master.netlify.app
 * Backend: Configurável (local ou cloud)
 * Features: Prioridade Kids/Porção, observações em destaque, cache offline, controle por item, PWA reforçado
 * Hotfix: WebSocket + HTTP Polling automático + Fallbacks robustos + Delivery fix + iOS compat
 */
(() => {
  'use strict';

  // ============================================================================
  // CONFIGURAÇÃO INICIAL
  // ============================================================================

  const getBackendUrl = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlBackend = urlParams.get('backend');
    if (urlBackend && urlBackend.startsWith('http')) {
      console.log('Backend definido via URL:', urlBackend);
      return urlBackend;
    }

    const saved = localStorage.getItem('kfm_backend_url');
    if (saved && saved.startsWith('http')) {
      console.log('Backend carregado do localStorage:', saved);
      return saved;
    }

    const hostname = window.location.hostname;
    
    if (hostname.includes('netlify') || hostname.includes('vercel') || !hostname.includes('localhost')) {
      console.log('Ambiente cloud detectado. Usando fallback de IPs locais.');
      const localIps = [
        'http://192.168.0.100:4545',
        'http://192.168.1.100:4545',
        'http://10.0.0.100:4545',
        'http://localhost:4545'
      ];
      return localIps[0];
    }

    return 'http://localhost:4545';
  };

  const BACKEND_URL = getBackendUrl();
  const WS_URL = BACKEND_URL
    .replace('http://', 'ws://')
    .replace('https://', 'wss://');

  const TIMER_WARN_THRESHOLD = 300;
  const TIMER_CRITICAL_THRESHOLD = 600;

  console.log('Kitchen Flow v2.1.9');
  console.log('Frontend URL:', window.location.href);
  console.log('Backend:', BACKEND_URL);
  console.log('WebSocket:', WS_URL);

  const SECTORS = ['Frios', 'Saladas', 'Fritadeira', 'Entradas', 'Fogao', 'Sobremesas'];
  const PRIORITY_KEYWORDS = [
    'kids', 'infantil', 'crianca', 'batata', 'porcao', 'tirinhas', 'salada', 
    'entrada', 'frango', 'nugget', 'mini', 'pequeno'
  ];

  // ============================================================================
  // ESTADO GLOBAL
  // ============================================================================

  let ws = null;
  let clientId = null;
  let orders = [];
  let currentTab = 'geral';
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  let timerInterval = null;
  let soundEnabled = true;
  let isInitialized = false;
  let serverTimeOffset = 0;
  let lastTimeSync = 0;
  let useHttpPolling = false;
  let httpPollingInterval = null;
  let connectionRetryTimeout = null;
  let cancelAlert = null;

  // ← NOVO: Detectar iOS para ajustes de compatibilidade
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIOS) {
    console.log('iOS detectado - aplicando ajustes de compatibilidade');
  }

  // ============================================================================
  // SELETORES DOM
  // ============================================================================

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const els = {
    loadingOverlay: $('#loadingOverlay'),
    loadingStatus: $('#loadingStatus'),
    connStatus: $('#connStatus'),
    clock: $('#clock'),
    clientId: $('#clientId'),
    soundToggle: $('#soundToggle'),
    tabs: $$('.tab'),
    tabContents: $$('.tab-content'),
    badges: {
      geral: $('#badgeGeral'),
      setor: $('#badgeSetor'),
      concluidos: $('#badgeConcluidos')
    },
    ordersGeral: $('#ordersGeral'),
    sectorsWrap: $('#sectors'),
    completedList: $('#completed'),
    modal: $('#modal'),
    modalMsg: $('#modalMsg'),
    modalYes: $('#modalYes'),
    modalNo: $('#modalNo'),
    configPanel: $('#configPanel'),
    backendUrlInput: $('#backendUrl'),
    openConfig: $('#openConfig'),
    toggleConfig: $('#toggleConfig'),
    saveConfig: $('#saveConfig'),
    clearCompleted: $('#clearCompleted'),
    toasts: $('#toasts'),
    cancelBanner: $('#cancelBanner'),
    cancelMessage: $('#cancelMessage'),
    cancelClose: $('#cancelClose')
  };

  // ============================================================================
  // UTILITÁRIOS
  // ============================================================================

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2);
    return pad(m, 2) + ':' + pad(s, 2);
  }

  function pad(num, size) {
    let s = num + '';
    while (s.length < size) s = '0' + s;
    return s;
  }

  function getTimeClass(seconds) {
    if (seconds >= TIMER_CRITICAL_THRESHOLD) return 'critical';
    if (seconds >= TIMER_WARN_THRESHOLD) return 'high';
    return '';
  }

  function getWaitTimeClass(seconds) {
    if (seconds == null) return '';
    if (seconds < 300) return 'wait-fast';
    if (seconds < 600) return 'wait-medium';
    return 'wait-slow';
  }

  function isPriorityOrder(order) {
    if (order.categoria === 'kids' || order.categoria === 'infantil') return true;
    return order.itens && order.itens.some(function(item) {
      return item.item && PRIORITY_KEYWORDS.some(function(keyword) {
        return item.item.toLowerCase().indexOf(keyword) !== -1;
      });
    }) || false;
  }

  function getItemId(orderId, setor, index) {
    return orderId + '_' + setor + '_' + index;
  }

  // ← NOVO: Formatar nome da mesa para delivery
  function formatMesaDisplay(order) {
    var mesa = order.mesa || 'Mesa';
    
    // Detectar delivery por tipo ou por nome
    if (order.tipo === 'delivery' || order.tipo === 'ifood' || order.isDelivery) {
      return '🚚 Entrega';
    }
    
    // Corrigir nomes inválidos
    if (mesa === 'Unknown' || mesa === 'Desconhecida' || !mesa) {
      return '📦 Pedido';
    }
    
    return mesa;
  }

  // ============================================================================
  // CACHE OFFLINE
  // ============================================================================

  const CACHE_KEY = 'kfm_orders_cache';
  const CACHE_DURATION = 30 * 60 * 1000;

  function cacheOrders(ordersToCache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        orders: ordersToCache,
        timestamp: Date.now()
      }));
    } catch (e) {
      console.warn('Falha ao salvar cache:', e.message);
    }
  }

  function loadCachedOrders() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < CACHE_DURATION) {
          console.log('Cache offline carregado');
          return parsed.orders;
        }
        localStorage.removeItem(CACHE_KEY);
      }
    } catch (e) {
      console.warn('Falha ao carregar cache:', e.message);
    }
    return null;
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
    console.log('Cache offline limpo');
  }

  // ============================================================================
  // SINCRONIZAÇÃO DE HORÁRIO
  // ============================================================================

  function syncTimeWithServer() {
    // ← MELHORADO: Timeout mais curto para iOS
    var timeout = isIOS ? 2000 : 3000;
    
    fetch(BACKEND_URL + '/api/time?_=' + Date.now(), { 
      method: 'GET', 
      cache: 'no-cache',
      headers: { 'Accept': 'application/json' }
    }).then(function(response) {
      if (response.ok) return response.json();
      throw new Error('HTTP ' + response.status);
    }).then(function(data) {
      var now = Date.now();
      var serverTime = new Date(data.timestamp).getTime();
      var roundTripTime = now - (serverTime - now);
      serverTimeOffset = serverTime - (now + roundTripTime / 2);
      lastTimeSync = Date.now();
    }).catch(function(e) {
      // Silencioso para iOS - não poluir console
      if (!isIOS) console.warn('Falha ao sincronizar horario:', e.message);
      serverTimeOffset = 0;
    });
  }

  function getServerTime() {
    return new Date(Date.now() + serverTimeOffset);
  }

  // ← MELHORADO: Intervalo maior para iOS para economizar bateria
  var syncInterval = isIOS ? 10 * 60 * 1000 : 5 * 60 * 1000;
  setInterval(function() { if (isInitialized) syncTimeWithServer(); }, syncInterval);
  syncTimeWithServer();

  // ============================================================================
  // UI: TOAST NOTIFICATIONS
  // ============================================================================

  function toast(message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    
    if (!els.toasts) return;
    
    const t = document.createElement('div');
    t.className = 'toast ' + (type === 'error' ? 'error' : type === 'warning' ? 'warning' : '');
    t.setAttribute('role', 'alert');
    t.innerHTML = '<span>' + escapeHtml(message) + '</span>';
    els.toasts.appendChild(t);
    
    requestAnimationFrame(function() { 
      t.style.opacity = '1'; 
      t.style.transform = 'translateX(0)'; 
    });
    
    setTimeout(function() {
      t.style.opacity = '0'; 
      t.style.transform = 'translateX(20px)';
      setTimeout(function() { t.remove(); }, 300);
    }, duration);
  }

  // ============================================================================
  // UI: MODAL DE CONFIRMAÇÃO
  // ============================================================================

  function showModal(message, onConfirm, onCancel) {
    if (!els.modalMsg) return;
    els.modalMsg.textContent = message;
    if (els.modal.show) els.modal.show();
    else els.modal.style.display = 'flex';
    
    const cleanup = function() {
      if (els.modal.close) els.modal.close();
      else els.modal.style.display = 'none';
      els.modalYes.onclick = null;
      els.modalNo.onclick = null;
    };
    
    els.modalYes.onclick = function() { 
      cleanup(); 
      if (typeof onConfirm === 'function') onConfirm(); 
    };
    els.modalNo.onclick = function() { 
      cleanup(); 
      if (typeof onCancel === 'function') onCancel(); 
    };
    
    const onKey = function(e) {
      if (e.key === 'Escape') { 
        cleanup(); 
        document.removeEventListener('keydown', onKey); 
      }
    };
    document.addEventListener('keydown', onKey);
  }

  // ============================================================================
  // SOM: Sistema de Alerta
  // ============================================================================

  function playDing(volume) {
    if (!soundEnabled) return;
    volume = volume || 0.3;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); 
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.type = 'sine';
      osc.start(); 
      osc.stop(ctx.currentTime + 0.35);
      setTimeout(function() { ctx.close(); }, 400);
    } catch (e) { 
      console.warn('Som nao reproduzido:', e.message); 
    }
  }

  function playCancelAlert(volume) {
    if (!soundEnabled) return;
    volume = volume || 0.4;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1); 
      gain1.connect(ctx.destination);
      osc1.frequency.setValueAtTime(880, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
      gain1.gain.setValueAtTime(volume, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc1.type = 'square';
      osc1.start(); 
      osc1.stop(ctx.currentTime + 0.4);
      setTimeout(function() { ctx.close(); }, 500);
    } catch (e) { 
      console.warn('Som de cancelamento nao reproduzido:', e.message); 
    }
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    if (els.soundToggle) {
      els.soundToggle.textContent = soundEnabled ? '🔔' : '🔕';
      els.soundToggle.classList.toggle('muted', !soundEnabled);
      els.soundToggle.setAttribute('aria-label', soundEnabled ? 'Desativar som' : 'Ativar som');
      els.soundToggle.setAttribute('aria-pressed', soundEnabled);
    }
    toast(soundEnabled ? 'Som ativado' : 'Som silenciado', 'info', 2000);
    localStorage.setItem('kfm_sound_enabled', soundEnabled);
  }

  // ============================================================================
  // CLOCK E TIMERS
  // ============================================================================

  function startClock() {
    const update = function() {
      const now = getServerTime();
      if (els.clock) {
        els.clock.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
    };
    update(); 
    setInterval(update, 1000);
  }

  function startTimers() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(function() {
      const now = Date.now();
      orders.forEach(function(order) {
        if (order.status === 'em-preparo' && order.startedAt) {
          const started = new Date(order.startedAt).getTime();
          const elapsed = Math.floor((now - started) / 1000);
          const timerEl = $('#timer-' + order.id);
          if (timerEl) {
            timerEl.textContent = formatTime(elapsed);
            timerEl.className = 'timer ' + getTimeClass(elapsed);
          }
        }
      });
      $$('.mini-timer').forEach(function(el) {
        const startedAt = el.dataset.started;
        if (startedAt) {
          const started = new Date(startedAt).getTime();
          const elapsed = Math.floor((now - started) / 1000);
          el.textContent = formatTime(elapsed);
          el.className = 'mini-timer ' + getTimeClass(elapsed);
        }
      });
    }, 1000);
  }

  function stopTimers() {
    if (timerInterval) { 
      clearInterval(timerInterval); 
      timerInterval = null; 
    }
  }

  // ============================================================================
  // CONEXÃO INTELIGENTE COM FALLBACK HTTP
  // ============================================================================

  function connect() {
    console.log('Iniciando conexao (WebSocket com fallback HTTP)...');
    if (els.loadingStatus) els.loadingStatus.textContent = 'Conectando...';
    
    if (connectionRetryTimeout) {
      clearTimeout(connectionRetryTimeout);
      connectionRetryTimeout = null;
    }
    
    let wsConnected = false;
    // ← MELHORADO: Timeout menor para iOS
    const wsTimeoutMs = isIOS ? 2000 : 3000;
    const wsTimeout = setTimeout(function() {
      if (!wsConnected) {
        console.warn('WebSocket timeout. Alternando para HTTP Polling...');
        startHttpPolling();
      }
    }, wsTimeoutMs);

    try {
      ws = new WebSocket(WS_URL);
      
      ws.onopen = function() {
        wsConnected = true;
        clearTimeout(wsTimeout);
        console.log('WebSocket conectado');
        updateConnectionStatus(true);
        reconnectAttempts = 0;
        useHttpPolling = false;
        if (els.loadingStatus) els.loadingStatus.textContent = 'Sincronizando...';
        toast('Conectado via WebSocket', 'success', 2000);
        syncTimeWithServer();
      };
      
      ws.onclose = function(event) {
        clearTimeout(wsTimeout);
        console.log('WebSocket desconectado: code ' + event.code);
        
        if (!wsConnected) {
          console.warn('WebSocket falhou. Ativando HTTP Polling...');
          startHttpPolling();
        } else {
          updateConnectionStatus(false);
          if (isInitialized) {
            toast('Conexao perdida. Reconectando...', 'warning');
            connectionRetryTimeout = setTimeout(connect, 2000);
          }
        }
      };
      
      ws.onerror = function(error) {
        console.error('WebSocket error:', error);
        clearTimeout(wsTimeout);
      };
      
      ws.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          handleServerMessage(data.type, data.payload);
        } catch (err) { 
          console.error('Erro ao parsear mensagem:', err); 
        }
      };
    } catch (e) {
      clearTimeout(wsTimeout);
      console.warn('WebSocket nao suportado. Ativando HTTP Polling...');
      startHttpPolling();
    }
  }

  function startHttpPolling() {
    console.log('HTTP Polling ativado (intervalo: 3s)');
    useHttpPolling = true;
    updateConnectionStatus(true);
    isInitialized = true;
    hideLoading();
    renderAll();
    startTimers();
    
    toast('Conectado via HTTP', 'success', 2000);
    
    fetchOrdersHttp();
    
    if (httpPollingInterval) clearInterval(httpPollingInterval);
    // ← MELHORADO: Intervalo menor para iOS para melhor responsividade
    var pollInterval = isIOS ? 2000 : 3000;
    httpPollingInterval = setInterval(fetchOrdersHttp, pollInterval);
  }

  function fetchOrdersHttp() {
    // ← MELHORADO: Cache busting mais agressivo para iOS
    var url = BACKEND_URL + '/api/orders?_=' + Date.now() + '&_=' + Math.random();
    
    fetch(url, { 
      cache: 'no-cache',
      headers: { 'Accept': 'application/json' }
    }).then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function(data) {
      if (data.orders) {
        const oldIds = {};
        orders.forEach(function(o) { oldIds[o.id] = true; });
        
        const newOrders = data.orders.filter(function(o) { 
          return !oldIds[o.id]; 
        });
        
        orders = data.orders;
        cacheOrders(orders);
        renderAll();
        updateConnectionStatus(true);
        
        if (newOrders.length > 0) {
          newOrders.forEach(function(order) {
            var mesaDisplay = formatMesaDisplay(order);
            toast('Novo pedido: ' + mesaDisplay, 'info', 3000);
            playDing();
          });
        }
      }
    }).catch(function(e) {
      console.warn('Falha no HTTP Polling:', e.message);
      updateConnectionStatus(false);
    });
  }

  function updateConnectionStatus(online) {
    if (!els.connStatus) return;
    if (online) {
      els.connStatus.textContent = 'Online';
      els.connStatus.className = 'status online';
      els.connStatus.setAttribute('aria-label', 'Conectado');
    } else {
      els.connStatus.textContent = 'Offline';
      els.connStatus.className = 'status offline';
      els.connStatus.setAttribute('aria-label', 'Desconectado');
    }
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      toast('Nao foi possivel reconectar. Verifique o Bridge.', 'error', 8000);
      if (els.loadingStatus) els.loadingStatus.textContent = 'Falha na conexao'; 
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
    reconnectAttempts++;
    console.log('Reconectando em ' + delay + 'ms (tentativa ' + reconnectAttempts + '/' + MAX_RECONNECT + ')');
    if (els.loadingStatus) els.loadingStatus.textContent = 'Reconectando em ' + Math.ceil(delay / 1000) + 's...';
    connectionRetryTimeout = setTimeout(connect, delay);
  }

  function send(type, payload) {
    payload = payload || {};
    if (ws && ws.readyState === WebSocket.OPEN && !useHttpPolling) {
      ws.send(JSON.stringify({ type: type, payload: payload })); 
      return true;
    }
    
    if (useHttpPolling) {
      fetch(BACKEND_URL + '/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, payload: payload })
      }).catch(function(e) { 
        console.warn('Falha ao enviar comando HTTP:', e.message); 
      });
      return true;
    }
    
    if (reconnectAttempts === 0) {
      toast('Sem conexao com o servidor. Verifique o Bridge.', 'error');
    }
    return false;
  }

  // ============================================================================
  // HANDLER DE MENSAGENS DO SERVIDOR
  // ============================================================================

  function handleServerMessage(type, data) {
    switch (type) {
      case 'INIT':
        orders = data.orders || []; 
        clientId = data.clientId;
        cacheOrders(orders);
        if (clientId && els.clientId) { 
          els.clientId.textContent = 'ID: ' + clientId.slice(0, 8); 
          els.clientId.title = 'ID: ' + clientId; 
        }
        isInitialized = true; 
        hideLoading(); 
        renderAll(); 
        startTimers(); 
        break;
      case 'CONNECTED':
        clientId = data.clientId;
        if (clientId && els.clientId) els.clientId.textContent = 'ID: ' + clientId.slice(0, 8); 
        break;
      case 'NEW_ORDER':
        if (!orders.find(function(o) { return o.id === (data.order && data.order.id); })) {
          orders.unshift(data.order); 
          cacheOrders(orders);
          renderAll();
          var mesaDisplay = data.order ? formatMesaDisplay(data.order) : 'Novo pedido';
          toast('Novo pedido: ' + mesaDisplay, 'info', 3000); 
          playDing();
        } 
        break;
      case 'ORDER_UPDATED':
        var idx = orders.findIndex(function(o) { return o.id === (data.order && data.order.id); });
        if (idx > -1) {
          console.log('Pedido atualizado:', data.order.id, data.order.status);
          orders[idx] = data.order; 
          cacheOrders(orders);
          renderAll();
          if (data.order.status === 'em-preparo') startTimers();
        } 
        break;
      case 'CANCEL_ORDER':
        var payload = data.payload || {};
        console.log('Cancelamento recebido:', payload.orderId, payload.itemId, payload.table, payload.reason);
        showCancelBanner(payload.table, payload.reason || 'Solicitacao do cliente');
        var order = orders.find(function(o) { return o.id === payload.orderId; });
        if (order) {
          if (payload.itemId) {
            var itemIdx = order.itens && order.itens.findIndex(function(i) { 
              return i.id === payload.itemId || (i.item && i.item.indexOf(payload.itemId) !== -1); 
            });
            if (itemIdx > -1 && order.itens[itemIdx]) {
              order.itens[itemIdx].status = 'cancelled';
              order.itens[itemIdx].cancelledAt = new Date().toISOString();
              order.itens[itemIdx].cancelReason = payload.reason;
            }
          } else {
            order.status = 'cancelled';
            order.cancelledAt = new Date().toISOString();
            order.cancelReason = payload.reason;
          }
          cacheOrders(orders);
          renderAll();
          setTimeout(function() { scrollToOrder(payload.orderId); }, 500);
        }
        break;
      case 'ORDER_DELETED':
        var before = orders.length;
        orders = orders.filter(function(o) { return o.id !== data.orderId; });
        if (orders.length < before) { 
          cacheOrders(orders);
          renderAll(); 
          toast('Pedido removido', 'info', 2000); 
        } 
        break;
      case 'PING': 
        send('PONG', { clientId: clientId, timestamp: Date.now() }); 
        break;
    }
  }

  // ============================================================================
  // Banner de Cancelamento + Scroll
  // ============================================================================

  function showCancelBanner(table, reason) {
    cancelAlert = { table: table, reason: reason, timestamp: new Date().toISOString() };
    if (els.cancelBanner && els.cancelMessage) {
      els.cancelMessage.textContent = 'CANCELAMENTO: ' + table + ' - ' + reason;
      els.cancelBanner.classList.remove('hidden');
      els.cancelBanner.classList.add('visible');
      playCancelAlert();
      setTimeout(function() {
        if (cancelAlert && els.cancelBanner) {
          els.cancelBanner.classList.remove('visible');
          els.cancelBanner.classList.add('hidden');
        }
      }, 15000);
    }
  }

  function hideCancelBanner() {
    if (els.cancelBanner) {
      els.cancelBanner.classList.remove('visible');
      els.cancelBanner.classList.add('hidden');
    }
    cancelAlert = null;
  }

  function scrollToOrder(orderId) {
    var card = $('[data-order-id="' + orderId + '"]');
    if (card) {
      card.classList.add('highlight');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function() { card.classList.remove('highlight'); }, 3000);
    }
  }

  // ============================================================================
  // RENDER: Aba GERAL - CORRIGIDO: delivery e emojis compatíveis
  // ============================================================================

  function renderGeral() {
    var ativos = orders.filter(function(o) {
      return o.status !== 'concluido' && 
        o.status !== 'cancelled' &&
        o.tipo !== 'delivery' &&
        (!o.itens || !o.itens.every(function(i) { return i.setor === 'Bebidas'; }));
    });

    if (ativos.length === 0 && !navigator.onLine) {
      var cached = loadCachedOrders();
      if (cached) {
        ativos = cached.filter(function(o) {
          return o.status !== 'concluido' && 
            o.status !== 'cancelled' &&
            o.tipo !== 'delivery' &&
            (!o.itens || !o.itens.every(function(i) { return i.setor === 'Bebidas'; }));
        });
        toast('Modo offline: exibindo pedidos em cache', 'warning', 3000);
      }
    }

    if (els.badges.geral) {
      els.badges.geral.textContent = ativos.length;
      els.badges.geral.setAttribute('aria-label', ativos.length + ' pedido(s) ativo(s)');
    }

    if (ativos.length === 0) {
      els.ordersGeral.innerHTML = '<div class="empty" role="status"><span class="empty-icon" aria-hidden="true">🍽️</span><p>Nenhum pedido ativo</p><small>Aguardando pedidos do Saipos...</small></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < ativos.length; i++) {
      var order = ativos[i];
      var isDelivery = order.tipo === 'delivery' || order.tipo === 'ifood' || order.isDelivery;
      var isInPrep = order.status === 'em-preparo';
      var isCancelled = order.status === 'cancelled';
      var hasPriority = isPriorityOrder(order);
      var startedAt = order.startedAt ? new Date(order.startedAt) : null;
      var elapsed = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : 0;
      var timeClass = getTimeClass(elapsed);

      // ← CORREÇÃO: Usar função formatMesaDisplay para delivery
      var mesaDisplay = formatMesaDisplay(order);

      html += '<article class="order-card ' + 
        (isDelivery ? 'delivery ' : '') + 
        (isInPrep ? 'in-prep ' : '') + 
        (isCancelled ? 'cancelled ' : '') + 
        (hasPriority ? 'priority-high' : '') + 
        '" data-order-id="' + order.id + '" aria-labelledby="order-title-' + order.id + '">';
      
      if (isCancelled) html += '<div class="cancel-ribbon">CANCELADO</div>';
      if (hasPriority) html += '<div class="priority-banner">PRIORIDADE: Kids/Porcao</div>';
      
      html += '<header class="order-header"><div>';
      html += '<div class="order-mesa" id="order-title-' + order.id + '">' + escapeHtml(mesaDisplay) + '</div>';
      html += '<span class="order-type ' + order.tipo + '" role="label">' + order.tipo.toUpperCase() + '</span>';
      
      if (order.garcom && order.garcom !== 'Desconhecido') {
        html += '<div class="order-garcom" title="Garcom responsavel">Chef ' + escapeHtml(order.garcom) + '</div>';
      }
      
      if (order.observacoes) {
        html += '<div class="order-observations">' + escapeHtml(order.observacoes).toUpperCase() + '</div>';
      }
      html += '</div><div class="order-time" aria-label="Tempo de preparo">';
      
      if (isInPrep && !isCancelled) {
        html += '<span id="timer-' + order.id + '" class="timer ' + timeClass + '" data-elapsed="' + elapsed + '">' + formatTime(elapsed) + '</span>';
      } else if (isCancelled) {
        html += '<span class="timer cancelled">CANCELADO</span>';
      } else {
        html += '<span>' + order.horario + '</span>';
      }
      html += '</div></header>';
      
      html += '<ul class="order-items" aria-label="Itens do pedido">';
      if (order.itens && order.itens.length > 0) {
        for (var j = 0; j < order.itens.length; j++) {
          var it = order.itens[j];
          var itemStatus = it.status || order.status;
          var itemStarted = it.startedAt ? new Date(it.startedAt) : (order.startedAt ? new Date(order.startedAt) : null);
          var itemElapsed = itemStarted ? Math.floor((Date.now() - itemStarted.getTime()) / 1000) : null;
          var waitTime = it.completedAt && it.startedAt ? Math.floor((new Date(it.completedAt) - new Date(it.startedAt)) / 1000) : null;
          var waitClass = getWaitTimeClass(waitTime);
          var itemId = getItemId(order.id, it.setor, j);
          
          html += '<li class="order-item ' + (itemStatus === 'cancelled' ? 'cancelled' : itemStatus === 'em-preparo' ? 'in-prep' : '') + '" data-item-id="' + itemId + '" data-status="' + itemStatus + '">';
          html += '<div class="item-content"><div>';
          html += '<span class="sector" aria-label="Setor">' + escapeHtml(it.setor) + '</span>';
          html += '<span class="name">' + escapeHtml(it.item) + '</span>';
          if (waitTime != null) {
            html += '<span class="wait-time ' + waitClass + '" title="Tempo de preparo">⏱️ ' + formatTime(waitTime) + '</span>';
          }
          html += '</div><span class="qty" aria-label="Quantidade">x' + (it.quantidade || 1) + '</span></div>';
          
          if (itemStatus !== 'cancelled') {
            html += '<div class="item-actions">';
            if (itemStatus === 'pendente') {
              html += '<button class="btn-item btn-start" onclick="window.startItem(\'' + order.id + '\', ' + j + ')" aria-label="Iniciar ' + escapeHtml(it.item) + '">▶</button>';
            } else if (itemStatus === 'em-preparo') {
              html += '<button class="btn-item btn-done" onclick="window.completeItem(\'' + order.id + '\', ' + j + ')" aria-label="Concluir ' + escapeHtml(it.item) + '">✅</button>';
            }
            html += '</div>';
          } else {
            html += '<span class="cancelled-badge">🚫</span>';
          }
          html += '</li>';
        }
      } else {
        html += '<li class="order-item empty"><small>Sem itens</small></li>';
      }
      html += '</ul>';
      
      html += '<footer class="order-actions" role="group" aria-label="Acoes do pedido">';
      if (!isCancelled && !isInPrep) {
        html += '<button class="btn btn-primary" onclick="window.startOrder(' + order.id + ')" aria-label="Iniciar preparo de ' + mesaDisplay + '">▶ Iniciar</button>';
        html += '<button class="btn btn-secondary" onclick="window.markReady(' + order.id + ')" aria-label="Marcar ' + mesaDisplay + ' como pronto">✅ Pronto</button>';
      } else if (isCancelled) {
        html += '<button class="btn btn-danger" disabled>Cancelado</button>';
      } else {
        html += '<button class="btn btn-secondary" onclick="window.markReady(' + order.id + ')" aria-label="Marcar ' + mesaDisplay + ' como pronto">✅ Pronto</button>';
      }
      html += '</footer></article>';
    }
    els.ordersGeral.innerHTML = html;
  }

  // ============================================================================
  // RENDER: Aba SETOR - CORRIGIDO: delivery
  // ============================================================================

  function renderSetor() {
    var ativos = orders.filter(function(o) {
      return o.status !== 'concluido' && o.status !== 'cancelled' &&
        o.tipo !== 'delivery' &&
        o.itens && o.itens.some(function(i) { return i.setor !== 'Bebidas' && i.status !== 'cancelled'; });
    });

    var bySector = {};
    for (var s = 0; s < SECTORS.length; s++) bySector[SECTORS[s]] = {};

    for (var o = 0; o < ativos.length; o++) {
      var order = ativos[o];
      if (order.itens) {
        for (var it = 0; it < order.itens.length; it++) {
          var item = order.itens[it];
          if (item.setor === 'Bebidas' || item.status === 'cancelled') continue;
          if (!bySector[item.setor]) bySector[item.setor] = {};
          if (!bySector[item.setor][item.item]) {
            bySector[item.setor][item.item] = { total: 0, tables: [], firstStartedAt: null, hasPriority: false };
          }
          var sectorItem = bySector[item.setor][item.item];
          sectorItem.total += item.quantidade || 1;
          if (isPriorityOrder(order)) sectorItem.hasPriority = true;
          sectorItem.tables.push({
            mesa: formatMesaDisplay(order), // ← CORREÇÃO: usar formatMesaDisplay
            tipo: order.tipo, 
            qty: item.quantidade || 1,
            orderId: order.id, 
            status: item.status || order.status,
            startedAt: item.startedAt || order.startedAt,
            itemId: item.id, 
            itemIndex: order.itens.indexOf(item),
            garcom: order.garcom,
            observacoes: order.observacoes
          });
          if ((item.startedAt || order.startedAt) && (!sectorItem.firstStartedAt || new Date(item.startedAt || order.startedAt) < new Date(sectorItem.firstStartedAt))) {
            sectorItem.firstStartedAt = item.startedAt || order.startedAt;
          }
        }
      }
    }

    var totalAtivos = 0;
    var sectorsHtml = '';
    for (var si = 0; si < SECTORS.length; si++) {
      var sector = SECTORS[si];
      var items = bySector[sector];
      var hasItems = Object.keys(items).length > 0;
      if (hasItems) totalAtivos += Object.keys(items).length;
      
      var stats = { prep: 0, waiting: 0 };
      for (var key in items) {
        var itemData = items[key];
        for (var ti = 0; ti < itemData.tables.length; ti++) {
          var t = itemData.tables[ti];
          if (t.status === 'em-preparo') stats.prep++;
          else if (t.status !== 'cancelled') stats.waiting++;
        }
      }

      sectorsHtml += '<section class="sector-card ' + (stats.prep > 0 ? 'has-prep' : '') + ' ' + (Object.keys(items).some(function(i) { return items[i].hasPriority; }) ? 'has-priority' : '') + '" aria-labelledby="sector-title-' + sector + '">';
      sectorsHtml += '<header class="sector-title"><span id="sector-title-' + sector + '">' + sector + '</span><span class="badge" aria-label="' + (hasItems ? Object.keys(items).length : 0) + ' tipo(s) de item">' + (hasItems ? Object.keys(items).length : 0) + '</span></header>';
      
      if (stats.waiting > 0) sectorsHtml += '<div class="sector-alert" role="alert">⚠️ ' + stats.waiting + ' item(s) aguardando inicio</div>';
      if (!hasItems) sectorsHtml += '<p style="color:var(--muted);text-align:center;padding:20px">Sem itens</p>';
      
      sectorsHtml += '<ul class="sector-items" aria-label="Itens do setor">';
      for (var name in items) {
        var data = items[name];
        var temEmPreparo = data.tables.some(function(t) { return t.status === 'em-preparo'; });
        var temAguardando = data.tables.some(function(t) { return t.status !== 'em-preparo' && t.status !== 'cancelled'; });
        var elapsed = data.firstStartedAt ? Math.floor((Date.now() - new Date(data.firstStartedAt).getTime()) / 1000) : 0;
        var timeClass = getTimeClass(elapsed);
        
        sectorsHtml += '<li class="sector-item ' + (temEmPreparo ? 'in-prep' : '') + ' ' + (temAguardando ? 'waiting' : '') + ' ' + (data.hasPriority ? 'priority-item' : '') + '">';
        sectorsHtml += '<div class="item-name"><span>' + escapeHtml(name) + '</span><span style="color:var(--accent);font-weight:800" aria-label="Quantidade total">x' + data.total + '</span>';
        if (data.hasPriority) sectorsHtml += '<span class="priority-badge">👶</span>';
        sectorsHtml += '</div><div class="item-meta"><div class="tables" role="list" aria-label="Mesas">';
        
        for (var ti = 0; ti < data.tables.length; ti++) {
          var t = data.tables[ti];
          var itemTagTitle = [t.mesa]; // ← Já formatado por formatMesaDisplay
          if (t.garcom) itemTagTitle.push('Garcom: ' + t.garcom);
          if (t.observacoes) itemTagTitle.push('OBS: ' + t.observacoes.toUpperCase());
          
          sectorsHtml += '<span class="table-tag ' + t.tipo + ' ' + (t.status === 'em-preparo' ? 'prep' : '') + ' ' + (t.status === 'cancelled' ? 'cancelled' : '') + '" role="listitem" data-order-id="' + t.orderId + '" data-started="' + (t.startedAt || '') + '" title="' + escapeHtml(itemTagTitle.join(' - ')) + '">';
          sectorsHtml += escapeHtml(t.mesa) + ' <span aria-label="quantidade">x' + t.qty + '</span>';
          if (t.observacoes) sectorsHtml += '<span class="table-obs">📝</span>';
          if (t.status === 'em-preparo' && t.startedAt) {
            sectorsHtml += '<span class="mini-timer ' + timeClass + '" data-elapsed="' + elapsed + '" aria-label="Tempo em preparo: ' + formatTime(elapsed) + '">' + formatTime(elapsed) + '</span>';
          } else if (t.status === 'cancelled') {
            sectorsHtml += '<span class="cancelled-mini">🚫</span>';
          }
          sectorsHtml += '</span>';
        }
        sectorsHtml += '</div></div></li>';
      }
      sectorsHtml += '</ul>';
      
      sectorsHtml += '<footer class="sector-actions" role="group" aria-label="Acoes do setor">';
      sectorsHtml += '<button class="btn-sector start" onclick="window.startSector(\'' + sector + '\')" ' + (stats.waiting === 0 ? 'disabled' : '') + ' aria-label="Iniciar preparo de ' + stats.waiting + ' itens em ' + sector + '">▶ Iniciar' + (stats.waiting > 0 ? ' (' + stats.waiting + ')' : '') + '</button>';
      sectorsHtml += '<button class="btn-sector done" onclick="window.doneSector(\'' + sector + '\')" ' + (stats.prep === 0 ? 'disabled' : '') + ' aria-label="Concluir ' + stats.prep + ' itens em preparo em ' + sector + '">✅ Concluir' + (stats.prep > 0 ? ' (' + stats.prep + ')' : '') + '</button>';
      sectorsHtml += '</footer></section>';
    }
    els.sectorsWrap.innerHTML = sectorsHtml;

    if (els.badges.setor) {
      els.badges.setor.textContent = totalAtivos;
      els.badges.setor.setAttribute('aria-label', totalAtivos + ' item(s) ativo(s)');
    }
  }

  // ============================================================================
  // RENDER: Aba CONCLUÍDOS - CORRIGIDO: delivery
  // ============================================================================

  function renderConcluidos() {
    var concluidos = orders.filter(function(o) { return o.status === 'concluido'; });
    if (els.badges.concluidos) {
      els.badges.concluidos.textContent = concluidos.length;
      els.badges.concluidos.setAttribute('aria-label', concluidos.length + ' pedido(s) concluido(s)');
    }
    if (concluidos.length === 0) {
      els.completedList.innerHTML = '<div class="empty" role="status"><span class="empty-icon" aria-hidden="true">✨</span><p>Nenhum concluido</p><small>Pedidos finalizados aparecem aqui</small></div>';
      return;
    }
    
    var recent = concluidos.slice(0, 50);
    var html = '';
    for (var i = 0; i < recent.length; i++) {
      var o = recent[i];
      var startedAt = o.startedAt ? new Date(o.startedAt) : null;
      var concludedAt = o.updatedAt ? new Date(o.updatedAt) : null;
      var duration = startedAt && concludedAt ? Math.floor((concludedAt - startedAt) / 1000) : null;
      
      var itemTimes = [];
      if (o.itens) {
        for (var it = 0; it < o.itens.length; it++) {
          var itStart = o.itens[it].startedAt ? new Date(o.itens[it].startedAt) : startedAt;
          var itEnd = o.itens[it].completedAt ? new Date(o.itens[it].completedAt) : concludedAt;
          if (itStart && itEnd) itemTimes.push(Math.floor((itEnd - itStart) / 1000));
        }
      }
      var avgItemTime = itemTimes.length > 0 ? Math.round(itemTimes.reduce(function(a,b) { return a+b; }, 0) / itemTimes.length) : null;
      var slowestItem = itemTimes.length > 0 ? Math.max.apply(null, itemTimes) : null;

      // ← CORREÇÃO: Usar formatMesaDisplay
      var mesaDisplay = formatMesaDisplay(o);

      html += '<article class="completed-item" data-order-id="' + o.id + '">';
      html += '<div class="completed-header" onclick="window.toggleCompletedDetails(\'' + o.id + '\')" style="cursor:pointer">';
      html += '<div class="info"><span class="mesa">' + escapeHtml(mesaDisplay) + ' <span class="order-type ' + o.tipo + '" style="padding:2px 8px;font-size:0.75rem">' + o.tipo + '</span></span>';
      if (o.garcom && o.garcom !== 'Desconhecido') {
        html += '<span class="garcom-small" title="Garcom">Chef ' + escapeHtml(o.garcom) + '</span>';
      }
      if (o.observacoes) {
        html += '<span class="obs-small" title="Observacao">📝 ' + escapeHtml(o.observacoes).toUpperCase() + '</span>';
      }
      html += '<span class="time">' + o.horario + ' - ' + (o.itens ? o.itens.length : 0) + ' itens' + (duration != null ? ' - ⏱️ ' + formatTime(duration) : '') + '</span>';
      if (avgItemTime != null) {
        html += '<span class="item-stats" title="Tempo medio por item">📊 Media: ' + formatTime(avgItemTime) + '</span>';
      }
      html += '</div><span class="expand-icon">▾</span></div>';
      
      html += '<div id="details-' + o.id + '" class="completed-details hidden"><div class="details-list">';
      if (o.itens) {
        for (var it = 0; it < o.itens.length; it++) {
          var itStart = o.itens[it].startedAt ? new Date(o.itens[it].startedAt) : startedAt;
          var itEnd = o.itens[it].completedAt ? new Date(o.itens[it].completedAt) : concludedAt;
          var itTime = itStart && itEnd ? Math.floor((itEnd - itStart) / 1000) : null;
          var waitClass = getWaitTimeClass(itTime);
          html += '<div class="detail-item"><span class="detail-name">' + escapeHtml(o.itens[it].item) + ' <small>(' + escapeHtml(o.itens[it].setor) + ')</small></span>';
          if (itTime != null) {
            html += '<span class="detail-time ' + waitClass + '" title="Tempo de preparo">⏱️ ' + formatTime(itTime) + '</span>';
          }
          html += '</div>';
        }
      } else {
        html += '<small>Sem detalhes</small>';
      }
      html += '</div>';
      if (slowestItem != null && slowestItem > 600) {
        html += '<div class="alert-slow">⚠️ Item mais lento: ' + formatTime(slowestItem) + ' (acima de 10min)</div>';
      }
      html += '</div><button class="btn btn-danger" style="padding:10px 20px" onclick="window.removeCompleted(' + o.id + ')" aria-label="Remover ' + mesaDisplay + ' do historico">🗑️</button></article>';
    }
    els.completedList.innerHTML = html;
  }

  window.toggleCompletedDetails = function(orderId) {
    var details = $('#details-' + orderId);
    var expandIcon = details && details.previousElementSibling ? details.previousElementSibling.querySelector('.expand-icon') : null;
    if (details) {
      details.classList.toggle('hidden');
      if (expandIcon) expandIcon.textContent = details.classList.contains('hidden') ? '▾' : '▴';
    }
  };

  // ============================================================================
  // RENDER: Orquestrador
  // ============================================================================

  function renderAll() {
    if (!isInitialized) return;
    if (currentTab === 'geral') renderGeral();
    else if (currentTab === 'setor') renderSetor();
    else if (currentTab === 'concluidos') renderConcluidos();
  }

  function hideLoading() {
    if (els.loadingOverlay) {
      els.loadingOverlay.style.opacity = '0';
      setTimeout(function() { 
        if (els.loadingOverlay && els.loadingOverlay.remove) els.loadingOverlay.remove(); 
      }, 300);
    }
  }

  // ============================================================================
  // EVENT LISTENERS: Tabs
  // ============================================================================

  function setupTabs() {
    if (!els.tabs) return;
    for (var i = 0; i < els.tabs.length; i++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          for (var j = 0; j < els.tabs.length; j++) { 
            els.tabs[j].classList.remove('active'); 
            els.tabs[j].setAttribute('aria-selected', 'false'); 
          }
          btn.classList.add('active'); 
          btn.setAttribute('aria-selected', 'true');
          currentTab = btn.dataset.tab;
          var target = $('#tab-' + currentTab);
          if (target) {
            target.classList.add('active');
            for (var k = 0; k < els.tabContents.length; k++) {
              els.tabContents[k].setAttribute('hidden', els.tabContents[k].id !== 'tab-' + currentTab);
            }
          }
          renderAll();
          if (navigator.vibrate) navigator.vibrate(10);
        });
      })(els.tabs[i]);
    }
  }

  // ============================================================================
  // EVENT LISTENERS: Config Panel + Cancel Banner
  // ============================================================================

  function setupConfigPanel() {
    if (!els.openConfig || !els.configPanel) return;
    els.openConfig.addEventListener('click', function() {
      if (els.backendUrlInput) els.backendUrlInput.value = BACKEND_URL;
      els.configPanel.classList.remove('hidden');
      if (els.backendUrlInput) els.backendUrlInput.focus();
    });
    if (els.toggleConfig) els.toggleConfig.addEventListener('click', function() { 
      els.configPanel.classList.add('hidden'); 
    });
    if (els.saveConfig) els.saveConfig.addEventListener('click', function() {
      var url = els.backendUrlInput ? els.backendUrlInput.value.trim() : '';
      if (url && url.startsWith('http')) {
        localStorage.setItem('kfm_backend_url', url);
        toast('Configuracao salva! Recarregando...', 'success', 2000);
        setTimeout(function() { location.reload(); }, 500);
      } else {
        toast('URL invalida', 'error');
      }
    });
    document.addEventListener('click', function(e) {
      if (els.configPanel && !els.configPanel.classList.contains('hidden') && !els.configPanel.contains(e.target) && e.target !== els.openConfig) {
        els.configPanel.classList.add('hidden');
      }
      if (e.target === els.cancelClose) hideCancelBanner();
    });
    
    var configClicks = 0;
    els.openConfig.addEventListener('dblclick', function() {
      configClicks++;
      if (configClicks >= 3) {
        tryFullscreen();
        configClicks = 0;
        toast('Tela cheia ativada', 'info', 2000);
      }
      setTimeout(function() { configClicks = 0; }, 1000);
    });
  }

  function tryFullscreen() {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return;
    var elem = document.documentElement;
    if (elem.requestFullscreen) elem.requestFullscreen().catch(function() {});
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen().catch(function() {});
    else if (elem.msRequestFullscreen) elem.msRequestFullscreen().catch(function() {});
  }

  // ============================================================================
  // Ações por Item - CORRIGIDO: sintaxe compatível
  // ============================================================================

  window.startItem = function(orderId, itemIndex) {
    var order = null;
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].id === orderId) { order = orders[i]; break; }
    }
    if (!order || !order.itens || !order.itens[itemIndex]) return;
    
    var item = order.itens[itemIndex];
    var agora = getServerTime().toISOString();
    
    item.status = 'em-preparo';
    item.startedAt = agora;
    
    renderAll();
    startTimers();
    toast('▶ ' + item.item + ' em producao', 'success', 1500);
    
    send('UPDATE_ITEM_STATUS', {
      orderId: orderId,
      itemId: getItemId(orderId, item.setor, itemIndex),
      status: 'em-preparo',
      startedAt: agora,
      timestamp: agora
    });
  };

  window.completeItem = function(orderId, itemIndex) {
    var order = null;
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].id === orderId) { order = orders[i]; break; }
    }
    if (!order || !order.itens || !order.itens[itemIndex]) return;
    
    var item = order.itens[itemIndex];
    var agora = getServerTime().toISOString();
    var started = item.startedAt ? new Date(item.startedAt).getTime() : Date.now();
    var prepTime = Math.floor((Date.now() - started) / 1000);
    
    item.status = 'concluido';
    item.completedAt = agora;
    item.prepTime = prepTime;
    
    renderAll();
    toast('✅ ' + item.item + ' pronto! (' + formatTime(prepTime) + ')', 'success', 1500);
    
    send('UPDATE_ITEM_STATUS', {
      orderId: orderId,
      itemId: getItemId(orderId, item.setor, itemIndex),
      status: 'concluido',
      completedAt: agora,
      prepTime: prepTime,
      timestamp: agora
    });
    
    var allDone = true;
    for (var i = 0; i < order.itens.length; i++) {
      var iStatus = order.itens[i].status;
      var iSetor = order.itens[i].setor;
      if (iStatus !== 'concluido' && iSetor !== 'Bebidas') {
        allDone = false;
        break;
      }
    }
    
    if (allDone && order.status !== 'concluido') {
      order.status = 'concluido';
      order.updatedAt = agora;
      send('UPDATE_STATUS', { orderId: orderId, status: 'concluido', concludedAt: agora });
    }
  };

  // ============================================================================
  // Ações Globais
  // ============================================================================

  window.startOrder = function(id) {
    var order = null;
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].id === id) { order = orders[i]; break; }
    }
    if (!order) { 
      console.error('Pedido nao encontrado:', id); 
      return; 
    }
    var agora = getServerTime().toISOString();
    var mesaDisplay = formatMesaDisplay(order); // ← CORREÇÃO
    console.log('▶ Iniciando pedido ' + mesaDisplay + ' (ID: ' + id + ') as ' + agora);
    order.status = 'em-preparo'; 
    order.startedAt = agora;
    renderAll(); 
    startTimers();
    toast('▶ ' + mesaDisplay + ' em producao', 'success', 2000);
    var payload = { orderId: id, status: 'em-preparo', startedAt: agora, timestamp: agora };
    console.log('Enviando UPDATE_STATUS:', payload);
    if (send('UPDATE_STATUS', payload)) {
      setTimeout(function() { 
        console.log('Forcando sync apos iniciar pedido'); 
        send('REQUEST_SYNC', { orderId: id }); 
      }, 500);
    } else { 
      order.status = 'pendente'; 
      order.startedAt = null; 
      renderAll(); 
      toast('Erro ao iniciar pedido - sem conexao', 'error'); 
    }
  };

  window.markReady = function(id) {
    var order = null;
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].id === id) { order = orders[i]; break; }
    }
    if (!order) { 
      console.error('Pedido nao encontrado:', id); 
      return; 
    }
    var mesaDisplay = formatMesaDisplay(order); // ← CORREÇÃO
    showModal('Confirmar: concluir ' + mesaDisplay + '?', function() {
      var agora = getServerTime().toISOString();
      console.log('✅ Concluindo pedido ' + mesaDisplay + ' (ID: ' + id + ') as ' + agora);
      order.status = 'concluido'; 
      order.concludedAt = agora; 
      order.updatedAt = agora;
      renderAll(); 
      toast('✅ ' + mesaDisplay + ' concluido!', 'success', 2000);
      if (send('UPDATE_STATUS', { orderId: id, status: 'concluido', concludedAt: agora, timestamp: agora })) {
        setTimeout(function() { send('REQUEST_SYNC', { orderId: id }); }, 500);
      }
    });
  };

  window.startSector = function(sector) {
    var aguardando = orders.filter(function(o) {
      return o.status !== 'concluido' && o.status !== 'cancelled' && o.tipo !== 'delivery' && 
        o.itens && o.itens.some(function(i) { return i.setor === sector && i.status !== 'cancelled'; });
    });
    if (aguardando.length === 0) { 
      toast('Nada para iniciar em ' + sector, 'warning'); 
      return; 
    }
    console.log('▶ Iniciando setor ' + sector + ': ' + aguardando.length + ' pedido(s)');
    showModal('Iniciar ' + aguardando.length + ' pedido(s) em ' + sector + '?', function() {
      var agora = getServerTime().toISOString();
      for (var i = 0; i < aguardando.length; i++) { 
        aguardando[i].status = 'em-preparo'; 
        aguardando[i].startedAt = agora; 
      }
      renderAll(); 
      startTimers(); 
      toast(sector + ' iniciado! (' + aguardando.length + ' pedidos)', 'success');
      for (var j = 0; j < aguardando.length; j++) {
        send('UPDATE_STATUS', { orderId: aguardando[j].id, status: 'em-preparo', sector: sector, startedAt: agora, timestamp: agora });
      }
      setTimeout(function() { send('REQUEST_SYNC', { sector: sector }); }, 500);
    });
  };

  window.doneSector = function(sector) {
    var emPreparo = orders.filter(function(o) {
      return o.status === 'em-preparo' && o.itens && o.itens.some(function(i) { return i.setor === sector; });
    });
    if (emPreparo.length === 0) { 
      toast('Nada em preparo em ' + sector, 'warning'); 
      return; 
    }
    console.log('✅ Concluindo setor ' + sector + ': ' + emPreparo.length + ' pedido(s)');
    showModal('Concluir ' + emPreparo.length + ' pedido(s) de ' + sector + '?', function() {
      var agora = getServerTime().toISOString();
      for (var i = 0; i < emPreparo.length; i++) { 
        emPreparo[i].status = 'concluido'; 
        emPreparo[i].concludedAt = agora; 
        emPreparo[i].updatedAt = agora; 
      }
      renderAll(); 
      toast(sector + ' concluido!', 'success');
      for (var j = 0; j < emPreparo.length; j++) {
        send('UPDATE_STATUS', { orderId: emPreparo[j].id, status: 'concluido', sector: sector, concludedAt: agora, timestamp: agora });
      }
      setTimeout(function() { send('REQUEST_SYNC', { sector: sector }); }, 500);
    });
  };

  window.removeCompleted = function(id) {
    var order = null;
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].id === id) { order = orders[i]; break; }
    }
    if (!order) { 
      console.error('Pedido nao encontrado:', id); 
      return; 
    }
    var mesaDisplay = formatMesaDisplay(order); // ← CORREÇÃO
    showModal('Remover ' + mesaDisplay + ' do historico?', function() {
      if (send('DELETE_ORDER', { orderId: id })) toast('Removido', 'info', 1500);
    });
  };

  if (els.clearCompleted) {
    els.clearCompleted.addEventListener('click', function() {
      var concluidos = orders.filter(function(o) { return o.status === 'concluido'; });
      if (!concluidos.length) { 
        toast('Nada para limpar', 'warning'); 
        return; 
      }
      showModal('Limpar ' + concluidos.length + ' pedido(s) concluido(s)?', function() {
        for (var i = 0; i < concluidos.length; i++) {
          send('DELETE_ORDER', { orderId: concluidos[i].id });
        }
        toast('Lista limpa', 'success');
      });
    });
  }

  // ============================================================================
  // EVENT LISTENERS: Som e Toque
  // ============================================================================

  function setupSound() {
    var saved = localStorage.getItem('kfm_sound_enabled');
    if (saved !== null) soundEnabled = saved === 'true';
    if (els.soundToggle) {
      els.soundToggle.textContent = soundEnabled ? '🔔' : '🔕';
      els.soundToggle.classList.toggle('muted', !soundEnabled);
      els.soundToggle.setAttribute('aria-label', soundEnabled ? 'Desativar som' : 'Ativar som');
      els.soundToggle.setAttribute('aria-pressed', soundEnabled);
      els.soundToggle.addEventListener('click', toggleSound);
    }
    // ← MELHORADO: Inicializar AudioContext no primeiro toque (iOS)
    document.addEventListener('touchstart', function() {
      try {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) { 
          var ctx = new AudioCtx(); 
          ctx.resume(); 
          ctx.close(); 
        }
      } catch (e) {}
    }, { once: true, passive: true });
  }

  function setupTouchOptimizations() {
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function(e) {
      var now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    var scrollable = $('.orders-grid, .sectors-wrap, .completed-list');
    if (scrollable) scrollable.addEventListener('touchmove', function(e) { e.stopPropagation(); }, { passive: false });
  }

  // ============================================================================
  // INICIALIZAÇÃO
  // ============================================================================

  function init() {
    console.log('Inicializando Kitchen Flow v2.1.9...');
    startClock(); 
    setupTabs(); 
    setupConfigPanel(); 
    setupSound(); 
    setupTouchOptimizations();
    
    if (!navigator.onLine) {
      var cached = loadCachedOrders();
      if (cached) {
        orders = cached;
        console.log('Iniciando com cache offline');
        isInitialized = true;
        hideLoading();
        renderAll();
        startTimers();
      }
    }
    
    connect();
    window.KFM = { 
      orders: orders, 
      ws: ws, 
      send: send, 
      renderAll: renderAll, 
      startTimers: startTimers, 
      playDing: playDing, 
      playCancelAlert: playCancelAlert, 
      toast: toast, 
      syncTimeWithServer: syncTimeWithServer, 
      getServerTime: getServerTime, 
      tryFullscreen: tryFullscreen, 
      clearCache: clearCache,
      formatMesaDisplay: formatMesaDisplay // ← NOVO: Expor para debug
    };
    console.log('Kitchen Flow inicializado');
    console.log('Comandos disponiveis: window.KFM');
    console.log('Cache offline: use window.KFM.clearCache() para limpar');
    
    if (window.location.hostname.indexOf('netlify') !== -1 && !localStorage.getItem('kfm_backend_url')) {
      setTimeout(function() {
        toast('Configure o IP do Bridge nas configuracoes (engrenagem) para conectar.', 'warning', 8000);
      }, 3000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Listener para mudança de status de conexão
  window.addEventListener('online', function() {
    console.log('Conexao restaurada');
    toast('Conexao restaurada - sincronizando...', 'success', 3000);
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  });
  
  window.addEventListener('offline', function() {
    console.log('Conexao perdida - usando cache');
    toast('Offline - usando pedidos em cache', 'warning', 5000);
  });

  window.addEventListener('beforeunload', function() { 
    stopTimers(); 
    if (httpPollingInterval) clearInterval(httpPollingInterval);
    if (connectionRetryTimeout) clearTimeout(connectionRetryTimeout);
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(); 
  });

})();
