/**
 * Kitchen Flow Monitor - Frontend Tablet v2.1.1
 * Backend: https://kitchen-flow-swq2.onrender.com
 * Features: Timer em tempo real, Som Ding configurável, Sync Geral↔Setor, Acessibilidade
 */
(() => {
  'use strict';

  // ============================================================================
  // CONFIGURAÇÃO INICIAL
  // ============================================================================

  // URL do backend - prioridade: localStorage > env > default
  const getBackendUrl = () => {
    // 1. Prioridade: localStorage (usuário pode alterar)
    const saved = localStorage.getItem('kfm_backend_url');
    if (saved && saved.startsWith('http')) return saved;

    // 2. Fallback: URL hardcoded (funciona sempre)
    return 'https://kitchen-flow-swq2.onrender.com';
  };

  const BACKEND_URL = getBackendUrl();
  const WS_URL = BACKEND_URL.replace('http', 'ws').replace('https', 'wss');

  // Limites para alertas visuais de tempo (em segundos)
  const TIMER_WARN_THRESHOLD = 300;   // 5 min → amarelo
  const TIMER_CRITICAL_THRESHOLD = 600; // 10 min → vermelho/piscando

  console.log('🔌 Kitchen Flow v2.1.1');
  console.log('🔌 Backend:', BACKEND_URL);
  console.log('🔌 WebSocket:', WS_URL);

  // Setores da cozinha (ordem de exibição)
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

  // ============================================================================
  // SELETORES DOM (cache para performance)
  // ============================================================================

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const els = {
    // Estrutura principal
    loadingOverlay: $('#loadingOverlay'),
    loadingStatus: $('#loadingStatus'),

    // Header
    connStatus: $('#connStatus'),
    clock: $('#clock'),
    clientId: $('#clientId'),
    soundToggle: $('#soundToggle'),

    // Tabs e badges
    tabs: $$('.tab'),
    tabContents: $$('.tab-content'),
    badges: {
      geral: $('#badgeGeral'),
      setor: $('#badgeSetor'),
      concluidos: $('#badgeConcluidos')
    },

    // Conteúdo das abas
    ordersGeral: $('#ordersGeral'),
    sectorsWrap: $('#sectors'),
    completedList: $('#completed'),

    // Modal
    modal: $('#modal'),
    modalMsg: $('#modalMsg'),
    modalYes: $('#modalYes'),
    modalNo: $('#modalNo'),

    // Config panel
    configPanel: $('#configPanel'),
    backendUrlInput: $('#backendUrl'),
    openConfig: $('#openConfig'),
    toggleConfig: $('#toggleConfig'),
    saveConfig: $('#saveConfig'),

    // Botões de ação
    clearCompleted: $('#clearCompleted'),

    // Toasts
    toasts: $('#toasts')
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

    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function getTimeClass(seconds) {
    if (seconds >= TIMER_CRITICAL_THRESHOLD) return 'critical';
    if (seconds >= TIMER_WARN_THRESHOLD) return 'high';
    return '';
  }

  // ============================================================================
  // UI: TOAST NOTIFICATIONS
  // ============================================================================

  function toast(message, type = 'info', duration = 4000) {
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;
    t.setAttribute('role', 'alert');
    t.innerHTML = `<span>${escapeHtml(message)}</span>`;

    els.toasts.appendChild(t);

    // Animação de entrada
    requestAnimationFrame(() => {
      t.style.opacity = '1';
      t.style.transform = 'translateX(0)';
    });

    // Auto-remover
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
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

    els.modalYes.onclick = () => {
      cleanup();
      if (typeof onConfirm === 'function') onConfirm();
    };

    els.modalNo.onclick = () => {
      cleanup();
      if (typeof onCancel === 'function') onCancel();
    };

    // Fechar com Escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  // ============================================================================
  // SOM: Sistema de Alerta "Ding" (Web Audio API - leve e sem arquivos)
  // ============================================================================

  function playDing(volume = 0.3) {
    if (!soundEnabled) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      // Conectar: oscilador → gain → destino
      osc.connect(gain);
      gain.connect(ctx.destination);

      // Efeito sino: frequência cai de 1200Hz para 600Hz
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.12);

      // Volume: decai suavemente
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

      // Tipo de onda: sine para som mais limpo
      osc.type = 'sine';

      // Tocar e limpar
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      setTimeout(() => ctx.close(), 400);

    } catch (e) {
      console.warn('⚠️ Som não reproduzido:', e.message);
    }
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;

    // Atualizar UI do botão
    if (els.soundToggle) {
      els.soundToggle.textContent = soundEnabled ? '🔔' : '🔕';
      els.soundToggle.classList.toggle('muted', !soundEnabled);
      els.soundToggle.setAttribute('aria-label', soundEnabled ? 'Desativar som' : 'Ativar som');
      els.soundToggle.setAttribute('aria-pressed', soundEnabled);
    }

    // Feedback visual
    toast(soundEnabled ? '🔔 Som ativado' : '🔕 Som silenciado', 'info', 2000);

    // Salvar preferência
    localStorage.setItem('kfm_sound_enabled', soundEnabled);
  }

  // ============================================================================
  // CLOCK E TIMER
  // ============================================================================

  function startClock() {
    const update = () => {
      els.clock.textContent = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    };
    update();
    setInterval(update, 1000);
  }

  function startTimers() {
    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
      const now = Date.now();

      // Atualizar timers na aba Geral
      orders.forEach(order => {
        if (order.status === 'em-preparo' && order.startedAt) {
          const started = new Date(order.startedAt).getTime();
          const elapsed = Math.floor((now - started) / 1000);

          const timerEl = $(`#timer-${order.id}`);
          if (timerEl) {
            timerEl.textContent = formatTime(elapsed);

            // Atualizar classe visual conforme tempo
            const timeClass = getTimeClass(elapsed);
            timerEl.className = `timer ${timeClass}`.trim();
          }
        }
      });

      // Atualizar mini-timers na aba Setor
      $$('.mini-timer').forEach(el => {
        const orderId = el.closest('.table-tag')?.dataset?.orderId;
        const startedAt = el.dataset.started;
        if (orderId && startedAt) {
          const started = new Date(startedAt).getTime();
          const elapsed = Math.floor((now - started) / 1000);
          el.textContent = formatTime(elapsed);

          const timeClass = getTimeClass(elapsed);
          el.className = `mini-timer ${timeClass}`.trim();
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
  // WEBSOCKET: Conexão e Mensagens
  // ============================================================================

  function connect() {
    console.log(`🔌 Conectando WebSocket: ${WS_URL}`);
    els.loadingStatus?.textContent = 'Conectando...';

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('❌ Erro ao inicializar WebSocket:', e);
      updateConnectionStatus(false);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('✅ WebSocket conectado');
      updateConnectionStatus(true);
      reconnectAttempts = 0;
      els.loadingStatus?.textContent = 'Sincronizando...';
      toast('🟢 Conectado ao servidor', 'info', 2000);
    };

    ws.onclose = (event) => {
      console.log(`🔌 WebSocket desconectado (code: ${event.code})`);
      updateConnectionStatus(false);

      if (isInitialized) {
        toast('Conexão perdida. Reconectando...', 'warning');
        scheduleReconnect();
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      updateConnectionStatus(false);

      if (reconnectAttempts === 0 && isInitialized) {
        toast('Erro de conexão com o servidor', 'error');
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { type, ...payload } = data;
        handleServerMessage(type, payload);
      } catch (err) {
        console.error('❌ Erro ao parsear mensagem:', err);
      }
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
      els.loadingStatus?.textContent = 'Falha na conexão';
      return;
    }

    // Backoff exponencial: 1s, 2s, 4s, 8s, 10s (máx)
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
    reconnectAttempts++;

    console.log(`🔄 Reconectando em ${delay}ms (tentativa ${reconnectAttempts}/${MAX_RECONNECT})`);
    els.loadingStatus?.textContent = `Reconectando em ${Math.ceil(delay / 1000)}s...`;

    setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
      }
    }, delay);
  }

  function send(type, payload = {}) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
      return true;
    }
    toast('Sem conexão com o servidor', 'error');
    return false;
  }

  // ============================================================================
  // HANDLER DE MENSAGENS DO SERVIDOR
  // ============================================================================

  function handleServerMessage(type, data) {
    switch (type) {
      case 'INIT':
        // Primeira carga: recebe lista completa de pedidos
        orders = data.orders || [];
        clientId = data.clientId;

        if (clientId && els.clientId) {
          els.clientId.textContent = `📱 ${clientId.slice(0, 8)}`;
          els.clientId.title = `ID: ${clientId}`;
        }

        isInitialized = true;
        hideLoading();
        renderAll();
        startTimers();
        break;

      case 'CONNECTED':
        // Reconexão: recebe apenas o ID do cliente
        clientId = data.clientId;
        if (clientId && els.clientId) {
          els.clientId.textContent = `📱 ${clientId.slice(0, 8)}`;
        }
        break;

      case 'NEW_ORDER':
        // Novo pedido chegou
        if (!orders.find(o => o.id === data.order?.id)) {
          orders.unshift(data.order);
          renderAll();

          // Notificar
          toast(`🔔 Novo pedido: ${data.order.mesa}`, 'info', 3000);
          playDing();
        }
        break;

      case 'ORDER_UPDATED':
        // Pedido existente foi atualizado
        const idx = orders.findIndex(o => o.id === data.order?.id);
        if (idx > -1) {
          orders[idx] = data.order;
          renderAll();

          // Se entrou em preparo, garantir que timers estão rodando
          if (data.order.status === 'em-preparo') {
            startTimers();
          }
        }
        break;

      case 'ORDER_DELETED':
        // Pedido foi removido (ex: cancelado)
        const before = orders.length;
        orders = orders.filter(o => o.id !== data.orderId);

        if (orders.length < before) {
          renderAll();
          toast('🗑️ Pedido removido', 'info', 2000);
        }
        break;

      case 'PING':
        // Responde ao heartbeat do servidor
        send('PONG', { clientId, timestamp: Date.now() });
        break;
    }
  }

  // ============================================================================
  // RENDER: Aba GERAL (lista de pedidos)
  // ============================================================================

  function renderGeral() {
    const ativos = orders.filter(o => o.status !== 'concluido');

    // Atualizar badge
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
      const startedAt = order.startedAt ? new Date(order.startedAt) : null;
      const elapsed = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : 0;
      const timeClass = getTimeClass(elapsed);

      return `
        <article class="order-card ${isDelivery ? 'delivery' : ''} ${isInPrep ? 'in-prep' : ''}" 
                 data-order-id="${order.id}"
                 aria-labelledby="order-title-${order.id}">
          
          <header class="order-header">
            <div>
              <div class="order-mesa" id="order-title-${order.id}">${escapeHtml(order.mesa)}</div>
              <span class="order-type ${order.tipo}" role="label">${order.tipo.toUpperCase()}</span>
            </div>
            <div class="order-time" aria-label="Tempo de preparo">
              ${isInPrep
          ? `<span id="timer-${order.id}" class="timer ${timeClass}" data-elapsed="${elapsed}">${formatTime(elapsed)}</span>`
          : `<span>${order.horario}</span>`}
            </div>
          </header>
          
          <ul class="order-items" aria-label="Itens do pedido">
            ${order.itens.map((it, i) => `
              <li class="order-item">
                <div>
                  <span class="sector" aria-label="Setor">${escapeHtml(it.setor)}</span>
                  <span class="name">${escapeHtml(it.item)}</span>
                </div>
                <span class="qty" aria-label="Quantidade">x${it.quantidade}</span>
              </li>`).join('')}
          </ul>
          
          <footer class="order-actions" role="group" aria-label="Ações do pedido">
            ${isInPrep
          ? `<button class="btn btn-secondary" 
                        onclick="window.markReady(${order.id})"
                        aria-label="Marcar ${order.mesa} como pronto">
                   ✅ Pronto
                 </button>`
          : `
                 <button class="btn btn-primary" 
                         onclick="window.startOrder(${order.id})"
                         aria-label="Iniciar preparo de ${order.mesa}">
                   ▶ Iniciar
                 </button>
                 <button class="btn btn-secondary" 
                         onclick="window.markReady(${order.id})"
                         aria-label="Marcar ${order.mesa} como pronto">
                   ✅ Pronto
                 </button>`}
          </footer>
        </article>`;
    }).join('');
  }

  // ============================================================================
  // RENDER: Aba SETOR (visão por estação da cozinha)
  // ============================================================================

  function renderSetor() {
    const ativos = orders.filter(o => o.status !== 'concluido');

    // Agrupar itens por setor
    const bySector = {};
    SECTORS.forEach(s => bySector[s] = {});

    ativos.forEach(order => {
      order.itens.forEach(it => {
        if (!bySector[it.setor]) bySector[it.setor] = {};

        if (!bySector[it.setor][it.item]) {
          bySector[it.setor][it.item] = {
            total: 0,
            tables: [],
            firstStartedAt: null
          };
        }

        const item = bySector[it.setor][it.item];
        item.total += it.quantidade;
        item.tables.push({
          mesa: order.mesa,
          tipo: order.tipo,
          qty: it.quantidade,
          orderId: order.id,
          status: order.status,
          startedAt: order.startedAt
        });

        // Guardar o earliest startedAt para o timer do grupo
        if (order.startedAt && (!item.firstStartedAt || new Date(order.startedAt) < new Date(item.firstStartedAt))) {
          item.firstStartedAt = order.startedAt;
        }
      });
    });

    // Calcular total de itens ativos para o badge
    let totalAtivos = 0;

    els.sectorsWrap.innerHTML = SECTORS.map(sector => {
      const items = bySector[sector];
      const hasItems = Object.keys(items).length > 0;

      if (hasItems) {
        totalAtivos += Object.keys(items).length;
      }

      // Contar estados
      const stats = Object.values(items).reduce((acc, item) => {
        item.tables.forEach(t => {
          if (t.status === 'em-preparo') acc.prep++;
          else acc.waiting++;
        });
        return acc;
      }, { prep: 0, waiting: 0 });

      return `
        <section class="sector-card ${stats.prep > 0 ? 'has-prep' : ''}" 
                 aria-labelledby="sector-title-${sector}">
          
          <header class="sector-title">
            <span id="sector-title-${sector}">${sector}</span>
            <span class="badge" aria-label="${hasItems ? Object.keys(items).length : 0} tipo(s) de item">
              ${hasItems ? Object.keys(items).length : 0}
            </span>
          </header>
          
          ${stats.waiting > 0
          ? `<div class="sector-alert" role="alert">
                 ⚠️ ${stats.waiting} item(s) aguardando início
               </div>`
          : ''}
          
          ${!hasItems
          ? '<p style="color:var(--muted);text-align:center;padding:20px">Sem itens</p>'
          : ''}
          
          <ul class="sector-items" aria-label="Itens do setor">
            ${Object.entries(items).map(([name, data]) => {
            const temEmPreparo = data.tables.some(t => t.status === 'em-preparo');
            const temAguardando = data.tables.some(t => t.status !== 'em-preparo');
            const elapsed = data.firstStartedAt
              ? Math.floor((Date.now() - new Date(data.firstStartedAt).getTime()) / 1000)
              : 0;
            const timeClass = getTimeClass(elapsed);

            return `
              <li class="sector-item ${temEmPreparo ? 'in-prep' : ''} ${temAguardando ? 'waiting' : ''}">
                <div class="item-name">
                  <span>${escapeHtml(name)}</span>
                  <span style="color:var(--accent);font-weight:800" aria-label="Quantidade total">x${data.total}</span>
                </div>
                
                <div class="item-meta">
                  <div class="tables" role="list" aria-label="Mesas">
                    ${data.tables.map(t => `
                      <span class="table-tag ${t.tipo} ${t.status === 'em-preparo' ? 'prep' : ''}" 
                            role="listitem"
                            data-order-id="${t.orderId}"
                            data-started="${t.startedAt || ''}">
                        ${escapeHtml(t.mesa)} <span aria-label="quantidade">x${t.qty}</span>
                        ${t.status === 'em-preparo' && t.startedAt
                ? `<span class="mini-timer ${timeClass}" 
                                  data-elapsed="${elapsed}"
                                  aria-label="Tempo em preparo: ${formatTime(elapsed)}">
                               ${formatTime(elapsed)}
                             </span>`
                : ''}
                      </span>`).join('')}
                  </div>
                </div>
              </li>`;
          }).join('')}
          </ul>
          
          <footer class="sector-actions" role="group" aria-label="Ações do setor">
            <button class="btn-sector start" 
                    onclick="window.startSector('${sector}')"
                    ${stats.waiting === 0 ? 'disabled' : ''}
                    aria-label="Iniciar preparo de ${stats.waiting} itens em ${sector}">
              ▶ Iniciar ${stats.waiting > 0 ? `(${stats.waiting})` : ''}
            </button>
            <button class="btn-sector done" 
                    onclick="window.doneSector('${sector}')"
                    ${stats.prep === 0 ? 'disabled' : ''}
                    aria-label="Concluir ${stats.prep} itens em preparo em ${sector}">
              ✅ Concluir ${stats.prep > 0 ? `(${stats.prep})` : ''}
            </button>
          </footer>
        </section>`;
    }).join('');

    // Atualizar badge da aba
    if (els.badges.setor) {
      els.badges.setor.textContent = totalAtivos;
      els.badges.setor.setAttribute('aria-label', `${totalAtivos} item(s) ativo(s)`);
    }
  }

  // ============================================================================
  // RENDER: Aba CONCLUÍDOS (histórico recente)
  // ============================================================================

  function renderConcluidos() {
    const concluidos = orders.filter(o => o.status === 'concluido');

    // Atualizar badge
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

    // Mostrar apenas os 50 mais recentes para performance
    const recent = concluidos.slice(0, 50);

    els.completedList.innerHTML = recent.map(o => {
      const startedAt = o.startedAt ? new Date(o.startedAt) : null;
      const concludedAt = o.updatedAt ? new Date(o.updatedAt) : null;
      const duration = startedAt && concludedAt
        ? Math.floor((concludedAt - startedAt) / 1000)
        : null;

      return `
      <article class="completed-item">
        <div class="info">
          <span class="mesa">
            ${escapeHtml(o.mesa)} 
            <span class="order-type ${o.tipo}" style="padding:2px 8px;font-size:0.75rem">
              ${o.tipo}
            </span>
          </span>
          <span class="time">
            ${o.horario} • ${o.itens.length} itens
            ${duration !== null ? `• ⏱️ ${formatTime(duration)}` : ''}
          </span>
        </div>
        <button class="btn btn-danger" 
                style="padding:10px 20px" 
                onclick="window.removeCompleted(${o.id})"
                aria-label="Remover ${o.mesa} do histórico">
          🗑️
        </button>
      </article>`;
    }).join('');
  }

  // ============================================================================
  // RENDER: Orquestrador
  // ============================================================================

  function renderAll() {
    if (!isInitialized) return;

    if (currentTab === 'geral') {
      renderGeral();
    } else if (currentTab === 'setor') {
      renderSetor();
    } else if (currentTab === 'concluidos') {
      renderConcluidos();
    }
  }

  function hideLoading() {
    if (els.loadingOverlay) {
      els.loadingOverlay.style.opacity = '0';
      setTimeout(() => {
        els.loadingOverlay?.remove();
      }, 300);
    }
  }

  // ============================================================================
  // EVENT LISTENERS: Tabs
  // ============================================================================

  function setupTabs() {
    els.tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        // Remover active de todos
        els.tabs.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        els.tabContents.forEach(c => c.classList.remove('active'));

        // Ativar selecionado
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        currentTab = btn.dataset.tab;
        const target = $(`#tab-${currentTab}`);
        if (target) {
          target.classList.add('active');
          // Atualizar aria-controls
          els.tabContents.forEach(c => {
            c.setAttribute('hidden', c.id !== `tab-${currentTab}`);
          });
        }

        // Re-renderizar conteúdo
        renderAll();

        // Feedback de toque (haptic se disponível)
        if (navigator.vibrate) navigator.vibrate(10);
      });
    });
  }

  // ============================================================================
  // EVENT LISTENERS: Config Panel
  // ============================================================================

  function setupConfigPanel() {
    if (!els.openConfig || !els.configPanel) return;

    els.openConfig.addEventListener('click', () => {
      if (els.backendUrlInput) {
        els.backendUrlInput.value = BACKEND_URL;
      }
      els.configPanel.classList.remove('hidden');
      els.backendUrlInput?.focus();
    });

    els.toggleConfig?.addEventListener('click', () => {
      els.configPanel.classList.add('hidden');
    });

    els.saveConfig?.addEventListener('click', () => {
      const url = els.backendUrlInput?.value.trim();
      if (url && url.startsWith('http')) {
        localStorage.setItem('kfm_backend_url', url);
        toast('✅ Configuração salva! Recarregando...', 'success', 2000);

        setTimeout(() => {
          location.reload();
        }, 500);
      } else {
        toast('❌ URL inválida', 'error');
      }
    });

    // Fechar config ao clicar fora
    document.addEventListener('click', (e) => {
      if (els.configPanel &&
        !els.configPanel.classList.contains('hidden') &&
        !els.configPanel.contains(e.target) &&
        e.target !== els.openConfig) {
        els.configPanel.classList.add('hidden');
      }
    });
  }

  // ============================================================================
  // EVENT LISTENERS: Ações Globais (expostas para HTML onclick)
  // ============================================================================

  // Iniciar preparo de um pedido específico
  window.startOrder = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) return;

    if (send('UPDATE_STATUS', {
      orderId: id,
      status: 'em-preparo',
      startedAt: new Date().toISOString()
    })) {
      toast(`▶ ${order.mesa} em produção`, 'info', 2000);
      order.status = 'em-preparo';
      order.startedAt = new Date().toISOString();
      renderAll();
      startTimers();
    }
  };

  // Marcar pedido como pronto/concluído
  window.markReady = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) return;

    showModal(`Confirmar: concluir ${order.mesa}?`, () => {
      if (send('UPDATE_STATUS', {
        orderId: id,
        status: 'concluido',
        concludedAt: new Date().toISOString()
      })) {
        toast(`✅ ${order.mesa} concluído!`, 'success', 2000);
        order.status = 'concluido';
        order.concludedAt = new Date().toISOString();
        renderAll();
      }
    });
  };

  // Iniciar todos os itens aguardando de um setor
  window.startSector = (sector) => {
    const aguardando = orders.filter(o =>
      o.status !== 'concluido' &&
      o.itens.some(i => i.setor === sector)
    );

    if (aguardando.length === 0) {
      toast(`Nada para iniciar em ${sector}`, 'warning');
      return;
    }

    showModal(`Iniciar ${aguardando.length} pedido(s) em ${sector}?`, () => {
      const agora = new Date().toISOString();

      aguardando.forEach(o => {
        send('UPDATE_STATUS', {
          orderId: o.id,
          status: 'em-preparo',
          sector,
          startedAt: agora
        });
        o.status = 'em-preparo';
        o.startedAt = agora;
      });

      toast(`${sector} iniciado! (${aguardando.length} pedidos)`, 'success');
      renderAll();
      startTimers();
    });
  };

  // Concluir todos os itens em preparo de um setor
  window.doneSector = (sector) => {
    const emPreparo = orders.filter(o =>
      o.status === 'em-preparo' &&
      o.itens.some(i => i.setor === sector)
    );

    if (emPreparo.length === 0) {
      toast(`Nada em preparo em ${sector}`, 'warning');
      return;
    }

    showModal(`Concluir ${emPreparo.length} pedido(s) de ${sector}?`, () => {
      const agora = new Date().toISOString();

      emPreparo.forEach(o => {
        send('UPDATE_STATUS', {
          orderId: o.id,
          status: 'concluido',
          sector,
          concludedAt: agora
        });
        o.status = 'concluido';
        o.concludedAt = agora;
      });

      toast(`${sector} concluído!`, 'success');
      renderAll();
    });
  };

  // Remover um pedido concluído do histórico
  window.removeCompleted = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) return;

    showModal(`Remover ${order.mesa} do histórico?`, () => {
      if (send('DELETE_ORDER', { orderId: id })) {
        toast('🗑️ Removido', 'info', 1500);
      }
    });
  };

  // Limpar todos os concluídos
  els.clearCompleted?.addEventListener('click', () => {
    const concluidos = orders.filter(o => o.status === 'concluido');
    if (!concluidos.length) {
      toast('Nada para limpar', 'warning');
      return;
    }

    showModal(`Limpar ${concluidos.length} pedido(s) concluído(s)?`, () => {
      concluidos.forEach(o => {
        send('DELETE_ORDER', { orderId: o.id });
      });
      toast('🧹 Lista limpa', 'success');
    });
  });

  // ============================================================================
  // EVENT LISTENERS: Som e Toque
  // ============================================================================

  function setupSound() {
    // Carregar preferência salva
    const saved = localStorage.getItem('kfm_sound_enabled');
    if (saved !== null) {
      soundEnabled = saved === 'true';
    }

    // Atualizar UI inicial
    if (els.soundToggle) {
      els.soundToggle.textContent = soundEnabled ? '🔔' : '🔕';
      els.soundToggle.classList.toggle('muted', !soundEnabled);
      els.soundToggle.setAttribute('aria-label', soundEnabled ? 'Desativar som' : 'Ativar som');
      els.soundToggle.setAttribute('aria-pressed', soundEnabled);

      els.soundToggle.addEventListener('click', toggleSound);
    }

    // Habilitar áudio no primeiro toque (política de autoplay)
    document.addEventListener('touchstart', () => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          ctx.resume();
          ctx.close();
        }
      } catch (e) { }
    }, { once: true, passive: true });
  }

  // Prevenir zoom acidental e scroll bounce em tablets
  function setupTouchOptimizations() {
    // Prevenir double-tap zoom
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        e.preventDefault();
      }
      lastTouchEnd = now;
    }, { passive: false });

    // Prevenir scroll bounce nas áreas de lista
    const scrollable = $('.orders-grid, .sectors-wrap, .completed-list');
    if (scrollable) {
      scrollable.addEventListener('touchmove', (e) => {
        e.stopPropagation();
      }, { passive: false });
    }
  }

  // ============================================================================
  // INICIALIZAÇÃO
  // ============================================================================

  function init() {
    console.log('🚀 Inicializando Kitchen Flow...');

    // Setup básico
    startClock();
    setupTabs();
    setupConfigPanel();
    setupSound();
    setupTouchOptimizations();

    // Conectar ao backend
    connect();

    // Expor API para debug (opcional)
    window.KFM = {
      orders,
      ws,
      send,
      renderAll,
      startTimers,
      playDing,
      toast
    };

    console.log('✅ Kitchen Flow inicializado');
  }

  // Iniciar quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Cleanup ao fechar página
  window.addEventListener('beforeunload', () => {
    stopTimers();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

})();