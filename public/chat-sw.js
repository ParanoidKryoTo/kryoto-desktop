// The web chat's service worker (chat.kryo.to): only notifications.
//
// The chat server sends an EMPTY push when a message arrives while no chat
// tab is open (kryoto-gateway src/push.rs). There is nothing in it to read:
// messages are end-to-end encrypted and stay on the server until the chat
// opens and fetches them, so the notice says only that something is waiting.
// Nothing is cached here; the page always loads fresh.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // An open, visible chat already shows the message.
      if (windows.some((w) => w.visibilityState === 'visible')) return
      await self.registration.showNotification('Kryoto chat', {
        body: 'You have a new message.',
        tag: 'kryo-chat',
        renotify: true,
        icon: '/brand/kryo-mark-ascii.png',
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) return open.focus()
      return self.clients.openWindow('/')
    })(),
  )
})
