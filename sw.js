// 열려라창고 PWA 서비스워커
// v3 — 알림 배지를 상자 모양 실루엣(notif-badge.png)으로 변경
const CACHE_NAME = 'wh-app-cache-v3';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './notif-badge.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(CORE)).catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// 네트워크 우선 + 실패 시 캐시 (GET만)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const isNav = req.mode === 'navigate';
  e.respondWith(
    fetch(isNav ? new Request(req, { cache: 'no-cache' }) : req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

// 웹푸시 수신 → 알림 표시
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch (_) { data = { body: e.data ? e.data.text() : '' }; }
  const title = data.title || '📦 새 매출 감지';
  const options = {
    body: data.body || '',
    icon: './icon-192.png',        // 알림창 안의 큰 아이콘(컬러 로고)
    badge: './notif-badge.png',    // 상태바 작은 아이콘(흰색 상자 실루엣)
    vibrate: [200, 100, 200],
    data: data
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// 알림 탭 → 앱 열기
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});
