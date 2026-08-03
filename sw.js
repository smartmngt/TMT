/* 배당·자산관리 셸 서비스워커 — 자동 갱신형(network-first)
   화면(HTML/JS/CSS)은 항상 최신을 우선으로 받아와서, 새 버전 올리면
   앱을 열 때 자동 반영됨. 아이콘 등 정적 자원만 캐시로 빠르게. */
const CACHE = 'assetapp-v6';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/status' || url.pathname.startsWith('/backtest')) return;

  const isDoc = req.mode === 'navigate' ||
                /\.(html|js|css|json)$/.test(url.pathname) ||
                url.pathname === '/';

  if (isDoc) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
  } else {
    e.respondWith(
      caches.match(req).then(cached =>
        cached || fetch(req).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
      )
    );
  }
});
