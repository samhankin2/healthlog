/* HealthLog offline app shell. API requests always go directly to the network. */
'use strict'

const CACHE_NAME = 'healthlog-shell-v1'
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
]

function appUrl(path) {
  return new URL(path, self.registration.scope).href
}

function shellUrl() {
  return appUrl('./index.html')
}

function sameOrigin(url) {
  return url.origin === self.location.origin
}

/** Covers root APIs and same-origin APIs mounted below a Pages sub-path. */
function isApiRequest(url) {
  return url.pathname === '/api' || url.pathname.includes('/api/')
}

async function precacheHashedAssets(cache) {
  try {
    const response = await cache.match(shellUrl())
    if (!response) return
    const html = await response.text()
    const pattern = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/gi
    const targets = new Set()
    for (const match of html.matchAll(pattern)) {
      try {
        const url = new URL(match[1], shellUrl())
        if (sameOrigin(url) && !isApiRequest(url) && !url.pathname.endsWith('/sw.js')) {
          targets.add(url.href)
        }
      } catch {
        // Ignore malformed or non-URL references; the network remains available.
      }
    }
    await Promise.allSettled([...targets].map((url) => cache.add(new Request(url, { cache: 'reload' }))))
  } catch {
    // Static assets are also cached at runtime, so discovery is best-effort.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await Promise.allSettled(SHELL_ASSETS.map((path) => cache.add(new Request(appUrl(path), { cache: 'reload' }))))
    await precacheHashedAssets(cache)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith('healthlog-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  let url
  try { url = new URL(request.url) } catch { return }
  if (!sameOrigin(url) || isApiRequest(url) || request.headers.has('authorization')) return
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  if (url.pathname.endsWith('/sw.js') || request.headers.has('range')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, event))
  } else {
    event.respondWith(staleWhileRevalidate(request, event))
  }
})

async function networkFirst(request, event) {
  try {
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') {
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(shellUrl(), response.clone())).catch(() => {}))
    }
    return response
  } catch {
    return (await caches.match(shellUrl(), { ignoreSearch: true }))
      ?? (await caches.match(appUrl('./'), { ignoreSearch: true }))
      ?? offlineFallback()
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      event.waitUntil(cache.put(request, response.clone()).catch(() => {}))
    }
    return response
  })
  if (cached) {
    event.waitUntil(network.catch(() => {}))
    return cached
  }
  try { return await network } catch { return new Response('', { status: 504, statusText: 'Offline' }) }
}

function offlineFallback() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HealthLog offline</title><body style="font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f3f5f1;color:#19231f"><p>HealthLog is offline and has not finished caching yet.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}
