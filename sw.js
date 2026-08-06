/* Service worker Loquivox — stratégie RESEAU-D-ABORD pour le code.
 *
 * Règle n° 4 d'AGENTS.md : servir le code depuis le cache fige les appareils.
 * C'est arrivé : les téléphones sont restés bloqués sur un instantané du
 * 4 août pendant que les correctifs s'accumulaient en ligne, invisibles.
 *
 * Principe :
 *   - index.html, *.js, *.json → RÉSEAU D'ABORD ; le cache ne sert qu'en
 *     cas de coupure. Chaque visite récupère donc la dernière version.
 *   - images et icônes → cache d'abord (elles ne changent presque jamais).
 *
 * Le numéro de version ne sert plus qu'à purger les vieux caches : il n'est
 * plus nécessaire de le changer à chaque correctif.
 */
const VERSION = 'loquivox-v5';
const PRECACHE = [
  './', './index.html', './cp-remote.js', './cp-meet.js',
  './manifest.json', './icon-192.png', './icon-512.png',
];
const CODE = /\.(?:js|html|json)(\?.*)?$/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isCode = req.mode === 'navigate' || CODE.test(url.pathname) || url.pathname === '/';

  if (isCode) {
    // RÉSEAU D'ABORD — le cache n'est qu'un filet de sécurité hors ligne.
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return r;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true })
            .then((r) => r || caches.match('./index.html'))
        )
    );
  } else {
    // Ressources statiques : cache d'abord, réseau en complément.
    e.respondWith(
      caches.match(req).then((r) =>
        r || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
      )
    );
  }
});
