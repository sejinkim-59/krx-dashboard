const SHELL_CACHE = 'krx-dashboard-shell-v3';
const SHELL_FILES = [
  './', './index.html', './css/style.css',
  './js/app.js', './js/cards.js', './js/charts.js', './js/vendor/chart.umd.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 앱 셸/데이터 모두 네트워크 우선 — 오프라인일 때만 캐시로 대체.
// (데이터가 계속 갱신되는 대시보드 특성상, 최신 버전이 항상 우선되어야 함)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
