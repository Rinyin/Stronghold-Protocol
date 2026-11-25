// Classic service worker for art a player imported or loaded while playing on this origin.
// Keep these three lines in sync with public/js/assetCache.js (that module documents why this file is not a module).
const IMPORTED_ASSET_CACHE = 'sp-imported-assets-v1';
const IMPORTED_ASSET_CACHE_PREFIX = 'sp-imported-assets-';
const IMPORTED_ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;
const IMPORTED_INDEX_URL = '/sp-imported-index.json';
const INDEX_LOCK_NAME = `${IMPORTED_ASSET_CACHE}:index`;
const INDEX_FLUSH_DELAY_MS = 300;
const INDEX_FLUSH_BATCH = 64;

const pendingIndexPaths = new Set();
let indexFlushTimer = null;
let indexFlushDeferred = null;
let indexFlushChain = Promise.resolve();

function shouldCacheResponse(response) {
  if (!response || !response.ok || response.status !== 200) return false;
  if (response.type && response.type !== 'basic' && response.type !== 'default') return false;
  const contentType = response.headers && typeof response.headers.get === 'function'
    ? (response.headers.get('content-type') || '')
    : '';
  if (/text\/html/i.test(contentType)) return false;
  const cacheControl = response.headers && typeof response.headers.get === 'function'
    ? (response.headers.get('cache-control') || '')
    : '';
  if (/\b(?:no-store|no-cache)\b/i.test(cacheControl)) return false;
  return true;
}

async function mergeIndexBatch(paths) {
  const cache = await caches.open(IMPORTED_ASSET_CACHE);
  let all = null;
  try {
    const hit = await cache.match(IMPORTED_INDEX_URL);
    if (hit) {
      const list = await hit.json();
      if (Array.isArray(list)) all = new Set(list.filter((p) => typeof p === 'string' && p !== IMPORTED_INDEX_URL));
    }
  } catch { /* unreadable index: fall back below */ }
  if (!all) {
    all = new Set();
    try {
      if (typeof cache.keys === 'function') {
        for (const req of await cache.keys()) {
          const pathname = new URL(typeof req === 'string' ? req : req.url, self.location.origin).pathname;
          if (pathname && pathname !== IMPORTED_INDEX_URL) all.add(pathname);
        }
      }
    } catch { /* Chrome refuses Cache.keys() above ~15k entries; still record new paths */ }
  }
  let changed = false;
  for (const p of paths) {
    if (p && p !== IMPORTED_INDEX_URL && !all.has(p)) {
      all.add(p);
      changed = true;
    }
  }
  if (!changed) return;
  await cache.put(IMPORTED_INDEX_URL, new Response(JSON.stringify([...all].sort()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function flushPendingIndex() {
  if (indexFlushTimer !== null) {
    clearTimeout(indexFlushTimer);
    indexFlushTimer = null;
  }
  const deferred = indexFlushDeferred;
  indexFlushDeferred = null;
  if (!pendingIndexPaths.size) {
    if (deferred) deferred.resolve();
    return indexFlushChain;
  }
  const batch = [...pendingIndexPaths];
  pendingIndexPaths.clear();
  const run = () => {
    const locks = self.navigator && self.navigator.locks;
    const task = () => mergeIndexBatch(batch);
    return locks && typeof locks.request === 'function' ? locks.request(INDEX_LOCK_NAME, task) : task();
  };
  indexFlushChain = indexFlushChain.then(run, run).catch(() => {});
  if (deferred) indexFlushChain.finally(() => deferred.resolve());
  return indexFlushChain;
}

function queueIndexPath(pathname) {
  if (!pathname || pathname === IMPORTED_INDEX_URL) return Promise.resolve();
  pendingIndexPaths.add(pathname);
  if (pendingIndexPaths.size >= INDEX_FLUSH_BATCH || typeof setTimeout !== 'function') {
    return flushPendingIndex();
  }
  if (!indexFlushDeferred) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    indexFlushDeferred = { promise, resolve };
  }
  if (indexFlushTimer === null) {
    indexFlushTimer = setTimeout(() => { flushPendingIndex(); }, INDEX_FLUSH_DELAY_MS);
  }
  return indexFlushDeferred.promise;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  // A cache-only probe (resourceCheck.js) must reach the browser HTTP cache. respondWith, even with 504, hides
  // that cache. Leaving the event unanswered lets a hit return and a miss reject, with no network. Cache Storage
  // is already decided by the page's caches.match before this probe.
  if (request.cache === 'only-if-cached') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (!IMPORTED_ASSET_PATH.test(url.pathname)) return;
  const cacheKey = url.origin + url.pathname;
  event.respondWith((async () => {
    const cache = await caches.open(IMPORTED_ASSET_CACHE);
    // The exact key: an import stores each URL without a query, so the path is the key. `ignoreSearch` would make
    // Chrome scan every entry — about 4 s per request once a whole pack (some 43,000 entries) is imported.
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    const response = await fetch(request);
    if (shouldCacheResponse(response)) {
      const copy = response.clone();
      const contentType = (response.headers && typeof response.headers.get === 'function' && response.headers.get('content-type'))
        || 'application/octet-stream';
      const persist = (async () => {
        try {
          const buf = await copy.arrayBuffer();
          if (!buf.byteLength) return;
          await cache.put(cacheKey, new Response(buf, {
            status: 200,
            headers: { 'Content-Type': contentType },
          }));
          await queueIndexPath(url.pathname);
        } catch {
          // Storage full, private browsing, or transient cache failure must never break gameplay loading.
        }
      })();
      if (typeof event.waitUntil === 'function') event.waitUntil(persist);
    }
    return response;
  })());
});
