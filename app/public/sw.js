// Teremu service worker — deliberately empty. It exists so the browser
// treats Teremu as an installable app; it caches NOTHING and has no fetch
// handler, so every request goes to the network exactly as without it.
// Teremu is online-only: when offline the app shows a notice instead
// (src/lib/pwa.ts). Don't add caching here without a plan for stale
// deploys.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
