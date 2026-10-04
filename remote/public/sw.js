// Windose's service worker: phone notifications (push, sent by server/push/) and opening Windose from one.
// It caches nothing -- every page needs the server anyway. Being registered is also what lets Chrome install the
// site as an app (with manifest.webmanifest).
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Windose', {
    body: d.body || '',
    tag: d.tag || undefined, renotify: !!d.tag,                    // (the same thing again replaces its notification)
    icon: '/app/icon-192.png', badge: '/app/badge-96.png',
    requireInteraction: d.kind === 'approval',                    // a prompt waiting stays until you look
    vibrate: [80, 40, 80],
    data: { url: d.url || '/' },
  }));
});

// a tap: an open Windose window goes to that session / message; none open, a new one
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      w.postMessage({ t: 'open', url });
      return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
