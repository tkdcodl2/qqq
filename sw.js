/* Portfolio — 가격 알림 서비스 워커 (index.html 과 같은 폴더에 두세요)
   푸시를 받으면 알림을 띄우고, 알림을 누르면 앱의 시세 화면을 연다. 캐시는 건드리지 않는다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: '가격 알림', body: e.data ? e.data.text() : '' }; }
  const title = d.title || '가격 알림';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,            // 같은 알림이 겹치면 하나로
    icon: 'icons/icon-180.png',
    badge: 'icons/icon-48.png',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { if (c.navigate) await c.navigate(url); } catch (x) {} return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
