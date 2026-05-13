/**
 * Kitchen Flow Monitor - Frontend Tablet
 * Conecta ao backend via WebSocket + HTTP
 */
(() => {
  // Configuração: usa variável do Vercel ou localStorage
  const getBackendUrl = () => {
    const saved = localStorage.getItem('kfm_backend_url');
    if (saved) return saved;
    // Vercel env vars são injetadas no build
    if (typeof VITE_BACKEND_URL !== 'undefined') return VITE_BACKEND_URL;
    return `ws://${window.location.hostname}:4545`; // fallback dev
  };

  const WS_URL = getBackendUrl().replace('http', 'ws').replace('https', 'wss');
  const API_URL = getBackendUrl().replace('ws', 'http').replace('wss', 'https');
  
  const SECTORS = ['Frios', 'Saladas', 'Fritadeira', 'Entradas', 'Fogão', 'Sobremesas'];
  
  // Estado
  let ws, clientId, orders = [], currentTab = 'geral';
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  
  // DOM Helpers
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  
  // Elements
  const ordersGeral = $('#ordersGeral');
  const sectorsWrap = $('#sectors');
  const completedList = $('#completed');
  const connStatus = $('#connStatus');
  const clockEl = $('#clock');
  const clientEl = $('#clientId');
  const badges = {
    geral: $('#badgeGeral'),
    setor: $('#badgeSetor'),
    concluidos: $('#badgeConcluidos')
  };
  
  // Clock
  setInterval(() => {
    clockEl.textContent = new Date().toLocaleTimeString('pt-BR', { 
      hour: '2-digit', minute: '2-digit' 
    });
  }, 1000);
  
  // Toast notifications
  function toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'error' : ''}`;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 4000);
  }
  
  // Modal confirmation
  const modal = $('#modal');
  function confirm(msg, onYes) {
    $('#modalMsg').textContent = msg;
    modal.showModal();
    const cleanup = () => {
      $('#modalYes').onclick = null;
      $('#modalNo').onclick = null;
    };
    $('#modalYes').onclick = () => { modal.close(); cleanup(); onYes?.(); };
    $('#modalNo').onclick = () => { modal.close(); cleanup(); };
    modal.onclose = cleanup;
  }
  
  // WebSocket connection with retry
  function connect() {
    console.log(`🔌 Conectando a ${WS_URL}`);
    
    try {
      ws = new WebSocket(WS_URL);
    } catch(e) {
      console.error('WS init error:', e);
      updateConnectionStatus(false);
      scheduleReconnect();
      return;
    }
    
    ws.onopen = () => {
      console.log('✅ WebSocket conectado');
      updateConnectionStatus(true);
      reconnectAttempts = 0;
      toast('Conectado ao servidor', 'success');
      // Request full sync
      ws.send(JSON.stringify({ type: 'REQUEST_FULL_SYNC' }));
    };
    
    ws.onclose = () => {
      console.log('🔌 WebSocket desconectado');
      updateConnectionStatus(false);
      scheduleReconnect();
    };
    
    ws.onerror = (e) => {
      console.error('❌ WebSocket error:', e);
      updateConnectionStatus(false);
      if (reconnectAttempts === 0) toast('Erro de conexão', 'error');
    };
    
    ws.onmessage = (e) => {
      try {
        const { type, timestamp, ...data } = JSON.parse(e.data);
        handleServerMessage(type, data);
      } catch(err) {
        console.error('Message parse error:', err);
      }
    };
  }
  
  function updateConnectionStatus(online) {
    if (online) {
      connStatus.textContent = '🟢 Online';
      connStatus.className = 'status online';
    } else {
      connStatus.textContent = '🔴 Offline';
      connStatus.className = 'status offline';
    }
  }
  
  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      toast('Não foi possível reconectar. Recarregue a página.', 'error');
      return;
    }
    
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
    reconnectAttempts++;
    
    console.log(`🔄 Tentativa ${reconnectAttempts}/${MAX_RECONNECT} em ${delay}ms`);
    setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
      }
    }, delay);
  }
  
  // Handle server messages
  function handleServerMessage(type, data) {
    switch(type) {
      case 'INIT':
        orders = data.orders || [];
        clientId = data.clientId || clientId;
        if (clientId) clientEl.textContent = `📱 ${clientId}`;
        renderAll();
        break;
        
      case 'CONNECTED':
        clientId = data.clientId;
        clientEl.textContent = `📱 ${clientId}`;
        break;
        
      case 'NEW_ORDER':
        if (!orders.find(o => o.id === data.order.id)) {
          orders.unshift(data.order);
          renderAll();
          toast(`🔔 Novo pedido: ${data.order.mesa}`);
          playSound();
        }
        break;
        
      case 'ORDER_UPDATED':
        const idx = orders.findIndex(o => o.id === data.order.id);
        if (idx > -1) {
          orders[idx] = data.order;
          renderAll();
        }
        break;
        
      case 'ORDER_DELETED':
        orders = orders.filter(o => o.id !== data.orderId);
        renderAll();
        break;
        
      case 'PONG':
        // Health check response
        break;
    }
  }
  
  // Play notification sound
  function playSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.frequency.value = 880;
      osc.type = 'square';
      
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      
      setTimeout(() => ctx.close(), 300);
    } catch(e) {
      // Ignore audio errors
    }
  }
  
  // Send message to server
  function send(type, payload = {}) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
      return true;
    }
    toast('Sem conexão com o servidor', 'error');
    return false;
  }
  
  // Render: GERAL tab
  function renderGeral() {
    const ativos = orders.filter(o => o.status !== 'concluido');
    badges.geral.textContent = ativos.length;
    
    if (ativos.length === 0) {
      ordersGeral.innerHTML = `
        <div class="empty">
          <span class="empty-icon">🍽️</span>
          <p>Nenhum pedido ativo</p>
          <small>Aguardando pedidos do Saipos...</small>
        </div>
      `;
      return;
    }
    
    ordersGeral.innerHTML = ativos.map(order => {
      const isDelivery = order.tipo === 'delivery';
      const priorityStyle = isDelivery ? '' : `style="border-left-color:#e74c3c"`;
      
      return `
        <div class="order-card ${isDelivery ? 'delivery' : ''}" ${priorityStyle} data-id="${order.id}">
          <div class="order-header">
            <div>
              <div class="order-mesa">${escapeHtml(order.mesa)}</div>
              <span class="order-type ${order.tipo}">${order.tipo.toUpperCase()}</span>
            </div>
            <div class="order-time">${order.horario}</div>
          </div>
          <div class="order-items">
            ${order.itens.map(it => `
              <div class="order-item">
                <div>
                  <div class="sector">${escapeHtml(it.setor)}</div>
                  <div class="name">${escapeHtml(it.item)}</div>
                </div>
                <div class="qty">x${it.quantidade}</div>
              </div>
            `).join('')}
          </div>
          <div class="order-actions">
            <button class="btn btn-primary" onclick="window.startOrder(${order.id})">
              ▶ Iniciar
            </button>
            <button class="btn btn-secondary" onclick="window.markReady(${order.id})">
              ✅ Pronto
            </button>
          </div>
        </div>
      `;
    }).join('');
  }
  
  // Render: SETOR tab
  function renderSetor() {
    const ativos = orders.filter(o => o.status !== 'concluido');
    
    // Agrupar itens por setor
    const bySector = {};
    SECTORS.forEach(s => bySector[s] = {});
    
    ativos.forEach(order => {
      order.itens.forEach(it => {
        if (!bySector[it.setor]) bySector[it.setor] = {};
        if (!bySector[it.setor][it.item]) {
          bySector[it.setor][it.item] = { total: 0, tables: [] };
        }
        bySector[it.setor][it.item].total += it.quantidade;
        bySector[it.setor][it.item].tables.push({
          mesa: order.mesa,
          tipo: order.tipo,
          qty: it.quantidade
        });
      });
    });
    
    // Count active items for badge
    let totalAtivos = 0;
    
    sectorsWrap.innerHTML = SECTORS.map(sector => {
      const items = bySector[sector];
      const hasItems = Object.keys(items).length > 0;
      if (hasItems) totalAtivos += Object.keys(items).length;
      
      return `
        <div class="sector-card">
          <div class="sector-title">
            <span>${sector}</span>
            <span class="badge">${hasItems ? Object.keys(items).length : 0}</span>
          </div>
          ${!hasItems 
            ? '<p style="color:var(--muted);text-align:center;padding:20px">Sem itens</p>' 
            : ''}
          <div class="sector-items">
            ${Object.entries(items).map(([name, data]) => `
              <div class="sector-item">
                <div class="item-name">
                  ${escapeHtml(name)} 
                  <span style="color:var(--accent);font-weight:800">x${data.total}</span>
                </div>
                <div class="tables">
                  ${data.tables.map(t => `
                    <span class="table-tag ${t.tipo}">
                      ${escapeHtml(t.mesa)} x${t.qty}
                    </span>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
          <div class="sector-actions">
            <button class="btn-sector start" onclick="window.startSector('${sector}')">
              ▶ Iniciar ${sector}
            </button>
            <button class="btn-sector done" onclick="window.doneSector('${sector}')">
              ✅ Concluir
            </button>
          </div>
        </div>
      `;
    }).join('');
    
    badges.setor.textContent = totalAtivos;
  }
  
  // Render: CONCLUÍDOS tab
  function renderConcluidos() {
    const concluidos = orders.filter(o => o.status === 'concluido');
    badges.concluidos.textContent = concluidos.length;
    
    if (concluidos.length === 0) {
      completedList.innerHTML = `
        <div class="empty">
          <span class="empty-icon">✨</span>
          <p>Nenhum concluído</p>
          <small>Pedidos finalizados aparecem aqui</small>
        </div>
      `;
      return;
    }
    
    completedList.innerHTML = concluidos.slice(0, 50).map(o => `
      <div class="completed-item">
        <div class="info">
          <span class="mesa">
            ${escapeHtml(o.mesa)} 
            <span class="order-type ${o.tipo}" style="padding:2px 8px;font-size:0.75rem">
              ${o.tipo}
            </span>
          </span>
          <span class="time">${o.horario} • ${o.itens.length} itens</span>
        </div>
        <button class="btn btn-danger" style="padding:10px 20px" 
                onclick="window.removeCompleted(${o.id})">🗑️</button>
      </div>
    `).join('');
  }
  
  function renderAll() {
    if (currentTab === 'geral') renderGeral();
    else if (currentTab === 'setor') renderSetor();
    else renderConcluidos();
  }
  
  // Tab switching
  $$('.tab').forEach(btn => {
    btn.onclick = () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      $(`#tab-${currentTab}`).classList.add('active');
      renderAll();
    };
  });
  
  // Config panel
  const configPanel = $('#configPanel');
  const backendUrlInput = $('#backendUrl');
  
  $('#openConfig').onclick = () => {
    backendUrlInput.value = getBackendUrl();
    configPanel.classList.remove('hidden');
  };
  
  $('#toggleConfig').onclick = () => {
    configPanel.classList.add('hidden');
  };
  
  $('#saveConfig').onclick = () => {
    const url = backendUrlInput.value.trim();
    if (url) {
      localStorage.setItem('kfm_backend_url', url);
      toast('Configuração salva! Recarregando...');
      setTimeout(() => location.reload(), 500);
    }
  };
  
  // Global actions (exposed for HTML onclick)
  window.startOrder = (id) => {
    const order = orders.find(o => o.id === id);
    if (!order) return;
    confirm(`Iniciar produção do pedido ${order.mesa}?`, () => {
      if (send('UPDATE_STATUS', { orderId: id, status: 'em-preparo' })) {
        toast('Produção iniciada');
      }
    });
  };
  
  window.markReady = (id) => {
    confirm(`Marcar pedido como PRONTO?`, () => {
      if (send('UPDATE_STATUS', { orderId: id, status: 'pronto' })) {
        toast('Pedido pronto!');
      }
    });
  };
  
  window.startSector = (sector) => {
    const ativos = orders.filter(o => 
      o.status !== 'concluido' && o.itens.some(i => i.setor === sector)
    );
    if (ativos.length === 0) {
      toast(`Nenhum item para iniciar em ${sector}`);
      return;
    }
    confirm(`Iniciar TODOS os itens de ${sector}? (${ativos.length} pedidos)`, () => {
      ativos.forEach(o => {
        send('UPDATE_STATUS', { 
          orderId: o.id, 
          status: 'em-preparo', 
          sector 
        });
      });
      toast(`${sector} iniciado!`);
    });
  };
  
  window.doneSector = (sector) => {
    const emPreparo = orders.filter(o => 
      o.status === 'em-preparo' && o.itens.some(i => i.setor === sector)
    );
    if (emPreparo.length === 0) {
      toast(`Nenhum item em preparo em ${sector}`);
      return;
    }
    confirm(`Concluir itens de ${sector}?`, () => {
      emPreparo.forEach(o => {
        // Check if all sectors of this order are done
        const allDone = o.itens.every(it => 
          (o.sectorStatus?.[it.setor] || o.status) === 'pronto'
        );
        send('UPDATE_STATUS', {
          orderId: o.id,
          status: allDone ? 'concluido' : 'pronto',
          sector
        });
      });
      toast(`${sector} concluído!`);
    });
  };
  
  window.removeCompleted = (id) => {
    confirm('Remover este pedido concluído da lista?', () => {
      if (send('DELETE_ORDER', { orderId: id })) {
        toast('Removido');
      }
    });
  };
  
  $('#clearCompleted').onclick = () => {
    const concluidos = orders.filter(o => o.status === 'concluido');
    if (!concluidos.length) return;
    confirm(`Limpar TODOS os ${concluidos.length} pedidos concluídos?`, () => {
      concluidos.forEach(o => send('DELETE_ORDER', { orderId: o.id }));
      toast('Lista limpa');
    });
  };
  
  // Utility: escape HTML to prevent XSS
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  // Handle visibility change (pause audio when tab inactive)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Could pause sounds here if needed
    }
  });
  
  // Prevent accidental zoom on double-tap
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  
  // Initialize
  connect();
  renderAll();
  
  // Expose for debugging
  window.KFM = { orders, ws, send, renderAll };
  
  console.log('🍳 Kitchen Flow Frontend loaded');
})();