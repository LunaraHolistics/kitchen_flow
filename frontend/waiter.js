/**
 * Kitchen Flow - Página do Garçom v1.3
 * Funcionalidades: PIN diário, PWA notifications, filtro salvo, polling, pull-to-refresh
 * Hotfix v1.3: Status robusto + cache busting + contador de falhas
 */
(() => {
  'use strict';

  // ============================================================================
  // CONFIGURAÇÕES INTELIGENTES
  // ============================================================================

  // ← NOVO: API_BASE dinâmica com fallback
  const getApiBase = () => {
    // 1. Prioridade: Parâmetro na URL (ex: ?api=http://192.168.0.190:4545)
    const urlParams = new URLSearchParams(window.location.search);
    const urlApi = urlParams.get('api');
    if (urlApi && urlApi.startsWith('http')) {
      console.log('🔌 API definida via URL:', urlApi);
      return urlApi;
    }

    // 2. Prioridade: localStorage (configuração salva pelo usuário)
    const saved = localStorage.getItem('kfm_api_base');
    if (saved && saved.startsWith('http')) {
      console.log('🔌 API carregada do localStorage:', saved);
      return saved;
    }

    // 3. Detectar ambiente
    const hostname = window.location.hostname;
    
    // Se estiver em domínio público (Netlify/Vercel), usar IPs locais comuns
    if (hostname.includes('netlify') || hostname.includes('vercel') || !hostname.includes('localhost')) {
      console.log('🌐 Ambiente cloud detectado. Usando fallback de IPs locais.');
      // Retorna o primeiro IP comum; fallback é tratado no fetchWithFallback
      return 'http://192.168.0.190:4545';
    }
    
    // 4. Default: localhost (desenvolvimento)
    return 'http://localhost:4545';
  };

  const API_BASE = getApiBase();
  const POLL_INTERVAL = 30000; // 30 segundos
  const PRIORITY_KEYWORDS = ['kids', 'infantil', 'criança', 'batata', 'porção', 'tirinhas', 'salada', 'nugget'];

  // ← NOVO: Configurações de PIN e Notificações
  const PIN_STORAGE_KEY = 'kfm_waiter_pin';
  const PIN_DATE_KEY = 'kfm_waiter_pin_date';
  const FILTER_STORAGE_KEY = 'kfm_waiter_filter';
  const NOTIFICATION_SOUND_ENABLED = true;

  // Estado
  let orders = [];
  let currentFilter = 'all';
  let currentGarcom = '';
  let lastUpdate = null;
  let isRefreshing = false;
  let pullStartY = 0;
  let pinValidated = false;
  let notificationPermission = 'default';
  let fetchFailCount = 0; // ← NOVO: Contador de falhas consecutivas
  const MAX_FETCH_FAILS = 3; // ← NOVO: Máximo de falhas antes de marcar offline

  // Seletores DOM
  const $ = (sel, context = document) => context.querySelector(sel);
  const $$ = (sel, context = document) => context.querySelectorAll(sel);

  const els = {
    loading: $('#loading'),
    ordersList: $('#ordersList'),
    emptyState: $('#emptyState'),
    garcomSelect: $('#garcomSelect'),
    refreshBtn: $('#refreshBtn'),
    configBtn: $('#configBtn'), // ← NOVO: Botão de configuração
    connStatus: $('#connStatus'),
    lastUpdate: $('#lastUpdate'),
    ordersCount: $('#ordersCount'),
    toasts: $('#toasts'),
    pullIndicator: $('#pullIndicator'),
    filterBtns: $$('.filter-btn')
  };

  // ============================================================================
  // ← NOVO: FETCH COM TIMEOUT E FALLBACK DE IPs
  // ============================================================================

  async function fetchWithFallback(url, options = {}) {
    // Lista de bases para tentar (fallback)
    const bases = [
      API_BASE,
      API_BASE.replace('192.168.0.190', '192.168.1.190'),
      API_BASE.replace('192.168.1.190', '192.168.0.100'),
      API_BASE.replace('192.168.0.100', '192.168.1.100'),
      API_BASE.replace('192.168.1.100', '10.0.0.100')
    ].filter((v, i, a) => a.indexOf(v) === i); // Remover duplicatas
    
    let lastError = null;
    
    for (const base of bases) {
      const testUrl = url.replace(API_BASE, base);
      
      try {
        console.debug(`🔌 Tentando: ${testUrl}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos
        
        const response = await fetch(testUrl, {
          ...options,
          signal: controller.signal,
          headers: { 'Accept': 'application/json', ...options.headers }
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          // Salvar IP que funcionou para próximas requisições
          if (base !== API_BASE) {
            localStorage.setItem('kfm_api_base', base);
            console.log(`✅ API funcionando em: ${base}`);
            toast(`🟢 Conectado ao Bridge em ${base}`, 'success', 3000);
          }
          return response;
        }
        
        lastError = new Error(`HTTP ${response.status}`);
      } catch (e) {
        lastError = e;
        console.debug(`❌ Falha em ${base}: ${e.name} - ${e.message}`);
        // Continua para próximo IP
      }
    }
    
    // Se chegou aqui, todos falharam
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
        const serverPin = await fetchWithFallback(`${API_BASE}/api/waiter/pin`, { cache: 'no-cache' });
        const data = await serverPin.json();
        if (savedPin === data.pin) {
          pinValidated = true;
          sessionStorage.setItem('waiter_pin_validated', 'true');
          return true;
        }
        clearPin();
      } catch (e) {
        console.warn('⚠️ Não foi possível verificar PIN:', e.message);
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
          const response = await fetchWithFallback(`${API_BASE}/api/waiter/pin`, { cache: 'no-cache' });
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
        console.warn('⚠️ Não foi possível solicitar permissão de notificação:', e.message);
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
    } catch (e) { console.warn('⚠️ Não foi possível tocar som:', e.message); }
  }

  function vibrateDevice(pattern = [100, 50, 100]) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (e) { console.warn('⚠️ Não foi possível vibrar:', e.message); }
    }
  }

  function showOrderReadyNotification(order) {
    toast(`✅ ${order.mesa} • ${order.itens?.[0]?.item || 'Pedido'} PRONTO!`, 'success', 6000);
    playNotificationSound();
    vibrateDevice([200, 100, 200]);
    
    if (notificationPermission === 'granted' && 'Notification' in window) {
      try {
        new Notification('🍳 Pedido Pronto!', {
          body: `${order.mesa} • Pronto para retirada`,
          icon: 'fazenda-waiter-192.png',
          tag: `order-${order.id}`,
          requireInteraction: true
        });
      } catch (e) { console.warn('⚠️ Não foi possível mostrar notificação:', e.message); }
    }
  }

  // ============================================================================
  // PREFERÊNCIAS E CACHE
  // ============================================================================

  function saveFilterPreferences() {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ filter: currentFilter, garcom: currentGarcom, timestamp: Date.now() }));
    } catch (e) { console.warn('⚠️ Falha ao salvar preferências:', e.message); }
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
    } catch (e) { console.warn('⚠️ Falha ao carregar preferências:', e.message); }
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
    catch (e) { console.warn('⚠️ Falha ao salvar cache:', e.message); }
  }

  function loadCachedOrders() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { orders: cachedOrders, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) return cachedOrders;
        localStorage.removeItem(CACHE_KEY);
      }
    } catch (e) { console.warn('⚠️ Falha ao carregar cache:', e.message); }
    return null;
  }

  // ============================================================================
  // UTILITÁRIOS
  // ============================================================================

  function formatTime(minutes) {
    if (minutes < 1) return '< 1min';
    if (minutes < 60) return `${minutes}min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m}min`;
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
    return order.hasPriority || order.itens?.some(i => i.item && PRIORITY_KEYWORDS.some(kw => i.item.toLowerCase().includes(kw)));
  }

  function toast(message, type = 'info', duration = 3000) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
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
      const response = await fetchWithFallback(`${API_BASE}/api/waiter/waiters`, { cache: 'no-cache' });
      const data = await response.json();
      if (data.success && data.waiters?.length > 0) {
        els.garcomSelect.innerHTML = '<option value="">Todos os garçons</option>';
        data.waiters.forEach(name => {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          els.garcomSelect.appendChild(opt);
        });
        const urlParams = new URLSearchParams(window.location.search);
        const garcomParam = urlParams.get('garcom') || currentGarcom;
        if (garcomParam && data.waiters.includes(garcomParam)) {
          els.garcomSelect.value = garcomParam; currentGarcom = garcomParam;
        }
      }
    } catch (e) {
      console.warn('⚠️ Falha ao carregar lista de garçons:', e.message);
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

  // ← CORRIGIDO: fetchOrders com status robusto e cache busting
  async function fetchOrders() {
    if (isRefreshing) return;
    isRefreshing = true;
    updateConnectionStatus('loading');

    try {
      // ← NOVO: Cache busting obrigatório para evitar dados antigos
      const url = new URL(`${API_BASE}/api/waiter/orders`);
      url.searchParams.set('_', Date.now()); // Evita cache do navegador
      if (currentGarcom) url.searchParams.set('garcom', currentGarcom);

      const response = await fetchWithFallback(url, { 
        cache: 'no-cache', 
        headers: {'Accept':'application/json'} 
      });
      const data = await response.json();

      if (data.success) {
        orders = data.orders;
        lastUpdate = new Date();
        renderOrders();
        updateLastUpdate();
        
        // 🔥 FORÇA STATUS ONLINE NO SUCESSO
        updateConnectionStatus('online');
        fetchFailCount = 0; // ← NOVO: Reseta contador de falhas

        const newReady = orders.filter(o => o.status === 'concluido' && !o.notified && (!currentGarcom || o.garcom === currentGarcom));
        if (newReady.length > 0) {
          newReady.forEach(order => { showOrderReadyNotification(order); order.notified = true; });
        }
      } else {
        throw new Error(data.error || 'Erro desconhecido');
      }
    } catch (e) {
      console.error('❌ Erro fetchOrders:', e.message);
      fetchFailCount++; // ← NOVO: Incrementa contador
      
      // ← NOVO: Só muda para offline se falhar 3x seguidas
      if (fetchFailCount >= MAX_FETCH_FAILS) {
        updateConnectionStatus('offline');
        toast('⚠️ Conexão instável. Verifique o PC do caixa.', 'warning', 5000);
      } else {
        console.warn(`⚠️ Falha ${fetchFailCount}/${MAX_FETCH_FAILS} na conexão`);
      }
      
      const cached = loadCachedOrders();
      if (cached?.length > 0) {
        orders = cached;
        renderOrders();
        console.log('📦 Usando cache offline');
      }
    } finally {
      isRefreshing = false;
      els.loading.classList.add('hidden');
    }
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  function renderOrders() {
    cacheOrders(orders);
    let filtered = orders;

    if (currentFilter !== 'all') {
      const statusMap = { 'pending': ['pendente'], 'preparing': ['em-preparo'], 'ready': ['concluido'], 'priority': [] };
      if (currentFilter === 'priority') {
        filtered = filtered.filter(o => isPriorityOrder(o));
      } else {
        const statuses = statusMap[currentFilter] || [];
        filtered = filtered.filter(o => statuses.includes(o.status));
      }
    }

    els.ordersCount.textContent = `${filtered.length} pedido(s)`;
    if (filtered.length === 0) {
      els.ordersList.innerHTML = '';
      els.emptyState.classList.remove('hidden');
      return;
    }
    els.emptyState.classList.add('hidden');

    filtered.sort((a, b) => {
      const aPri = isPriorityOrder(a) ? 0 : 1;
      const bPri = isPriorityOrder(b) ? 0 : 1;
      if (aPri !== bPri) return aPri - bPri;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    els.ordersList.innerHTML = filtered.map(order => {
      const statusCfg = getStatusConfig(order.status);
      const hasPriority = isPriorityOrder(order);
      const elapsed = order.elapsedMinutes || 0;
      return `
        <article class="order-card ${hasPriority ? 'priority' : ''} ${statusCfg.class}" data-order-id="${order.id}" role="listitem">
          ${hasPriority ? `<div class="priority-badge">👶 Kids/Porção</div>` : ''}
          <header class="order-header">
            <div class="order-mesa">${order.mesa}</div>
            <div class="order-status ${statusCfg.class}">
              <span class="status-icon">${statusCfg.icon}</span>
              <span class="status-label">${statusCfg.label}</span>
            </div>
          </header>
          <div class="order-meta">
            ${order.garcom ? `<span class="garcom">👨‍🍳 ${order.garcom}</span>` : ''}
            <span class="elapsed">⏱️ ${formatTime(elapsed)}</span>
          </div>
          <ul class="order-items">
            ${order.itens?.slice(0, 3).map(item => `
              <li class="order-item ${item.priority ? 'priority-item' : ''}">
                <span class="item-name">${item.item}</span>
                <span class="item-qty">x${item.quantidade || 1}</span>
                ${item.priority ? '<span class="item-priority">👶</span>' : ''}
              </li>
            `).join('') || '<li class="order-item empty"><small>Sem itens</small></li>'}
            ${order.itens?.length > 3 ? `<li class="order-item more">+${order.itens.length - 3} mais...</li>` : ''}
          </ul>
          ${order.status === 'concluido' ? `<div class="ready-notice">✅ <strong>Pronto para retirada na boqueta!</strong></div>` : ''}
        </article>`;
    }).join('');
  }

  function updateLastUpdate() {
    if (lastUpdate) els.lastUpdate.textContent = lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function updateConnectionStatus(status) {
    const dot = els.connStatus.querySelector('.status-dot');
    const text = els.connStatus.querySelector('.status-text');
    if (dot) dot.className = `status-dot ${status}`;
    const labels = { 'online': 'Online', 'offline': 'Offline', 'loading': 'Atualizando...' };
    if (text) text.textContent = labels[status] || 'Desconhecido';
  }

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  function setupEventListeners() {
    els.refreshBtn.addEventListener('click', () => { 
      els.loading.classList.remove('hidden'); 
      fetchOrders(); 
    });
    
    // ← NOVO: Botão de configuração de API
    els.configBtn?.addEventListener('click', () => {
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

    els.garcomSelect.addEventListener('change', (e) => {
      currentGarcom = e.target.value;
      const url = new URL(window.location);
      if (currentGarcom) url.searchParams.set('garcom', currentGarcom); else url.searchParams.delete('garcom');
      window.history.replaceState({}, '', url);
      saveFilterPreferences();
      els.loading.classList.remove('hidden'); fetchOrders();
    });

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

    // Pull to refresh
    let pullDistance = 0;
    const PULL_THRESHOLD = 100;
    document.addEventListener('touchstart', (e) => { if (window.scrollY === 0) pullStartY = e.touches[0].clientY; }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (pullStartY && window.scrollY === 0 && !isRefreshing) {
        const currentY = e.touches[0].clientY;
        pullDistance = Math.max(0, currentY - pullStartY);
        if (pullDistance > PULL_THRESHOLD / 2) {
          els.pullIndicator.classList.remove('hidden');
          els.pullIndicator.querySelector('.pull-icon').textContent = '👍';
          els.pullIndicator.querySelector('.pull-text').textContent = 'Solte para atualizar';
        } else els.pullIndicator.classList.add('hidden');
      }
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (pullDistance > PULL_THRESHOLD && !isRefreshing) {
        els.pullIndicator.classList.add('hidden');
        els.loading.classList.remove('hidden');
        fetchOrders();
      }
      pullStartY = 0; pullDistance = 0;
    });

    window.addEventListener('online', () => { 
      updateConnectionStatus('online'); 
      fetchFailCount = 0; // ← NOVO: Reseta contador ao reconectar
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
    console.log('🚀 Iniciando Kitchen Flow Garçom v1.3...');
    setupEventListeners();
    updateConnectionStatus(navigator.onLine ? 'online' : 'offline');

    const pinOk = await checkPin();
    if (!pinOk) { console.log('🔒 Acesso negado'); return; }

    loadFilterPreferences();
    applySavedFilterToUI();
    await fetchWaitersList();
    await fetchOrders();

    if (notificationPermission === 'default') { /* Aguardar interação */ }

    setInterval(() => { if (!document.hidden && navigator.onLine && pinValidated) fetchOrders(); }, POLL_INTERVAL);
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

    console.log('✅ Kitchen Flow Garçom v1.3 inicializado');
    console.log('🔗 API Base:', API_BASE);
    console.log('🔐 PIN:', pinValidated ? 'válido' : 'inválido');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();