/* MedFlash — service worker
   Stratégie :
   - navigation (le HTML)  -> réseau d'abord, cache en secours (donc toujours la dernière version en ligne)
   - statique même origine -> cache d'abord + rafraîchissement en arrière-plan
   - polices Google        -> cache d'abord (elles ne changent jamais)
   - modules Firebase      -> cache d'abord (URL versionnées)
   - API Firebase (auth / Firestore) -> JAMAIS mis en cache, Firestore gère sa propre persistance
   Incrémente VERSION à chaque déploiement pour forcer le rafraîchissement du cache.
*/
const VERSION = 'medflash-v2';
const CORE_CACHE = VERSION + '-core';
const RUNTIME_CACHE = VERSION + '-runtime';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Domaines à ne jamais intercepter (auth + base de données temps réel)
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseapp.com',
  'google.com/log'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CORE_CACHE)
      .then(function (c) { return c.addAll(CORE_ASSETS); })
      .catch(function (err) { console.warn('[sw] pré-cache partiel', err); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CORE_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Permet à la page de déclencher la mise à jour immédiate
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      });
    });
  });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  for (var i = 0; i < NEVER_CACHE.length; i++) {
    if (url.hostname.indexOf(NEVER_CACHE[i]) !== -1 || req.url.indexOf(NEVER_CACHE[i]) !== -1) return;
  }

  // 1. Navigation : réseau d'abord
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CORE_CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  // 2. Polices Google + modules Firebase : cache d'abord
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com' ||
      (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0)) {
    e.respondWith(cacheFirst(req, RUNTIME_CACHE).catch(function () { return caches.match(req); }));
    return;
  }

  // 3. Même origine : cache d'abord, rafraîchi en tâche de fond
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req, CORE_CACHE).catch(function () { return fetch(req); }));
    return;
  }

  // 4. Le reste : réseau, secours cache
  e.respondWith(fetch(req).catch(function () { return caches.match(req); }));
});

// ════════════════════════════════════════
// NOTIFICATIONS PUSH (Firebase Cloud Messaging)
// Reçoit les notifs envoyées par la Cloud Function planifiée, même app fermée.
// ════════════════════════════════════════
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA9_Wu-lm0KRgiISNM58ViaNS2AlbxjEqc",
  projectId: "medflash-5cc34",
  messagingSenderId: "28164879236",
  appId: "1:28164879236:web:b00e5a0a753556fee323d1"
});

var messaging = firebase.messaging();

// Affiche la notif quand elle arrive alors que l'app est fermée / en arrière-plan
messaging.onBackgroundMessage(function (payload) {
  var data = payload.notification || {};
  var title = data.title || 'MedFlash';
  var options = {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: (payload.data && payload.data.url) || './' }
  };
  self.registration.showNotification(title, options);
});

// Clic sur la notif -> ouvre (ou refocus) MedFlash
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var targetUrl = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
