/* 배당·자산관리 셸 서비스워커 — 자동 갱신형(network-first)
   · 화면(HTML/JS/CSS)은 항상 최신을 우선으로 받아옴 → 새 버전 올리면 자동 반영(캐시 삭제 불필요)
   · 아이콘 등 정적 자원만 캐시로 빠르게
   · API(JSON) 응답은 SW가 아예 손대지 않음 → 현재가·검색·공시가 항상 실시간

   버전 올리는 법: 아래 CACHE 숫자만 v7 → v8 … 로 올리면, 모든 기기가
   앱 열 때 새 워커로 자동 교체됨(index.html의 자동 새로고침과 함께). */
const CACHE = 'assetapp-v7';

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

  // 화면 자원: HTML/JS/CSS/manifest + 네비게이션 + 루트
  const isDoc = req.mode === 'navigate' ||
                /\.(html|js|css|json)$/.test(url.pathname) ||
                url.pathname === '/';
  // 정적 자원: 아이콘·이미지·폰트
  const isStatic = /\.(png|ico|webmanifest|svg|jpg|jpeg|webp|gif|woff2?)$/.test(url.pathname);

  if (isDoc) {
    // network-first: 최신 화면 우선, 오프라인이면 캐시로 폴백
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
  } else if (isStatic) {
    // cache-first: 잘 안 바뀌는 자원은 캐시로 빠르게
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
  // 그 외(/search, /price, /fxrate, /dividends, /addr, /gongsiga, /status, /warm 등 API):
  //   SW가 개입하지 않음 → 브라우저가 곧장 네트워크로 → 항상 최신 데이터
});
