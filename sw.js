/* Xeko PWA service worker */
const VERSION = 'xeko-pwa-v24';
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

// HTML bị loại khỏi SHELL_ASSETS — không pre-cache, vì sẽ stale sau mỗi lần deploy.
// index.html luôn được fetch từ network (navigation handler là network-first).
const SHELL_ASSETS = [
  './manifest.webmanifest',
  './favicon.svg',
  './favicon-32.png',
  './xeko-logo-180.png',
  './xeko-icon-192.png',
  './xeko-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim()).then(async () => {
      // Page reload hết tab đang mở — clients.claim() chỉ control SW mới,
      // không nạp lại JS cũ đang chạy. Cần postMessage cho client tự reload.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'SW_UPDATED', version: VERSION });
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, no cache write (auth-sensitive)
  if (isApiRequest(url)) {
    event.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ offline: true, error: 'offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // Navigations: network-only — HTML có Cache-Control: no-store nên không cache.
  // Không cần offline fallback vì app không dùng được offline (cần server + Playwright).
  if (isNavigation(request)) {
    event.respondWith(fetch(request));
    return;
  }

  // Static: cache-first for non-HTML assets, populate runtime cache on miss.
  // HTML luôn bị bỏ qua cache để tránh serve stale code sau deploy.
  const isHtmlRequest = url.pathname === '/' || url.pathname.endsWith('.html');
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached && !isHtmlRequest) return cached;
      return fetch(request).then((res) => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        if (!isHtmlRequest) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
