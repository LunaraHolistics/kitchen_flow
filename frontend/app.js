/**
 * Kitchen Flow Monitor - Frontend Tablet v2.1.4
 * Backend: https://kitchen-flow-swq2.onrender.com
 * Features: Controle por item, cancelamento com alerta, wait time por item, garçom visível, PWA reforçado
 */
(() => {
  'use strict';

  // ============================================================================
  // CONFIGURAÇÃO INICIAL
  // ============================================================================

  const getBackendUrl = () => {
    const saved = localStorage.getItem('kfm_backend_url');
    if (saved && saved.startsWith('http')) return saved;
    return 'https://kitchen-flow-swq2.onrender.com';
  };

  const BACKEND_URL = getBackendUrl();
  const WS_URL = BACKEND_URL.replace('http', 'ws').replace('https', 'wss');

  // Limites para alertas visuais de tempo (em segundos)
  const TIMER_WARN_THRESHOLD = 300;   // 5 min → amarelo
  const TIMER_CRITICAL_THRESHOLD = 600; // 10 min → vermelho/piscando

  console.log('🔌 Kitchen Flow v2.1.4');
  console.log('🔌 Backend:', BACKEND_URL);
  console.log('🔌 WebSocket:', WS_URL);

  const SECTORS = ['Frios', 'Saladas', 'Fritadeira', 'Entradas', 'Fogão', 'Sobremesas'];

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
  
  // ← NOVO: Estado para cancelamento
  let cancelAlert = null; // { orderId, itemId, table, reason, timestamp } | null

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
    // ← NOVO: Elementos do banner de cancelamento
    cancelBanner: $('#cancelBanner'),
    cancelMessage: $('#cancelMessage'),
    cancelClose: $('#cancelClose')
    // ← REMOVIDO: soundCancel não é mais necessário (usamos Web Audio API puro)
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
    if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function getTimeClass(seconds) {
    if (seconds >= TIMER_CRITICAL_THRESHOLD) return 'critical';
    if (seconds >= TIMER_WARN_THRESHOLD) return 'high';
    return '';
  }

  // ← NOVO: Cor do badge por tempo de preparo
  function getWaitTimeClass(seconds) {
    if (seconds == null) return '';
    if (seconds < 300) return 'wait-fast';    // <5min → verde
    if (seconds < 600) return 'wait-medium';  // 5-10min → amarelo
    return 'wait-slow';                        // >10min → vermelho
  }

  // ← CORREÇÃO: Gerar ID único para item dentro do pedido (parâmetros corrigidos)
  function getItemId(orderId, setor, index) {
    return `${orderId}_${setor}_${index}`;
  }

  // ============================================================================
  // SINCRONIZAÇÃO DE HORÁRIO
  // ============================================================================

  async function syncTimeWithServer() {
    try {
      const now = Date.now();
      const response = await fetch(`${BACKEND_URL}/api/time`, { 
        method: 'GET', cache: 'no-cache', signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        const data = await response.json();
        const serverTime = new Date(data.timestamp).getTime();
        const roundTripTime = Date.now() - now;
        serverTimeOffset = serverTime - (now + roundTripTime / 2);
        lastTimeSync = Date.now();
        console.log('🕐 Horário sincronizado. Offset:', serverTimeOffset, 'ms');
      }
    } catch (e) {
      console.warn('⚠️ Não foi possível sincronizar horário:', e.message);
      serverTimeOffset = 0;
    }
  }

  function getServerTime() {
    return new Date(Date.now() + serverTimeOffset);
  }

  setInterval(() => { if (isInitialized) syncTimeWithServer(); }, 5 * 60 * 1000);
  syncTimeWithServer();

  // ============================================================================
  // UI: TOAST NOTIFICATIONS
  // ============================================================================

  function toast(message, type = 'info', duration = 4000) {
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;
    t.setAttribute('role', 'alert');
    t.innerHTML = `<span>${escapeHtml(message)}</span>`;
    els.toasts.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(0)'; });
    setTimeout(() => {
      t.style.opacity = '0'; t.style.transform = 'translateX(20px)';
      setTimeout(() => t.remove(), 300);
    }, duration);
  }

  // ============================================================================
  // UI: MODAL DE CONFIRMAÇÃO
  // ============================================================================

  function showModal(message, onConfirm, onCancel) {
    els.modalMsg.textContent = message;
    els.modal.show?.() || (els.modal.style.display = 'flex');
    const cleanup = () => {
      els.modal.close?.() || (els.modal.style.display = 'none');
      els.modalYes.onclick = null;
      els.modalNo.onclick = null;
    };
    els.modalYes.onclick = () => { cleanup(); if (typeof onConfirm === 'function') onConfirm(); };
    els.modalNo.onclick = () => { cleanup(); if (typeof onCancel === 'function') onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
  }

  // ============================================================================
  // SOM: Sistema de Alerta (Web Audio API - sem arquivos)
  // ============================================================================

  function playDing(volume = 0.3) {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.type = 'sine';
      osc.start(); osc.stop(ctx.currentTime + 0.35);
      setTimeout(() => ctx.close(), 400);
    } catch (e) { console.warn('⚠️ Som não reproduzido:', e.message); }
  }

  // ← CORREÇÃO: Som de alerta para cancelamento (Web Audio API puro, sem arquivo)
  function playCancelAlert(volume = 0.4) {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      
      // Oscilador principal (tom agudo)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.frequency.setValueAtTime(880, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
      gain1.gain.setValueAtTime(volume, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc1.type = 'square';
      
      // Segundo oscilador para efeito de "alarme" (batida)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.setValueAtTime(660, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(330, ctx.currentTime + 0.2);
      gain2.gain.setValueAtTime(volume * 0.7, ctx.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc2.type = 'triangle';
      
      // Tocar ambos
      osc1.start(); osc1.stop(ctx.currentTime + 0.4);
      osc2.start(); osc2.stop(ctx.currentTime + 0.45);
      
      // Limpar contexto
      setTimeout(() => ctx.close(), 500);
    } catch (e) { console.warn('⚠️ Som de cancelamento não reproduzido:', e.message); }
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    if (els.soundToggle) {
      els.soundToggle.textContent = soundEnabled ? '🔔' : '🔕';
      els.soundToggle.classList.toggle('muted', !soundEnabled);
      els.soundToggle.setAttribute('aria-label', soundEnabled ? 'Desativar som' : 'Ativar som');
      els.soundToggle.setAttribute('aria-pressed', soundEnabled);
    }
    toast(soundEnabled ? '🔔 Som ativado' : '🔕 Som silenciado', 'info', 2000);
    localStorage.setItem('kfm_sound_enabled', soundEnabled);
  }

  // ============================================================================
  // CLOCK E TIMERS
  // ============================================================================

  function startClock() {
    const update = () => {
      const now = getServerTime();
      els.clock.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
    };
    update(); setInterval(update, 1000);
  }

  function startTimers() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const now = Date.now();
      // Atualizar timers na aba Geral (por pedido)
      orders.forEach(order => {
        if (order.status === 'em-preparo' && order.startedAt) {
          const started = new Date(order.startedAt).getTime();
          const elapsed = Math.floor((now - started) / 1000);
          const timerEl = $(`#timer-${order.id}`);
          if (timerEl) {
            timerEl.textContent = formatTime(elapsed);
            timerEl.className = `timer ${getTimeClass(elapsed)}`.trim();
          }
        }
        // ← NOVO: Atualizar timers por item (se existirem)
        if (order.itens) {
          order.itens.forEach((item, idx) => {
            if (item.status === 'em-preparo' && item.startedAt) {
              const started = new Date(item.startedAt).getTime();
              const elapsed = Math.floor((now - started) / 1000);
              const itemTimerEl = $(`#item-timer-${order.id}-${idx}`);
              if (itemTimerEl) {
                itemTimerEl.textContent = formatTime(elapsed);
                itemTimerEl.className = `mini-timer ${getTimeClass(elapsed)}`.trim();
              }
            }
          });
        }
      });
      // Atualizar mini-timers na aba Setor
      $$('.mini-timer').forEach(el => {
        const startedAt = el.dataset.started;
        if (startedAt) {
          const started = new Date(startedAt).getTime();
          const elapsed = Math.floor((now - started) / 1000);
          el.textContent = formatTime(elapsed);
          el.className = `mini-timer ${getTimeClass(elapsed)}`.trim();
        }
      });
    }, 1000);
  }

  function stopTimers() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // ============================================================================
  // WEBSOCKET: Conexão e Mensagens
  // ============================================================================

  function connect() {
    console.log(`🔌 Conectando WebSocket: ${WS_URL}`);
    els.loadingStatus?.textContent = 'Conectando...';
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('❌ Erro ao inicializar WebSocket:', e);
      updateConnectionStatus(false); scheduleReconnect(); return;
    }
    ws.onopen = () => {
      console.log('✅ WebSocket conectado');
      updateConnectionStatus(true); reconnectAttempts = 0;
      els.loadingStatus?.textContent = 'Sincronizando...';
      toast('🟢 Conectado ao servidor', 'info', 2000);
      syncTimeWithServer();
    };
    ws.onclose = (event) => {
      console.log(`🔌 WebSocket desconectado (code: ${event.code})`);
      updateConnectionStatus(false);
      if (isInitialized) { toast('Conexão perdida. Reconectando...', 'warning'); scheduleReconnect(); }
    };
    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      updateConnectionStatus(false);
      if (reconnectAttempts === 0 && isInitialized) toast('Erro de conexão com o servidor', 'error');
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { type, ...payload } = data;
        handleServerMessage(type, payload);
      } catch (err) { console.error('❌ Erro ao parsear mensagem:', err); }
    };
  }

  function updateConnectionStatus(online) {
    if (!els.connStatus) return;
    if (online) {
      els.connStatus.textContent = '🟢 Online';
      els.connStatus.className = 'status online';
      els.connStatus.setAttribute('aria-label', 'Conectado');
    } else {
      els.connStatus.textContent = '🔴 Offline';
      els.connStatus.className = 'status offline';
      els.connStatus.setAttribute('aria-label', 'Desconectado');
    }
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      toast('Não foi possível reconectar. Recarregue a página.', 'error', 8000);
      els.loadingStatus?.textContent = 'Falha na conexão'; return;
    }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
    reconnectAttempts++;
    console.log(`🔄 Reconectando em ${delay}ms (tentativa ${reconnectAttempts}/${MAX_RECONNECT})`);
    els.loadingStatus?.textContent = `Reconectando em ${Math.ceil(delay / 1000)}s...`;
    setTimeout(() => { if (!ws || ws.readyState !== WebSocket.OPEN) connect(); }, delay);
  }

  function send(type, payload = {}) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload })); return true;
    }
    toast('Sem conexão com o servidor', 'error'); return false;
  }

  // ============================================================================
  // HANDLER DE MENSAGENS DO SERVIDOR
  // ============================================================================

  function handleServerMessage(type, data) {
    switch (type) {
      case 'INIT':
        orders = data.orders || []; clientId = data.clientId;
        if (clientId && els.clientId) { els.clientId.textContent = `📱 ${clientId.slice(0, 8)}`; els.clientId.title = `ID: ${clientId}`; }
        isInitialized = true; hideLoading(); renderAll(); startTimers(); break;
      case 'CONNECTED':
        clientId = data.clientId;
        if (clientId && els.clientId) els.clientId.textContent = `📱 ${clientId.slice(0, 8)}`; break;
      case 'NEW_ORDER':
        if (!orders.find(o => o.id === data.order?.id)) {
          orders.unshift(data.order); renderAll();
          toast(`🔔 Novo pedido: ${data.order.mesa}`, 'info', 3000); playDing();
        } break;
      case 'ORDER_UPDATED':
        const idx = orders.findIndex(o => o.id === data.order?.id);
        if (idx > -1) {
          console.log('📥 Pedido atualizado:', data.order.id, data.order.status);
          orders[idx] = data.order; renderAll();
          if (data.order.status === 'em-preparo') startTimers();
        } break;
      // ← NOVO: Handler para cancelamento de pedido/item
      case 'CANCEL_ORDER':
        const { orderId, itemId, table, reason } = data.payload || {};
        console.log('🚫 Cancelamento recebido:', { orderId, itemId, table, reason });
        
        // Mostrar banner de alerta
        showCancelBanner(table, reason || 'Solicitação do cliente');
        
        // Atualizar pedido localmente
        const order = orders.find(o => o.id === orderId);
        if (order) {
          if (itemId) {
            // Cancelar item específico
            const itemIdx = order.itens?.findIndex(i => i.id === itemId || i.item.includes(itemId));
            if (itemIdx > -1 && order.itens[itemIdx]) {
              order.itens[itemIdx].status = 'cancelled';
              order.itens[itemIdx].cancelledAt = new Date().toISOString();
              order.itens[itemIdx].cancelReason = reason;
            }
          } else {
            // Cancelar pedido inteiro
            order.status = 'cancelled';
            order.cancelledAt = new Date().toISOString();
            order.cancelReason = reason;
          }
          renderAll();
          // Scroll até o pedido cancelado
          setTimeout(() => scrollToOrder(orderId), 500);
        }
        break;
      case 'ORDER_DELETED':
        const before = orders.length;
        orders = orders.filter(o => o.id !== data.orderId);
        if (orders.length < before) { renderAll(); toast('🗑️ Pedido removido', 'info', 2000); } break;
      case 'PING': send('PONG', { clientId, timestamp: Date.now() }); break;
    }
  }

  // ============================================================================
  // ← NOVO: Banner de Cancelamento + Scroll
  // ============================================================================

  function showCancelBanner(table, reason) {
    cancelAlert = { table, reason, timestamp: new Date().toISOString() };
    
    if (els.cancelBanner && els.cancelMessage) {
      els.cancelMessage.textContent = `🚫 CANCELAMENTO: ${table} • ${reason}`;
      els.cancelBanner.classList.remove('hidden');
      els.cancelBanner.classList.add('visible');
      
      // Tocar som de alerta (Web Audio API puro)
      playCancelAlert();
      
      // Auto-esconder após 15 segundos (mas manter no estado)
      setTimeout(() => {
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
    const card = $(`[data-order-id="${orderId}"]`);
    if (card) {
      // Destacar card temporariamente
      card.classList.add('highlight');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      // Remover destaque após animação
      setTimeout(() => card.classList.remove('highlight'), 3000);
    }
  }

  // ============================================================================
  // RENDER: Aba GERAL (com controle por item + garçom visível)
  // ============================================================================

  function renderGeral() {
    const ativos = orders.filter(o => 
      o.status !== 'concluido' && o.status !== 'cancelled' &&
      !o.itens?.every(i => i.setor === 'Bebidas')
    );

    if (els.badges.geral) {
      els.badges.geral.textContent = ativos.length;
      els.badges.geral.setAttribute('aria-label', `${ativos.length} pedido(s) ativo(s)`);
    }

    if (ativos.length === 0) {
      els.ordersGeral.innerHTML = `
        <div class="empty" role="status">
          <span class="empty-icon" aria-hidden="true">🍽️</span>
          <p>Nenhum pedido ativo</p>
          <small>Aguardando pedidos do Saipos...</small>
        </div>`;
      return;
    }

    els.ordersGeral.innerHTML = ativos.map(order => {
      const isDelivery = order.tipo === 'delivery';
      const isInPrep = order.status === 'em-preparo';
      const isCancelled = order.status === 'cancelled';
      const startedAt = order.startedAt ? new Date(order.startedAt) : null;
      const elapsed = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : 0;
      const timeClass = getTimeClass(elapsed);

      return `
        <article class="order-card ${isDelivery ? 'delivery' : ''} ${isInPrep ? 'in-prep' : ''} ${isCancelled ? 'cancelled' : ''}" 
                 data-order-id="${order.id}" aria-labelledby="order-title-${order.id}">
          ${isCancelled ? `<div class="cancel-ribbon">🚫 CANCELADO</div>` : ''}
          
          <header class="order-header">
            <div>
              <div class="order-mesa" id="order-title-${order.id}">${escapeHtml(order.mesa)}</div>
              <span class="order-type ${order.tipo}" role="label">${order.tipo.toUpperCase()}</span>
              ${order.garcom && order.garcom !== 'Desconhecido' 
                ? `<div class="order-garcom" title="Garçom responsável">👨‍🍳 ${escapeHtml(order.garcom)}</div>` 
                : ''}
            </div>
            <div class="order-time" aria-label="Tempo de preparo">
              ${isInPrep && !isCancelled
                ? `<span id="timer-${order.id}" class="timer ${timeClass}" data-elapsed="${elapsed}">${formatTime(elapsed)}</span>` 
                : isCancelled 
                  ? `<span class="timer cancelled">CANCELADO</span>`
                  : `<span>${order.horario}</span>`}
            </div>
          </header>
          
          <ul class="order-items" aria-label="Itens do pedido">
            ${order.itens?.map((it, i) => {
              const itemStatus = it.status || order.status;
              const itemStarted = it.startedAt ? new Date(it.startedAt) : (order.startedAt ? new Date(order.startedAt) : null);
              const itemElapsed = itemStarted ? Math.floor((Date.now() - itemStarted.getTime()) / 1000) : null;
              const waitTime = it.completedAt && it.startedAt 
                ? Math.floor((new Date(it.completedAt) - new Date(it.startedAt)) / 1000) 
                : null;
              const waitClass = getWaitTimeClass(waitTime);
              const itemId = getItemId(order.id, it.setor, i);
              
              return `
              <li class="order-item ${itemStatus === 'cancelled' ? 'cancelled' : ''} ${itemStatus === 'em-preparo' ? 'in-prep' : ''}" 
                  data-item-id="${itemId}" data-status="${itemStatus}">
                <div class="item-content">
                  <div>
                    <span class="sector" aria-label="Setor">${escapeHtml(it.setor)}</span>
                    <span class="name">${escapeHtml(it.item)}</span>
                    ${waitTime != null ? `<span class="wait-time ${waitClass}" title="Tempo de preparo">⏱️ ${formatTime(waitTime)}</span>` : ''}
                  </div>
                  <span class="qty" aria-label="Quantidade">x${it.quantidade}</span>
                </div>
                ${itemStatus !== 'cancelled' ? `
                <div class="item-actions">
                  ${itemStatus === 'pendente' 
                    ? `<button class="btn-item btn-start" onclick="window.startItem('${order.id}', ${i})" aria-label="Iniciar ${escapeHtml(it.item)}">▶</button>` 
                    : itemStatus === 'em-preparo'
                      ? `<button class="btn-item btn-done" onclick="window.completeItem('${order.id}', ${i})" aria-label="Concluir ${escapeHtml(it.item)}">✅</button>`
                      : ''}
                </div>` : `<span class="cancelled-badge">🚫</span>`}
              </li>`;
            }).join('') || '<li class="order-item empty"><small>Sem itens</small></li>'}
          </ul>
          
          <footer class="order-actions" role="group" aria-label="Ações do pedido">
            ${!isCancelled && !isInPrep
              ? `<button class="btn btn-primary" onclick="window.startOrder(${order.id})" aria-label="Iniciar preparo de ${order.mesa}">▶ Iniciar</button>
                 <button class="btn btn-secondary" onclick="window.markReady(${order.id})" aria-label="Marcar ${order.mesa} como pronto">✅ Pronto</button>`
              : isCancelled
                ? `<button class="btn btn-danger" disabled>Cancelado</button>`
                : `<button class="btn btn-secondary" onclick="window.markReady(${order.id})" aria-label="Marcar ${order.mesa} como pronto">✅ Pronto</button>`}
          </footer>
        </article>`;
    }).join('');
  }

  // ============================================================================
  // RENDER: Aba SETOR (com controle por item + garçom no tooltip)
  // ============================================================================

  function renderSetor() {
    const ativos = orders.filter(o => 
      o.status !== 'concluido' && o.status !== 'cancelled' &&
      o.itens?.some(i => i.setor !== 'Bebidas' && i.status !== 'cancelled')
    );

    const bySector = {};
    SECTORS.forEach(s => bySector[s] = {});

    ativos.forEach(order => {
      order.itens?.forEach(it => {
        if (it.setor === 'Bebidas' || it.status === 'cancelled') return;
        if (!bySector[it.setor]) bySector[it.setor] = {};
        if (!bySector[it.setor][it.item]) {
          bySector[it.setor][it.item] = { total: 0, tables: [], firstStartedAt: null };
        }
        const item = bySector[it.setor][it.item];
        item.total += it.quantidade;
        item.tables.push({
          mesa: order.mesa, tipo: order.tipo, qty: it.quantidade,
          orderId: order.id, status: it.status || order.status,
          startedAt: it.startedAt || order.startedAt,
          itemId: it.id, itemIndex: order.itens?.indexOf(it),
          garcom: order.garcom // ← NOVO: Incluir garçom para tooltip
        });
        if ((it.startedAt || order.startedAt) && (!item.firstStartedAt || new Date(it.startedAt || order.startedAt) < new Date(item.firstStartedAt))) {
          item.firstStartedAt = it.startedAt || order.startedAt;
        }
      });
    });

    let totalAtivos = 0;
    els.sectorsWrap.innerHTML = SECTORS.map(sector => {
      const items = bySector[sector];
      const hasItems = Object.keys(items).length > 0;
      if (hasItems) totalAtivos += Object.keys(items).length;
      const stats = Object.values(items).reduce((acc, item) => {
        item.tables.forEach(t => { if (t.status === 'em-preparo') acc.prep++; else if (t.status !== 'cancelled') acc.waiting++; });
        return acc;
      }, { prep: 0, waiting: 0 });

      return `
        <section class="sector-card ${stats.prep > 0 ? 'has-prep' : ''}" aria-labelledby="sector-title-${sector}">
          <header class="sector-title">
            <span id="sector-title-${sector}">${sector}</span>
            <span class="badge" aria-label="${hasItems ? Object.keys(items).length : 0} tipo(s) de item">${hasItems ? Object.keys(items).length : 0}</span>
          </header>
          ${stats.waiting > 0 ? `<div class="sector-alert" role="alert">⚠️ ${stats.waiting} item(s) aguardando início</div>` : ''}
          ${!hasItems ? '<p style="color:var(--muted);text-align:center;padding:20px">Sem itens</p>' : ''}
          <ul class="sector-items" aria-label="Itens do setor">
            ${Object.entries(items).map(([name, data]) => {
              const temEmPreparo = data.tables.some(t => t.status === 'em-preparo');
              const temAguardando = data.tables.some(t => t.status !== 'em-preparo' && t.status !== 'cancelled');
              const elapsed = data.firstStartedAt ? Math.floor((Date.now() - new Date(data.firstStartedAt).getTime()) / 1000) : 0;
              const timeClass = getTimeClass(elapsed);
              return `
              <li class="sector-item ${temEmPreparo ? 'in-prep' : ''} ${temAguardando ? 'waiting' : ''}">
                <div class="item-name">
                  <span>${escapeHtml(name)}</span>
                  <span style="color:var(--accent);font-weight:800" aria-label="Quantidade total">x${data.total}</span>
                </div>
                <div class="item-meta">
                  <div class="tables" role="list" aria-label="Mesas">
                    ${data.tables.map(t => {
                      const itemTagTitle = t.garcom ? `Mesa ${t.mesa} • Garçom: ${t.garcom}` : `Mesa ${t.mesa}`;
                      return `
                      <span class="table-tag ${t.tipo} ${t.status === 'em-preparo' ? 'prep' : ''} ${t.status === 'cancelled' ? 'cancelled' : ''}" 
                            role="listitem" 
                            data-order-id="${t.orderId}" 
                            data-started="${t.startedAt || ''}"
                            title="${escapeHtml(itemTagTitle)}">
                        ${escapeHtml(t.mesa)} <span aria-label="quantidade">x${t.qty}</span>
                        ${t.status === 'em-preparo' && t.startedAt 
                          ? `<span class="mini-timer ${timeClass}" data-elapsed="${elapsed}" aria-label="Tempo em preparo: ${formatTime(elapsed)}">${formatTime(elapsed)}</span>` 
                          : t.status === 'cancelled' ? `<span class="cancelled-mini">🚫</span>` : ''}
                      </span>`;
                    }).join('')}
                  </div>
                </div>
              </li>`;
            }).join('')}
          </ul>
          <footer class="sector-actions" role="group" aria-label="Ações do setor">
            <button class="btn-sector start" onclick="window.startSector('${sector}')" ${stats.waiting === 0 ? 'disabled' : ''} aria-label="Iniciar preparo de ${stats.waiting} itens em ${sector}">
              ▶ Iniciar ${stats.waiting > 0 ? `(${stats.waiting})` : ''}
            </button>
            <button class="btn-sector done" onclick="window.doneSector('${sector}')" ${stats.prep === 0 ? 'disabled' : ''} aria-label="Concluir ${stats.prep} itens em preparo em ${sector}">
              ✅ Concluir ${stats.prep > 0 ? `(${stats.prep})` : ''}
            </button>
          </footer>
        </section>`;
    }).join('');

    if (els.badges.setor) {
      els.badges.setor.textContent = totalAtivos;
      els.badges.setor.setAttribute('aria-label', `${totalAtivos} item(s) ativo(s)`);
    }
  }

  // ============================================================================
  // RENDER: Aba CONCLUÍDOS (com detalhamento por item)
  // ============================================================================

  function renderConcluidos() {
    const concluidos = orders.filter(o => o.status === 'concluido');
    if (els.badges.concluidos) {
      els.badges.concluidos.textContent = concluidos.length;
      els.badges.concluidos.setAttribute('aria-label', `${concluidos.length} pedido(s) concluído(s)`);
    }
    if (concluidos.length === 0) {
      els.completedList.innerHTML = `
        <div class="empty" role="status">
          <span class="empty-icon" aria-hidden="true">✨</span>
          <p>Nenhum concluído</p>
          <small>Pedidos finalizados aparecem aqui</small>
        </div>`;
      return;
    }
    const recent = concluidos.slice(0, 50);
    els.completedList.innerHTML = recent.map(o => {
      const startedAt = o.startedAt ? new Date(o.startedAt) : null;
      const concludedAt = o.updatedAt ? new Date(o.updatedAt) : null;
      const duration = startedAt && concludedAt ? Math.floor((concludedAt - startedAt) / 1000) : null;
      // ← NOVO: Calcular tempos por item
      const itemTimes = o.itens?.map(it => {
        const itStart = it.startedAt ? new Date(it.startedAt) : startedAt;
        const itEnd = it.completedAt ? new Date(it.completedAt) : concludedAt;
        return itStart && itEnd ? Math.floor((itEnd - itStart) / 1000) : null;
      }).filter(t => t != null) || [];
      const avgItemTime = itemTimes.length > 0 ? Math.round(itemTimes.reduce((a,b) => a+b, 0) / itemTimes.length) : null;
      const slowestItem = itemTimes.length > 0 ? Math.max(...itemTimes) : null;

      return `
      <article class="completed-item" data-order-id="${o.id}">
        <div class="completed-header" onclick="window.toggleCompletedDetails('${o.id}')" style="cursor:pointer">
          <div class="info">
            <span class="mesa">${escapeHtml(o.mesa)} <span class="order-type ${o.tipo}" style="padding:2px 8px;font-size:0.75rem">${o.tipo}</span></span>
            ${o.garcom && o.garcom !== 'Desconhecido' 
              ? `<span class="garcom-small" title="Garçom">👨‍🍳 ${escapeHtml(o.garcom)}</span>` 
              : ''}
            <span class="time">${o.horario} • ${o.itens?.length || 0} itens ${duration != null ? `• ⏱️ ${formatTime(duration)}` : ''}</span>
            ${avgItemTime != null ? `<span class="item-stats" title="Tempo médio por item">📊 Média: ${formatTime(avgItemTime)}</span>` : ''}
          </div>
          <span class="expand-icon">▾</span>
        </div>
        <div id="details-${o.id}" class="completed-details hidden">
          <div class="details-list">
            ${o.itens?.map((it, i) => {
              const itStart = it.startedAt ? new Date(it.startedAt) : startedAt;
              const itEnd = it.completedAt ? new Date(it.completedAt) : concludedAt;
              const itTime = itStart && itEnd ? Math.floor((itEnd - itStart) / 1000) : null;
              const waitClass = getWaitTimeClass(itTime);
              return `
              <div class="detail-item">
                <span class="detail-name">${escapeHtml(it.item)} <small>(${escapeHtml(it.setor)})</small></span>
                ${itTime != null ? `<span class="detail-time ${waitClass}" title="Tempo de preparo">⏱️ ${formatTime(itTime)}</span>` : ''}
              </div>`;
            }).join('') || '<small>Sem detalhes</small>'}
          </div>
          ${slowestItem != null && slowestItem > 600 ? `<div class="alert-slow">⚠️ Item mais lento: ${formatTime(slowestItem)} (acima de 10min)</div>` : ''}
        </div>
        <button class="btn btn-danger" style="padding:10px 20px" onclick="window.removeCompleted(${o.id})" aria-label="Remover ${o.mesa} do histórico">🗑️</button>
      </article>`;
    }).join('');
  }

  // ← NOVO: Toggle para expandir detalhes do pedido concluído
  window.toggleCompletedDetails = (orderId) => {
    const details = $(`#details-${orderId}`);
    const expandIcon = details?.previousElementSibling?.querySelector('.expand-icon');
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
      setTimeout(() => els.loadingOverlay?.remove(), 300);
    }
  }

  // ============================================================================
  // EVENT LISTENERS: Tabs
  // ============================================================================

  function setupTabs() {
    els.tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        els.tabs.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        els.tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
        currentTab = btn.dataset.tab;
        const target = $(`#tab-${currentTab}`);
        if (target) {
          target.classList.add('active');
          els.tabContents.forEach(c => c.setAttribute('hidden', c.id !== `tab-${currentTab}`));
        }
        renderAll();
        if (navigator.vibrate) navigator.vibrate(10);
      });
    });
  }

  // ============================================================================
  // EVENT LISTENERS: Config Panel + Cancel Banner
  // ============================================================================

  function setupConfigPanel() {
    if (!els.openConfig || !els.configPanel) return;
    els.openConfig.addEventListener('click', () => {
      if (els.backendUrlInput) els.backendUrlInput.value = BACKEND_URL;
      els.configPanel.classList.remove('hidden');
      els.backendUrlInput?.focus();
    });
    els.toggleConfig?.addEventListener('click', () => els.configPanel.classList.add('hidden'));
    els.saveConfig?.addEventListener('click', () => {
      const url = els.backendUrlInput?.value.trim();
      if (url && url.startsWith('http')) {
        localStorage.setItem('kfm_backend_url', url);
        toast('✅ Configuração salva! Recarregando...', 'success', 2000);
        setTimeout(() => location.reload(), 500);
      } else toast('❌ URL inválida', 'error');
    });
    document.addEventListener('click', (e) => {
      if (els.configPanel && !els.configPanel.classList.contains('hidden') && !els.configPanel.contains(e.target) && e.target !== els.openConfig) {
        els.configPanel.classList.add('hidden');
      }
      // ← NOVO: Fechar banner de cancelamento ao clicar no X
      if (e.target === els.cancelClose) hideCancelBanner();
    });
    
    // ← NOVO: Botão de fullscreen emergencial (se engrenagem for clicada 3x rápido)
    let configClicks = 0;
    els.openConfig?.addEventListener('dblclick', () => {
      configClicks++;
      if (configClicks >= 3) {
        tryFullscreen();
        configClicks = 0;
        toast('🖥️ Tela cheia ativada', 'info', 2000);
      }
      setTimeout(() => configClicks = 0, 1000);
    });
  }

  // ← NOVO: Fullscreen emergencial
  function tryFullscreen() {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    const elem = document.documentElement;
    if (elem.requestFullscreen) elem.requestFullscreen().catch(() => {});
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen().catch(() => {});
    else if (elem.msRequestFullscreen) elem.msRequestFullscreen().catch(() => {});
  }

  // ============================================================================
  // ← NOVO: Ações por Item (controle granular)
  // ============================================================================

  window.startItem = (orderId, itemIndex) => {
    const order = orders.find(o => o.id === orderId);
    if (!order?.itens?.[itemIndex]) return;
    
    const item = order.itens[itemIndex];
    const agora = getServerTime().toISOString();
    
    // Atualizar localmente
    item.status = 'em-preparo';
    item.startedAt = agora;
    
    renderAll(); startTimers();
    toast(`▶ ${item.item} em produção`, 'success', 1500);
    
    // Enviar para backend
    send('UPDATE_ITEM_STATUS', {
      orderId, itemId: getItemId(orderId, item.setor, itemIndex),
      status: 'em-preparo', startedAt: agora, timestamp: agora
    });
  };

  window.completeItem = (orderId, itemIndex) => {
    const order = orders.find(o => o.id === orderId);
    if (!order?.itens?.[itemIndex]) return;
    
    const item = order.itens[itemIndex];
    const agora = getServerTime().toISOString();
    
    // Calcular tempo de preparo
    const started = item.startedAt ? new Date(item.startedAt).getTime() : Date.now();
    const prepTime = Math.floor((Date.now() - started) / 1000);
    
    // Atualizar localmente
    item.status = 'concluido';
    item.completedAt = agora;
    item.prepTime = prepTime;
    
    renderAll();
    toast(`✅ ${item.item} pronto! (${formatTime(prepTime)})`, 'success', 1500);
    
    // Enviar para backend
    send('UPDATE_ITEM_STATUS', {
      orderId, itemId: getItemId(orderId, item.setor, itemIndex),
      status: 'concluido', completedAt: agora, prepTime, timestamp: agora
    });
    
    // Verificar se todos os itens do pedido estão concluídos
    const allDone = order.itens.every(i => i.status === 'concluido' || i.setor === 'Bebidas');
    if (allDone && order.status !== 'concluido') {
      // Marcar pedido como concluído automaticamente
      order.status = 'concluido';
      order.updatedAt = agora;
      send('UPDATE_STATUS', { orderId, status: 'concluido', concludedAt: agora });
    }
  };

  // ============================================================================
  // Ações Globais (pedido inteiro) - Mantidas para compatibilidade
  // ============================================================================

  window.startOrder = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) { console.error('❌ Pedido não encontrado:', id); return; }
    const agora = getServerTime().toISOString();
    console.log(`▶ Iniciando pedido ${order.mesa} (ID: ${id}) às ${agora}`);
    order.status = 'em-preparo'; order.startedAt = agora;
    renderAll(); startTimers();
    toast(`▶ ${order.mesa} em produção`, 'success', 2000);
    const payload = { orderId: id, status: 'em-preparo', startedAt: agora, timestamp: agora };
    console.log('📤 Enviando UPDATE_STATUS:', payload);
    if (send('UPDATE_STATUS', payload)) {
      setTimeout(() => { console.log('🔄 Forçando sync após iniciar pedido'); send('REQUEST_SYNC', { orderId: id }); }, 500);
    } else { order.status = 'pendente'; order.startedAt = null; renderAll(); toast('❌ Erro ao iniciar pedido - sem conexão', 'error'); }
  };

  window.markReady = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) { console.error('❌ Pedido não encontrado:', id); return; }
    showModal(`Confirmar: concluir ${order.mesa}?`, () => {
      const agora = getServerTime().toISOString();
      console.log(`✅ Concluindo pedido ${order.mesa} (ID: ${id}) às ${agora}`);
      order.status = 'concluido'; order.concludedAt = agora; order.updatedAt = agora;
      renderAll(); toast(`✅ ${order.mesa} concluído!`, 'success', 2000);
      if (send('UPDATE_STATUS', { orderId: id, status: 'concluido', concludedAt: agora, timestamp: agora })) {
        setTimeout(() => send('REQUEST_SYNC', { orderId: id }), 500);
      }
    });
  };

  window.startSector = (sector) => {
    const aguardando = orders.filter(o => o.status !== 'concluido' && o.status !== 'cancelled' && o.itens?.some(i => i.setor === sector && i.status !== 'cancelled'));
    if (aguardando.length === 0) { toast(`Nada para iniciar em ${sector}`, 'warning'); return; }
    console.log(`▶ Iniciando setor ${sector}: ${aguardando.length} pedido(s)`);
    showModal(`Iniciar ${aguardando.length} pedido(s) em ${sector}?`, () => {
      const agora = getServerTime().toISOString();
      aguardando.forEach(o => { o.status = 'em-preparo'; o.startedAt = agora; });
      renderAll(); startTimers(); toast(`${sector} iniciado! (${aguardando.length} pedidos)`, 'success');
      aguardando.forEach(o => send('UPDATE_STATUS', { orderId: o.id, status: 'em-preparo', sector, startedAt: agora, timestamp: agora }));
      setTimeout(() => send('REQUEST_SYNC', { sector }), 500);
    });
  };

  window.doneSector = (sector) => {
    const emPreparo = orders.filter(o => o.status === 'em-preparo' && o.itens?.some(i => i.setor === sector));
    if (emPreparo.length === 0) { toast(`Nada em preparo em ${sector}`, 'warning'); return; }
    console.log(`✅ Concluindo setor ${sector}: ${emPreparo.length} pedido(s)`);
    showModal(`Concluir ${emPreparo.length} pedido(s) de ${sector}?`, () => {
      const agora = getServerTime().toISOString();
      emPreparo.forEach(o => { o.status = 'concluido'; o.concludedAt = agora; o.updatedAt = agora; });
      renderAll(); toast(`${sector} concluído!`, 'success');
      emPreparo.forEach(o => send('UPDATE_STATUS', { orderId: o.id, status: 'concluido', sector, concludedAt: agora, timestamp: agora }));
      setTimeout(() => send('REQUEST_SYNC', { sector }), 500);
    });
  };

  window.removeCompleted = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) { console.error('❌ Pedido não encontrado:', id); return; }
    showModal(`Remover ${order.mesa} do histórico?`, () => {
      if (send('DELETE_ORDER', { orderId: id })) toast('🗑️ Removido', 'info', 1500);
    });
  };

  els.clearCompleted?.addEventListener('click', () => {
    const concluidos = orders.filter(o => o.status === 'concluido');
    if (!concluidos.length) { toast('Nada para limpar', 'warning'); return; }
    showModal(`Limpar ${concluidos.length} pedido(s) concluído(s)?`, () => {
      concluidos.forEach(o => send('DELETE_ORDER', { orderId: o.id }));
      toast('🧹 Lista limpa', 'success');
    });
  });

  // ============================================================================
  // EVENT LISTENERS: Som e Toque
  // ============================================================================

  function setupSound() {
    const saved = localStorage.getItem('kfm_sound_enabled');
    if (saved !== null) soundEnabled = saved === 'true';
    if (els.soundToggle) {
      els.soundToggle.textContent = soundEnabled ? '🔔' : '🔕';
      els.soundToggle.classList.toggle('muted', !soundEnabled);
      els.soundToggle.setAttribute('aria-label', soundEnabled ? 'Desativar som' : 'Ativar som');
      els.soundToggle.setAttribute('aria-pressed', soundEnabled);
      els.soundToggle.addEventListener('click', toggleSound);
    }
    document.addEventListener('touchstart', () => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) { const ctx = new AudioCtx(); ctx.resume(); ctx.close(); }
      } catch (e) {}
    }, { once: true, passive: true });
  }

  function setupTouchOptimizations() {
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    const scrollable = $('.orders-grid, .sectors-wrap, .completed-list');
    if (scrollable) scrollable.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
  }

  // ============================================================================
  // INICIALIZAÇÃO
  // ============================================================================

  function init() {
    console.log('🚀 Inicializando Kitchen Flow v2.1.4...');
    startClock(); setupTabs(); setupConfigPanel(); setupSound(); setupTouchOptimizations();
    connect();
    window.KFM = { orders, ws, send, renderAll, startTimers, playDing, playCancelAlert, toast, syncTimeWithServer, getServerTime, tryFullscreen };
    console.log('✅ Kitchen Flow inicializado');
    console.log('📊 Comandos disponíveis: window.KFM');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.addEventListener('beforeunload', () => { stopTimers(); if (ws?.readyState === WebSocket.OPEN) ws.close(); });

})();