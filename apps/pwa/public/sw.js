/* Service worker ГСК «Родник».
   Приложение работает только онлайн: данные API и фото НИКОГДА не кэшируются (они приватные).
   Кэшируются только статические файлы самого приложения, чтобы оно быстро запускалось. */
const CACHE = 'gsk-shell-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // оболочка: сеть, при отсутствии связи — сохранённый index
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'ГСК «Родник»', body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'ГСК «Родник»', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // переходим только по путям внутри приложения (не по внешним адресам из содержимого уведомления);
  // «/\хост» браузер читает как «//хост», то есть внешний адрес — его тоже отсекаем
  const raw = (e.notification.data && e.notification.data.url) || '/';
  const target = typeof raw === 'string' && /^\/(?![/\\])[^\s]*$/.test(raw) ? raw : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(target);
    }),
  );
});
