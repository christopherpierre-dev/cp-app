// Equivox — service worker
// Stratégie : RÉSEAU D'ABORD pour le code (index.html, cp-remote.js) afin que
// chaque déploiement atteigne immédiatement tous les appareils ; le cache ne
// sert qu'en secours hors-ligne. Les icônes/manifest restent cache d'abord.
// Changer CACHE_NAME invalide les caches des anciennes versions.
const CACHE_NAME = 'equivox-v2';
const PRECACHE = [
  './',
  './index.html',
  './cp-remote.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Fichiers de code : toujours tenter le réseau en premier
const NETWORK_FIRST = /(\/$|index\.html|cp-remote\.js|manifest\.json)/;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isCode = req.mode === 'navigate' ||
                 (url.origin === location.origin && NETWORK_FIRST.test(url.pathname));

  if (isCode) {
    // Réseau d'abord : version fraîche à chaque visite, cache en secours
    event.respondWith(
      fetch(req).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() =>
        caches.match(req).then(c => c || caches.match('./index.html'))
      )
    );
  } else {
    // Ressources statiques : cache d'abord, réseau en complément
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        });
      })
    );
  }
});
