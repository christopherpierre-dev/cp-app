// Loquivox Service Worker — RESEAU-D-ABORD
//
// Le code (HTML, JS) est TOUJOURS pris sur le reseau quand il est joignable,
// et servi depuis le cache seulement si le reseau echoue. C'est ce qui
// empeche les appareils de rester figes sur une vieille version : un correctif
// deploye est recu au chargement suivant, sans attendre un changement de nom
// de cache. Le cache ne sert que de secours hors ligne.
//
// NE PAS revenir a une strategie cache-d'abord (caches.match d'abord) : cela
// a fige les telephones sur de vieux fichiers le 5 aout, puis de nouveau le
// 10 aout (cache v3). Voir le controle automatique .github/workflows.
const CACHE = 'loquivox-v4';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        // rafraichir le cache des ressources du site, pour le mode hors ligne
        if (e.request.url.indexOf(self.location.origin) === 0) {
          const copie = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copie)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('/index.html')))
  );
});
