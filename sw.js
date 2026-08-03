/* 배당·자산관리 셸 서비스워커 — 설치형 PWA + 오프라인 셸 캐시 */
const CACHE = 'assetapp-v0803.004';
const CORE = [
  './', './index.html', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-180.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // POST(백테스트 등)는 그대로
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // 백엔드/외부 요청은 통과
  if (url.pathname === '/status' ||
      url.pathname.startsWith('/backtest')) return;        // 동적 데이터는 항상 네트워크

  // 셸/정적자원: 캐시 우선 + 네트워크로 갱신
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
