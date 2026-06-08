/**
 * Kitchen Flow - Página do Garçom v1.5
 * Funcionalidades: PIN diário, PWA notifications, filtro salvo, polling, pull-to-refresh
 * Hotfix v1.5: Delivery fix + iOS compat + proteção DOM + feedback visual robusto
 */
(() => {
  'use strict';

  // ============================================================================
  // CONFIGURAÇÕES INTELIGENTES
  // ============================================================================

  const getApiBase = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlApi = urlParams.get('api');
    if (urlApi && urlApi.startsWith('http')) {
      console.log('API definida via URL:', urlApi);
      return urlApi;
    }

    const saved = localStorage.getItem('kfm_api_base');
    if (saved && saved.startsWith('http')) {
      console.log('API carregada do localStorage:', saved);
      return saved;
    }

    const hostname = window.location.hostname;
    
    if (hostname.includes('netlify') || hostname.includes('vercel') || !hostname.includes('localhost')) {
      console.log('Ambiente cloud detectado. Usando fallback de IPs locais.');
      return 'http://192.168.0.190:4545';
    }
    
    return 'http://localhost:4545';
  };

  const API_BASE = getApiBase();
  const POLL_INTERVAL = 30000;
  const PRIORITY_KEYWORDS = ['kids', 'infantil', 'crianca', 'batata', 'porcao', 'tirinhas', 'salada', 'nugget'];

  const PIN_STORAGE_KEY = 'kfm_waiter_pin';
  const PIN_DATE_KEY = 'kfm_waiter_pin_date';
  const FILTER_STORAGE_KEY = 'kfm_waiter_filter';
  const NOTIFICATION_SOUND_ENABLED = true;

  let orders = [];
  let currentFilter = 'all';
  let currentGarcom = '';
  let lastUpdate = null;
  let isRefreshing = false;
  let pullStartY = 0;
  let pinValidated = false;
  let notificationPermission = 'default';
  let fetchFailCount = 0;
  const MAX_FETCH_FAILS = 3;
  let pollIntervalId = null;

  // ← NOVO: Detectar iOS para ajustes de compatibilidade
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIOS) {
    console.log('iOS detectado - aplicando ajustes de compatibilidade');
  }

  const $ = (sel, context = document) => context.querySelector(sel);
  const $$ = (sel, context = document) => context.querySelectorAll(sel);

  const els = {
    loading: $('#loading'),
    ordersList: $('#ordersList'),
    emptyState: $('#emptyState'),
    garcomSelect: $('#garcomSelect'),
    refreshBtn: $('#refreshBtn'),
    configBtn: $('#configBtn'),
    connStatus: $('#connStatus'),
    lastUpdate: $('#lastUpdate'),
    ordersCount: $('#ordersCount'),
    toasts: $('#toasts'),
    pullIndicator: $('#pullIndicator'),
    filterBtns: $$('.filter-btn')
  };

  // ============================================================================
  // ← NOVO: FUNÇÃO PARA FORMATAR NOME DA MESA (DELIVERY FIX)
  // ============================================================================

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
  // FETCH ROBUSTO COM TIMEOUT E FALLBACK DE IPs
  // ============================================================================

  async function fetchWithFallback(url, options = {}) {
    const bases = [
      API_BASE,
      API_BASE.replace('192.168.0.190', '192.168.1.190'),
      API_BASE.replace('192.168.1.190', '192.168.0.100'),
      API_BASE.replace('192.168.0.100', '192.168.1.100'),
      API_BASE.replace('192.168.1.100', '10.0.0.100')
    ].filter((v, i, a) => a.indexOf(v) === i);
    
    let lastError = null;
    
    for (const base of bases) {
      const testUrl = url.toString().replace(API_BASE, base);
      
      try {
        console.debug('Tentando:', testUrl);
        
        // ← MELHORADO: Timeout menor para iOS
        const timeoutMs = isIOS ? 8000 : 10000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        const response = await fetch(testUrl, {
          ...options,
          signal: controller.signal,
          headers: { 'Accept': 'application/json', ...options.headers }
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          if (base !== API_BASE) {
            localStorage.setItem('kfm_api_base', base);
            console.log('API funcionando em:', base);
            toast('Conectado ao Bridge em ' + base, 'success', 3000);
          }
          return response;
        }
        
        lastError = new Error('HTTP ' + response.status);
      } catch (e) {
        lastError = e;
        console.debug('Falha em', base + ':', e.name, '-', e.message);
      }
    }
    
    throw lastError || new Error('Não foi possível conectar ao Bridge');
  }

  // ============================================================================
  // SISTEMA DE PIN DIÁRIO
  // ============================================================================

  function getTodayDate() {
    return new Date().toISOString().split('T')[0];
  }

  function isPinValidForToday(storedPin, storedDate) {
    const today = getTodayDate();
    return storedDate === today && storedPin && storedPin.length === 4;
  }

  function savePin(pin) {
    localStorage.setItem(PIN_STORAGE_KEY, pin);
    localStorage.setItem(PIN_DATE_KEY, getTodayDate());
  }

  function getSavedPin() {
    const pin = localStorage.getItem(PIN_STORAGE_KEY);
    const date = localStorage.getItem(PIN_DATE_KEY);
    return isPinValidForToday(pin, date) ? pin : null;
  }

  function clearPin() {
    localStorage.removeItem(PIN_STORAGE_KEY);
    localStorage.removeItem(PIN_DATE_KEY);
  }

  async function checkPin() {
    if (sessionStorage.getItem('waiter_pin_validated') === 'true') {
      pinValidated = true;
      return true;
    }

    const savedPin = getSavedPin();
    if (savedPin) {
      try {
        const serverPin = await fetchWithFallback(API_BASE + '/api/waiter/pin', { cache: 'no-cache' });
        const data = await serverPin.json();
        if (savedPin === data.pin) {
          pinValidated = true;
          sessionStorage.setItem('waiter_pin_validated', 'true');
          return true;
        }
        clearPin();
      } catch (e) {
        console.warn('Não foi possível verificar PIN:', e.message);
      }
    }

    return showPinModal();
  }

  function showPinModal() {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'pin-modal';
      modal.innerHTML = `
        <div class="pin-modal-content">
          <h3>🔐 Acesso Restrito</h3>
          <p>Digite o código de acesso do dia:</p>
          <input type="password" id="pinInput" maxlength="4" pattern="[0-9]{4}" inputmode="numeric" placeholder="••••" autocomplete="off">
          <div class="pin-buttons">
            <button id="pinCancel" class="btn-secondary">Cancelar</button>
            <button id="pinSubmit" class="btn-primary">Entrar</button>
          </div>
          <p id="pinError" class="pin-error hidden">❌ Código incorreto</p>
          <small class="pin-help">
            💡 Peça o código à gerente ou caixa.<br>
            O código muda diariamente.
          </small>
        </div>
      `;

      document.body.appendChild(modal);

      let style = document.getElementById('kfm-pin-modal-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'kfm-pin-modal-style';
        style.textContent = `
          .pin-modal {
            position: fixed; inset: 0; background: rgba(0,0,0,0.85);
            display: flex; align-items: center; justify-content: center;
            z-index: 2000; animation: fadeIn 0.2s ease;
          }
          .pin-modal-content {
            background: var(--card); padding: 24px; border-radius: var(--radius);
            max-width: 320px; width: 90%; text-align: center;
            box-shadow: var(--shadow-lg); border: 2px solid var(--accent);
          }
          .pin-modal-content h3 { color: var(--accent); margin-bottom: 12px; font-size: 1.3rem; }
          .pin-modal-content p { color: var(--muted); margin-bottom: 16px; font-size: 0.95rem; }
          #pinInput {
            width: 100%; padding: 14px; font-size: 1.5rem; text-align: center;
            letter-spacing: 8px; background: var(--bg); border: 2px solid #444;
            color: var(--text); border-radius: 8px; margin-bottom: 16px; font-family: monospace;
          }
          #pinInput:focus { outline: none; border-color: var(--accent); }
          .pin-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .btn-primary { background: var(--success); color: #000; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; }
          .btn-secondary { background: #444; color: #fff; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; }
          .pin-error { color: var(--accent); font-weight: 600; margin-top: 12px; min-height: 20px; }
          .pin-error.hidden { display: none; }
          .pin-help { display: block; margin-top: 16px; color: var(--muted); font-size: 0.8rem; line-height: 1.4; }
          @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
          @keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
        `;
        document.head.appendChild(style);
      }

      const input = $('#pinInput', modal);
      const submit = $('#pinSubmit', modal);
      const cancel = $('#pinCancel', modal);
      const error = $('#pinError', modal);

      setTimeout(() => input?.focus(), 100);

      input?.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
        if (e.target.value.length === 4) submit?.click();
      });

      submit?.addEventListener('click', async () => {
        const pin = input?.value;
        if (!pin || pin.length !== 4) {
          error?.classList.remove('hidden');
          error.textContent = '❌ Digite 4 números';
          return;
        }

        error?.classList.add('hidden');
        submit.disabled = true;
        submit.textContent = 'Verificando...';

        try {
          const response = await fetchWithFallback(API_BASE + '/api/waiter/pin', { cache: 'no-cache' });
          const data = await response.json();
          
          if (pin === data.pin) {
            savePin(pin);
            pinValidated = true;
            sessionStorage.setItem('waiter_pin_validated', 'true');
            submit.textContent = '✅ Entrando...';
            setTimeout(() => { modal.remove(); resolve(true); }, 500);
          } else {
            throw new Error('PIN incorreto');
          }
        } catch (e) {
          error?.classList.remove('hidden');
          error.textContent = '❌ Código incorreto ou sem conexão';
          input.value = '';
          input.focus();
          submit.disabled = false;
          submit.textContent = 'Entrar';
          modal.querySelector('.pin-modal-content').style.animation = 'shake 0.3s ease';
          setTimeout(() => { modal.querySelector('.pin-modal-content').style.animation = ''; }, 300);
        }
      });

      cancel?.addEventListener('click', () => {
        modal.remove();
        document.body.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;background:var(--bg);color:var(--text);font-family:system-ui">
            <h1 style="color:var(--accent);margin-bottom:12px">🔒 Acesso Negado</h1>
            <p style="color:var(--muted);margin-bottom:20px">É necessário um código de acesso válido para usar esta página.</p>
            <button onclick="location.reload()" style="background:var(--accent);color:#fff;border:none;padding:12px 24px;border-radius:8px;font-weight:700;cursor:pointer">Tentar Novamente</button>
          </div>
        `;
        resolve(false);
      });

      input?.addEventListener('keypress', (e) => { if (e.key === 'Enter') submit?.click(); });
    });
  }

  // ============================================================================
  // NOTIFICAÇÕES PWA
  // ============================================================================

  async function requestNotificationPermission() {
    if ('Notification' in window) {
      try {
        const permission = await Notification.requestPermission();
        notificationPermission = permission;
        return permission === 'granted';
      } catch (e) {
        console.warn('Não foi possível solicitar permissão de notificação:', e.message);
        return false;
      }
    }
    return false;
  }

  function playNotificationSound() {
    if (!NOTIFICATION_SOUND_ENABLED) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1000, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.type = 'sine';
      osc.start(); osc.stop(ctx.currentTime + 0.2);
      setTimeout(() => ctx.close(), 250);
    } catch (e) { console.warn('Não foi possível tocar som:', e.message); }
  }

  function vibrateDevice(pattern = [100, 50, 100]) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (e) { console.warn('Não foi possível vibrar:', e.message); }
    }
  }

  function showOrderReadyNotification(order) {
    // ← CORREÇÃO: Usar formatMesaDisplay para notificações
    var mesaDisplay = formatMesaDisplay(order);
    toast('✅ ' + mesaDisplay + ' • ' + (order.itens && order.itens[0] ? order.itens[0].item : 'Pedido') + ' PRONTO!', 'success', 6000);
    playNotificationSound();
    vibrateDevice([200, 100, 200]);
    
    if (notificationPermission === 'granted' && 'Notification' in window) {
      try {
        new Notification('🍳 Pedido Pronto!', {
          body: mesaDisplay + ' • Pronto para retirada',
          icon: 'fazenda-waiter-192.png',
          tag: 'order-' + order.id,
          requireInteraction: true
        });
      } catch (e) { console.warn('Não foi possível mostrar notificação:', e.message); }
    }
  }

  // ============================================================================
  // PREFERÊNCIAS E CACHE
  // ============================================================================

  function saveFilterPreferences() {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ filter: currentFilter, garcom: currentGarcom, timestamp: Date.now() }));
    } catch (e) { console.warn('Falha ao salvar preferências:', e.message); }
  }

  function loadFilterPreferences() {
    try {
      const saved = localStorage.getItem(FILTER_STORAGE_KEY);
      if (saved) {
        const { filter, garcom } = JSON.parse(saved);
        if (filter) currentFilter = filter;
        if (garcom) currentGarcom = garcom;
        return true;
      }
    } catch (e) { console.warn('Falha ao carregar preferências:', e.message); }
    return false;
  }

  function applySavedFilterToUI() {
    els.filterBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === currentFilter);
      btn.setAttribute('aria-selected', btn.dataset.filter === currentFilter);
    });
    if (currentGarcom && els.garcomSelect) els.garcomSelect.value = currentGarcom;
  }

  const CACHE_KEY = 'kfm_waiter_cache';
  const CACHE_TTL = 15 * 60 * 1000;

  function cacheOrders(ordersToCache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ orders: ordersToCache, timestamp: Date.now() })); }
    catch (e) { console.warn('Falha ao salvar cache:', e.message); }
  }

  function loadCachedOrders() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { orders: cachedOrders, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) return cachedOrders;
        localStorage.removeItem(CACHE_KEY);
      }
    } catch (e) { console.warn('Falha ao carregar cache:', e.message); }
    return null;
  }

  // ============================================================================
  // UTILITÁRIOS
  // ============================================================================

  function formatTime(minutes) {
    if (!minutes || minutes < 1) return '< 1min';
    if (minutes < 60) return minutes + 'min';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h + 'h ' + m + 'min';
  }

  function getStatusConfig(status) {
    const map = {
      'pendente': { icon: '⏳', label: 'Pendente', class: 'status-pending' },
      'em-preparo': { icon: '🔥', label: 'Em preparo', class: 'status-preparing' },
      'concluido': { icon: '✅', label: 'Pronto', class: 'status-ready' },
      'cancelled': { icon: '🚫', label: 'Cancelado', class: 'status-cancelled' }
    };
    return map[status] || map['pendente'];
  }

  function isPriorityOrder(order) {
    return order.hasPriority || (order.itens && order.itens.some(function(i) { 
      return i.item && PRIORITY_KEYWORDS.some(function(kw) { 
        return i.item.toLowerCase().indexOf(kw) !== -1; 
      }); 
    }));
  }

  function toast(message, type, duration) {
    type = type || 'info';
    duration = duration || 3000;
    if (!els.toasts) return;
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = message;
    t.setAttribute('role', 'alert');
    els.toasts.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    setTimeout(() => {
      t.style.opacity = '0'; t.style.transform = 'translateY(-20px)';
      setTimeout(() => t.remove(), 300);
    }, duration);
  }

  // ============================================================================
  // API COMMUNICATION
  // ============================================================================

  async function fetchWaitersList() {
    try {
      const response = await fetchWithFallback(API_BASE + '/api/waiter/waiters', { cache: 'no-cache' });
      const data = await response.json();
      if (data.success && data.waiters && data.waiters.length > 0) {
        els.garcomSelect.innerHTML = '<option value="">Todos os garçons</option>';
        data.waiters.forEach(name => {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          els.garcomSelect.appendChild(opt);
        });
        const urlParams = new URLSearchParams(window.location.search);
        const garcomParam = urlParams.get('garcom') || currentGarcom;
        if (garcomParam && data.waiters.indexOf(garcomParam) !== -1) {
          els.garcomSelect.value = garcomParam; currentGarcom = garcomParam;
        }
      }
    } catch (e) {
      console.warn('Falha ao carregar lista de garçons:', e.message);
      const waiters = ['João', 'Maria', 'Carlos', 'Ana'];
      els.garcomSelect.innerHTML = '<option value="">Todos os garçons</option>';
      waiters.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        els.garcomSelect.appendChild(opt);
      });
      toast('⚠️ Usando lista local. Verifique conexão com o Bridge.', 'warning', 4000);
    }
  }

  async function fetchOrders() {
    if (isRefreshing) return;
    isRefreshing = true;
    updateConnectionStatus('loading');

    try {
      // ← MELHORADO: Cache busting mais agressivo para iOS
      var url = API_BASE + '/api/waiter/orders?_=' + Date.now();
      if (isIOS) url += '&_=' + Math.random(); // iOS precisa de mais cache busting
      if (currentGarcom) url += '&garcom=' + encodeURIComponent(currentGarcom);

      const response = await fetchWithFallback(url, { 
        cache: 'no-cache', 
        headers: {'Accept':'application/json'} 
      });
      const data = await response.json();

      if (!data || typeof data !== 'object') {
        throw new Error('Resposta inválida do servidor');
      }

      if (data.success) {
        orders = Array.isArray(data.orders) ? data.orders : [];
        lastUpdate = new Date();
        renderOrders();
        updateLastUpdate();
        
        updateConnectionStatus('online');
        fetchFailCount = 0;

        const newReady = orders.filter(function(o) { 
          return o.status === 'concluido' && !o.notified && (!currentGarcom || o.garcom === currentGarcom); 
        });
        if (newReady.length > 0) {
          newReady.forEach(function(order) { 
            showOrderReadyNotification(order); 
            order.notified = true; 
          });
        }
      } else {
        throw new Error(data.error || 'Erro desconhecido');
      }
    } catch (e) {
      console.error('Erro fetchOrders:', e.message);
      fetchFailCount++;
      
      if (fetchFailCount >= MAX_FETCH_FAILS) {
        updateConnectionStatus('offline');
        toast('⚠️ Conexão instável. Verifique o PC do caixa.', 'warning', 5000);
      } else {
        console.warn('Falha ' + fetchFailCount + '/' + MAX_FETCH_FAILS + ' na conexão');
      }
      
      const cached = loadCachedOrders();
      if (cached && cached.length > 0) {
        orders = cached;
        renderOrders();
        console.log('Usando cache offline');
      }
    } finally {
      isRefreshing = false;
      if (els.loading) els.loading.classList.add('hidden');
    }
  }

  // ============================================================================
  // RENDER - CORRIGIDO: Delivery fix
  // ============================================================================

  function renderOrders() {
    if (!els.ordersList) return;
    
    cacheOrders(orders);
    let filtered = orders;

    if (currentFilter !== 'all') {
      const statusMap = { 'pending': ['pendente'], 'preparing': ['em-preparo'], 'ready': ['concluido'], 'priority': [] };
      if (currentFilter === 'priority') {
        filtered = filtered.filter(function(o) { return isPriorityOrder(o); });
      } else {
        const statuses = statusMap[currentFilter] || [];
        filtered = filtered.filter(function(o) { return statuses.indexOf(o.status) !== -1; });
      }
    }

    if (els.ordersCount) els.ordersCount.textContent = filtered.length + ' pedido(s)';
    if (filtered.length === 0) {
      els.ordersList.innerHTML = '';
      if (els.emptyState) els.emptyState.classList.remove('hidden');
      return;
    }
    if (els.emptyState) els.emptyState.classList.add('hidden');

    filtered.sort(function(a, b) {
      const aPri = isPriorityOrder(a) ? 0 : 1;
      const bPri = isPriorityOrder(b) ? 0 : 1;
      if (aPri !== bPri) return aPri - bPri;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var order = filtered[i];
      var statusCfg = getStatusConfig(order.status);
      var hasPriority = isPriorityOrder(order);
      var elapsed = order.elapsedMinutes || 0;
      
      // ← CORREÇÃO: Usar formatMesaDisplay
      var mesaDisplay = formatMesaDisplay(order);
      
      html += '<article class="order-card ' + (hasPriority ? 'priority ' : '') + statusCfg.class + '" data-order-id="' + order.id + '" role="listitem">';
      if (hasPriority) html += '<div class="priority-badge">👶 Kids/Porção</div>';
      html += '<header class="order-header"><div class="order-mesa">' + escapeHtml(mesaDisplay) + '</div>';
      html += '<div class="order-status ' + statusCfg.class + '"><span class="status-icon">' + statusCfg.icon + '</span><span class="status-label">' + statusCfg.label + '</span></div></header>';
      html += '<div class="order-meta">';
      if (order.garcom) html += '<span class="garcom">Chef ' + escapeHtml(order.garcom) + '</span>';
      html += '<span class="elapsed">⏱️ ' + formatTime(elapsed) + '</span></div>';
      html += '<ul class="order-items">';
      
      if (order.itens && order.itens.length > 0) {
        var maxItems = Math.min(order.itens.length, 3);
        for (var j = 0; j < maxItems; j++) {
          var item = order.itens[j];
          html += '<li class="order-item ' + (item.priority ? 'priority-item' : '') + '">';
          html += '<span class="item-name">' + escapeHtml(item.item || 'Item') + '</span>';
          html += '<span class="item-qty">x' + (item.quantidade || 1) + '</span>';
          if (item.priority) html += '<span class="item-priority">👶</span>';
          html += '</li>';
        }
        if (order.itens.length > 3) {
          html += '<li class="order-item more">+' + (order.itens.length - 3) + ' mais...</li>';
        }
      } else {
        html += '<li class="order-item empty"><small>Sem itens</small></li>';
      }
      html += '</ul>';
      
      if (order.status === 'concluido') {
        html += '<div class="ready-notice">✅ <strong>Pronto para retirada na boqueta!</strong></div>';
      }
      html += '</article>';
    }
    els.ordersList.innerHTML = html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateLastUpdate() {
    if (lastUpdate && els.lastUpdate) {
      els.lastUpdate.textContent = lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
  }

  function updateConnectionStatus(status) {
    if (!els.connStatus) return;
    
    const dot = els.connStatus.querySelector('.status-dot');
    const text = els.connStatus.querySelector('.status-text');
    if (dot) dot.className = 'status-dot ' + status;
    const labels = { 'online': 'Online', 'offline': 'Offline', 'loading': 'Atualizando...' };
    if (text) text.textContent = labels[status] || 'Desconhecido';
  }

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  function setupEventListeners() {
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', () => { 
        if (els.loading) els.loading.classList.remove('hidden'); 
        fetchOrders(); 
      });
    }
    
    if (els.configBtn) {
      els.configBtn.addEventListener('click', () => {
        const current = localStorage.getItem('kfm_api_base') || API_BASE;
        const newApi = prompt('URL do Bridge (ex: http://192.168.0.190:4545):', current);
        if (newApi && newApi.startsWith('http')) {
          localStorage.setItem('kfm_api_base', newApi);
          toast('✅ Configuração salva! Recarregando...', 'success', 2000);
          setTimeout(() => location.reload(), 500);
        } else if (newApi !== null) {
          toast('❌ URL inválida. Deve começar com http://', 'error');
        }
      });
    }

    if (els.garcomSelect) {
      els.garcomSelect.addEventListener('change', (e) => {
        currentGarcom = e.target.value;
        const url = new URL(window.location);
        if (currentGarcom) url.searchParams.set('garcom', currentGarcom); else url.searchParams.delete('garcom');
        window.history.replaceState({}, '', url);
        saveFilterPreferences();
        if (els.loading) els.loading.classList.remove('hidden');
        fetchOrders();
      });
    }

    els.filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        els.filterBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
        currentFilter = btn.dataset.filter;
        saveFilterPreferences();
        renderOrders();
        if (navigator.vibrate) navigator.vibrate(10);
      });
    });

    let pullDistance = 0;
    const PULL_THRESHOLD = 100;
    document.addEventListener('touchstart', (e) => { if (window.scrollY === 0) pullStartY = e.touches[0].clientY; }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (pullStartY && window.scrollY === 0 && !isRefreshing) {
        const currentY = e.touches[0].clientY;
        pullDistance = Math.max(0, currentY - pullStartY);
        if (pullDistance > PULL_THRESHOLD / 2 && els.pullIndicator) {
          els.pullIndicator.classList.remove('hidden');
          els.pullIndicator.querySelector('.pull-icon').textContent = '👍';
          els.pullIndicator.querySelector('.pull-text').textContent = 'Solte para atualizar';
        } else if (els.pullIndicator) {
          els.pullIndicator.classList.add('hidden');
        }
      }
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (pullDistance > PULL_THRESHOLD && !isRefreshing) {
        if (els.pullIndicator) els.pullIndicator.classList.add('hidden');
        if (els.loading) els.loading.classList.remove('hidden');
        fetchOrders();
      }
      pullStartY = 0; pullDistance = 0;
    });

    window.addEventListener('online', () => { 
      updateConnectionStatus('online'); 
      fetchFailCount = 0;
      toast('🟢 Conexão restaurada', 'success', 2000); 
      fetchOrders(); 
    });
    window.addEventListener('offline', () => { 
      updateConnectionStatus('offline'); 
      toast('🔴 Offline - usando cache', 'warning', 3000); 
    });
    document.addEventListener('visibilitychange', () => { 
      if (!document.hidden && pinValidated) fetchOrders(); 
    });

    document.addEventListener('touchstart', () => {
      if (notificationPermission === 'default') {
        requestNotificationPermission().then(granted => { 
          if (granted) toast('🔔 Notificações ativadas!', 'success', 4000); 
        });
      }
    }, { once: true, passive: true });
  }

  // ============================================================================
  // INICIALIZAÇÃO
  // ============================================================================

  async function init() {
    console.log('🚀 Iniciando Kitchen Flow Garçom v1.5...');
    setupEventListeners();
    updateConnectionStatus(navigator.onLine ? 'online' : 'offline');

    const pinOk = await checkPin();
    if (!pinOk) { console.log('🔒 Acesso negado'); return; }

    loadFilterPreferences();
    applySavedFilterToUI();
    await fetchWaitersList();
    await fetchOrders();

    // ← MELHORADO: Intervalo menor para iOS
    var pollInterval = isIOS ? 20000 : POLL_INTERVAL;
    pollIntervalId = setInterval(() => { 
      if (!document.hidden && navigator.onLine && pinValidated) fetchOrders(); 
    }, pollInterval);
    
    setInterval(() => {
      if (!isPinValidForToday(getSavedPin(), localStorage.getItem(PIN_DATE_KEY))) {
        console.log('🔒 PIN expirado'); clearPin(); pinValidated = false;
        toast('🔐 Código expirado. Solicite novo código à gerente.', 'warning', 5000);
      }
    }, 60 * 60 * 1000);

    if ('serviceWorker' in navigator && pinValidated) {
      navigator.serviceWorker.register('/sw-waiter.js')
        .then(reg => console.log('✅ [PWA] SW registrado:', reg.scope))
        .catch(err => console.warn('⚠️ [PWA] SW registration failed:', err));
    }

    console.log('✅ Kitchen Flow Garçom v1.5 inicializado');
    console.log('🔗 API Base:', API_BASE);
    console.log('🔐 PIN:', pinValidated ? 'válido' : 'inválido');
    console.log('📱 iOS:', isIOS ? 'Sim' : 'Não');
  }

  window.addEventListener('beforeunload', () => {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
