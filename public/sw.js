// Minimal service worker. Required for PWA installability ("Add to Home
// Screen") on Chrome and most other browsers — the install prompt won't
// fire without one. We deliberately do NOT cache responses: the app
// requires live API calls to Anthropic / Open Library / etc., and a
// stale cache would silently break processing. Network-only is correct.

self.addEventListener('install', (event) => {
  // Activate immediately on the next page load — no waiting on tabs.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // No-op. Browser handles the request as if no SW were present.
});
