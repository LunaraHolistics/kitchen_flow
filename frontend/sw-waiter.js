/**
 * Kitchen Flow - Service Worker para Página do Garçom v1.4
 * Funcionalidades: Cache offline, notificações push, background sync
 * Notas: Requer HTTPS para notificações push em produção
 */

const CACHE_NAME = 'kfm-waiter-v1.4';  // ← Atualizado para v1.4
const ASSETS_TO_CACHE = [
  '/waiter.html',
  '/waiter.js',
  '/waiter.css',
  '/fazenda-waiter-192.png',
  '/fazenda-waiter-512.png',
  '/waiter-manifest.json'
];

// API_BASE flexível - detecta hostname dinamicamente
function getAPIBase() {
  const url = new URL(self.location.href);
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

const CACHE_TTL = 15 * 60 * 1000; // 15 minutos para dados da API

// ============================================================================
// INSTALL: Cache de assets estáticos
// ============================================================================
self.addEventListener('install', (event) => {
  console.log('🔧 [SW] Install - Cacheando assets...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('📦 [SW] Assets para cache:', ASSETS_TO_CACHE);
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => {
        console.log('✅ [SW] Assets cacheados com sucesso');
        return self.skipWaiting();
      })
      .catch((err) => console.error('❌ [SW] Falha ao cachear assets:', err))
  );
});

// ============================================================================
// ACTIVATE: Limpar caches antigos
// ============================================================================
self.addEventListener('activate', (event) => {
  console.log('🔄 [SW] Activate - Limpando caches antigos...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('🗑️ [SW] Removendo cache antigo:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('✅ [SW] Caches antigos limpos');
        return self.clients.claim();
      })
  );
});

// ============================================================================
// FETCH: Estratégia de cache para requests
// ============================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Detectar API do garçom por porta + pathname
  const isWaiterAPI = url.port === '4545' && url.pathname.startsWith('/api/waiter/');
  
  if (isWaiterAPI) {
    event.respondWith(handleApiRequest(request));
    return;
  }
  
  // Assets estáticos: Cache-first
  if (ASSETS_TO_CACHE.some(asset => url.pathname.endsWith(asset))) {
    event.respondWith(
      caches.match(request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          });
        })
        .catch(() => caches.match('/waiter.html'))
    );
    return;
  }
  
  // Outros requests: Network-first com fallback para cache
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (request.method === 'GET' && response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json') || contentType?.includes('text/html')) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ============================================================================
// Handler para Requests da API com Cache Inteligente
// ============================================================================
async function handleApiRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  
  // Normalizar URL para evitar cache bloat
  const url = new URL(request.url);
  const cleanUrl = url.origin + url.pathname;
  const cacheKey = `${cleanUrl}-${request.method}`;
  
  try {
    // Tentar rede primeiro
    const networkResponse = await fetch(request, { 
      cache: 'no-cache',
      headers: { 'Accept': 'application/json' },
      mode: 'cors'
    });
    
    if (networkResponse.ok) {
      const responseClone = networkResponse.clone();
      await cache.put(cacheKey, responseClone);
      await cache.put(`${cacheKey}-timestamp`, new Response(Date.now().toString()));
      return networkResponse;
    }
  } catch (networkError) {
    console.warn('⚠️ [SW] Rede indisponível, tentando cache...', networkError.message);
  }
  
  // Fallback: tentar cache
  const cached = await cache.match(cacheKey);
  if (cached) {
    const timestampResponse = await cache.match(`${cacheKey}-timestamp`);
    if (timestampResponse) {
      const timestamp = await timestampResponse.text();
      const age = Date.now() - parseInt(timestamp);
      
      if (age < CACHE_TTL) {
        console.log('📦 [SW] Usando cache válido (idade:', Math.round(age/1000), 's)');
        return cached;
      } else {
        console.log('🗑️ [SW] Cache expirado, removendo');
        await cache.delete(cacheKey);
        await cache.delete(`${cacheKey}-timestamp`);
      }
    }
  }
  
  // Sem rede e sem cache válido
  return new Response(
    JSON.stringify({ 
      success: false, 
      error: 'Offline - dados em cache expirados',
      offline: true 
    }),
    { 
      status: 503,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}

// ============================================================================
// Notificações Push
// ============================================================================
self.addEventListener('push', (event) => {
  if (!event.data) return;
  
  if (self.location.protocol !== 'https:' && self.location.hostname !== 'localhost') {
    console.warn('⚠️ [SW] Notificações push requerem HTTPS em produção');
    return;
  }
  
  try {
    const data = event.data.json();
    const { title, body, icon, tag, requireInteraction } = data;
    
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: icon || '/fazenda-waiter-192.png',
        tag: tag || 'kfm-order',
        requireInteraction: requireInteraction !== false,
        actions: [
          { action: 'view', title: 'Ver Pedido' },
          { action: 'dismiss', title: 'Dispensar' }
        ],
        data: { url: data.url || '/waiter.html' }
      })
    );
  } catch (e) {
    console.error('❌ [SW] Falha ao mostrar notificação push:', e);
  }
});

// ============================================================================
// Clique em Notificação
// ============================================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.action === 'view' || !event.action) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clientList) => {
          for (const client of clientList) {
            if (client.url.includes('/waiter.html') && 'focus' in client) {
              return client.focus();
            }
          }
          if (clients.openWindow) {
            return clients.openWindow(event.notification.data?.url || '/waiter.html');
          }
        })
    );
  }
});

// ============================================================================
// Background Sync
// ============================================================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-orders') {
    console.log('🔄 [SW] Background sync: sincronizando pedidos...');
    event.waitUntil(
      fetch(`${getAPIBase()}/api/waiter/orders`)
        .then(response => response.json())
        .then(data => {
          return self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({ 
                type: 'ORDERS_SYNCED', 
                data: data 
              });
            });
          });
        })
        .catch(err => console.error('❌ [SW] Sync failed:', err))
    );
  }
});

// ============================================================================
// Mensagens do Client para o Service Worker
// ============================================================================
self.addEventListener('message', (event) => {
  if (!event.data) return;
  
  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
      
    case 'CACHE_ORDERS':
      if (event.data.orders) {
        event.waitUntil(
          caches.open(CACHE_NAME).then(cache => {
            return cache.put('/api/waiter/orders', new Response(
              JSON.stringify({ success: true, orders: event.data.orders }),
              { headers: { 'Content-Type': 'application/json' } }
            ));
          })
        );
      }
      break;
      
    case 'REQUEST_NOTIFICATION_PERMISSION':
      if (self.location.protocol === 'https:' || self.location.hostname === 'localhost') {
        event.waitUntil(
          self.registration.showNotification('🔔 Notificações', {
            body: 'Ative as notificações para ser avisado quando pedidos estiverem prontos!',
            icon: '/fazenda-waiter-192.png',
            requireInteraction: true,
            actions: [
              { action: 'enable', title: 'Ativar' },
              { action: 'later', title: 'Depois' }
            ]
          })
        );
      } else {
        console.warn('⚠️ [SW] Notificações requerem HTTPS');
      }
      break;
  }
});

// ============================================================================
// Utilitários
// ============================================================================
function log(...args) {
  console.log('[SW]', ...args);
}

console.log('✅ [SW] Kitchen Flow Waiter Service Worker v1.4 carregado');
console.log('📦 Cache:', CACHE_NAME);
console.log('🔄 TTL da API:', CACHE_TTL / 1000 / 60, 'minutos');
console.log('🌐 API Base dinâmica:', getAPIBase());