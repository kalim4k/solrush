// Service worker: makes the game open offline, and keeps it opening after a
// deploy without serving half of the old version alongside half of the new one.
//
// Bump CACHE whenever the shell changes. The old cache is deleted on activate,
// so a stale engine.js can never be paired with a fresh app.js — which is the
// failure mode that produces bug reports nobody can reproduce.
const CACHE = 'solrush-v11';

const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/engine.js',
  '/js/ai.js',
  '/js/ai-worker.js',
  '/js/i18n.js',
  '/js/ranks.js',
  '/js/streak.js',
  '/js/nick.js',
  '/js/account.js',
  '/js/voice.js',
  '/js/cosmetics.js',
  '/js/packs.js',
  // All six packs. Together they are smaller than one photograph, and without
  // them the game opens offline in English regardless of what the player chose.
  '/lang/en.js',
  '/lang/fr.js',
  '/lang/es.js',
  '/lang/ru.js',
  '/lang/tr.js',
  '/lang/fa.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    try {
      /* cache: 'reload' is load-bearing, not a precaution.

         A plain addAll() reads through the browser's HTTP cache. This server
         used to send `immutable, max-age=31536000` on unversioned files, so a
         browser that visited before is holding /lang/fr.js and friends under a
         one-year no-questions-asked lease. addAll() would refill this brand-new
         cache from those stale entries and faithfully preserve the bug. 'reload'
         bypasses the HTTP cache and overwrites the poisoned entry on the way
         through, which is the only way to break an immutable lease early. */
      await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    } catch (err) {
      /* Deliberately not fatal. This used to reject the install, which sounds
         strict but meant the OLD worker stayed in control serving OLD files —
         forever, on any deploy where one shell file moved. A worker with a
         partial cache is degraded offline; a worker that never activates is a
         site frozen in the past. Online play does not touch this cache. */
      console.warn('sw precache incomplete', err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never cache third parties

  // The API is live data — a cached leaderboard or a cached /api/config is a
  // bug, not an optimisation. Let these fail loudly when offline; the app has
  // an offline banner for exactly that.
  if (url.pathname.startsWith('/api/')) return;

  // Network first for the shell document, so a deploy is picked up immediately;
  // cache is the fallback for the tunnel/lift case.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  e.respondWith(freshFirst(req));
});

/* Network first, cache only as the offline fallback.

   The previous version did the opposite — cache first, matched with
   ignoreSearch — and that combination is what shipped two bugs to a returning
   player while every screenshot I took looked perfect.

   ignoreSearch itself was a real fix: install() stores "/css/style.css" but the
   page asks for "/css/style.css?v=122", and an exact match misses, so offline
   the game opened unstyled. The mistake was putting it on the PRIMARY path.
   Combined with cache-first it means the cached copy answers every request for
   that path no matter what query string is attached — so bumping ?v= stops
   doing anything at all. The version bump lands in the URL bar and the worker
   quietly serves the file from last week.

   ignoreSearch belongs on the fallback path only. Offline, an approximate match
   is exactly what you want. Online, it is a promise to never update again.

   Note this is invisible in a fresh browser profile: no worker, no cache, every
   request goes to the network and everything looks correct. It only appears on
   the second visit. */
async function freshFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    /* 'no-cache' means revalidate, not "don't cache" — the server answers 304
       from an ETag when nothing changed, so this costs a round trip, not a
       download. It also steps around any immutable lease left by the old
       headers, which a plain fetch() would happily honour for a year. */
    const res = await fetch(new Request(req, { cache: 'no-cache' }));
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline and not cached: ' + req.url);
  }
}

/* ---- push ---- */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* not JSON */ }
  e.waitUntil(self.registration.showNotification(data.title || 'SolRush', {
    body: data.body || 'Your turn',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'solrush',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  // Focus the tab that is already open rather than stacking a second copy of
  // the game on top of a live match.
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
