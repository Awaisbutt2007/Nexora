/* Nexora service worker — makes the app installable and lets the shell open offline.

   THE ONE HARD RULE: never cache /api or /uploads. Those carry the signed-in user's
   conversations, memories, voice prints and uploaded media, all served from the same
   origin. An offline mirror of them would live on the machine for the next person who
   opens the app. So every request under those prefixes is passed straight to the
   network and is never written to a Cache.

   What we DO cache is the app shell only: the hashed, immutable /assets bundle plus
   index.html, so a reload with no connection still boots the UI (which then shows its
   normal signed-out / offline state, not a blank page). Bump VERSION on any shell
   change so stale caches are replaced on activate. */
const VERSION = 'nexora-v2'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/pwa-icon.svg', '/pwa-icon-maskable.svg', '/pwa-icon-192.png', '/pwa-icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/* Requests we must never touch — live network only, no caching, no interception.
   Prefix match, not equality: the real paths are /api/chat/completions, /uploads/img_x.png,
   so an exact compare would miss them and mirror a signed-in user's data into the Cache. */
function isPrivate(pathname) {
  return pathname.startsWith('/api') || pathname.startsWith('/uploads')
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (isPrivate(url.pathname)) return

  /* Navigations: network-first so the user always gets the newest deploy when online,
     and fall back to the cached shell only when the network is truly unreachable. */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(VERSION).then((cache) => cache.put('/index.html', copy))
          return res
        })
        .catch(() => caches.match('/index.html')),
    )
    return
  }

  /* Everything else (hashed assets, fonts we host): cache-first, then network, and
     store a fresh copy the first time it is seen. */
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(VERSION).then((cache) => cache.put(req, copy))
          }
          return res
        })
        .catch(() => hit)
    }),
  )
})
