/* global self, caches, fetch, URL, Response */
const SHELL = "germinatura-pdv-shell-v2";
// ADR 0011: one catalog cache per concrete cohort ("germinatura-pdv-catalog-v2:<cohort id>"); there is no shared or
// default-cohort snapshot. The offline screen opens only the cache of the cohort the PDV operates in.
const CATALOG_PREFIX = "germinatura-pdv-catalog-v2:";
const SNAPSHOT = "/offline/catalog-snapshot";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const ASSETS = ["/offline", "/offline.css", "/offline.js", "/offline/brand.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    for (const path of ASSETS) {
      const response = await fetch(path, { credentials: "omit", cache: "reload", redirect: "error" });
      if (!response.ok) throw new Error("Offline shell unavailable");
      await cache.put(path, response);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      // Drops older shells and every pre-cohort catalog (v1 held the default cohort's catalog for any cohort).
      if (key.startsWith("germinatura-pdv-") && key !== SHELL && !key.startsWith(CATALOG_PREFIX)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET") return;
  // No API, auth, framework-chunk, mutation or other third-party response cache.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith((async () => (await (await caches.open(SHELL)).match(url.pathname)) || fetch(request))());
  } else if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const shell = await (await caches.open(SHELL)).match("/offline");
      return shell || new Response("Sem conexão. Reconecte para abrir o PDV.", { status: 503 });
    }));
  }
});

const refreshing = new Map();
let clearing = Promise.resolve();
self.addEventListener("message", (event) => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  const data = event.data;
  // Logout or a new sign-in: no cohort's copy survives on this device.
  if (data?.type === "CLEAR_OFFLINE_CATALOGS") {
    clearing = clearing.then(clearCatalogs, clearCatalogs);
    event.waitUntil(clearing);
    return;
  }
  if (data?.type !== "REFRESH_COHORT_CATALOG") return;
  // Only a concrete cohort (never "all", never none) with its public slug; anything else refreshes nothing.
  if (typeof data.cohortId !== "string" || !UUID.test(data.cohortId) || typeof data.slug !== "string" || !SLUG.test(data.slug)
    || typeof data.name !== "string" || !data.name.length || data.name.length > 80) return;
  // Concurrent requests for one cohort share one anonymous refresh; a failure never affects a sale.
  if (!refreshing.has(data.cohortId)) {
    refreshing.set(data.cohortId, refreshCatalog(data.cohortId, data.slug, data.name).finally(() => refreshing.delete(data.cohortId)));
  }
  event.waitUntil(refreshing.get(data.cohortId));
});

async function clearCatalogs() {
  for (const key of await caches.keys()) if (key.startsWith(CATALOG_PREFIX)) await caches.delete(key);
}

async function refreshCatalog(cohortId, slug, name) {
  const cacheName = CATALOG_PREFIX + cohortId;
  try {
    // A refresh never races a clear requested before it.
    await clearing;
    // The public catalog of that cohort, resolved by the Portal from its slug; no session, no default cohort.
    const response = await fetch(`/api/v1/catalog/products?limit=50&turma=${encodeURIComponent(slug)}`, { credentials: "omit", cache: "no-store", redirect: "error" });
    // Unknown or no longer public: the cohort's copy goes away instead of standing in for anything else.
    if (response.status === 404) { await caches.delete(cacheName); return; }
    if (!response.ok) return;
    // The Portal names the cohort it resolved; a different one (or none) is never stored under this cohort.
    if (response.headers.get("x-germinatura-cohort") !== cohortId) return;
    const body = await response.json();
    if (!Array.isArray(body.data) || body.data.length > 50) return;
    const products = [];
    for (const product of body.data) {
      if (product.sellablePdv !== true) continue;
      if (typeof product.name !== "string" || !product.name.length || product.name.length > 160
        || !Number.isSafeInteger(product.price?.amountCents) || product.price.amountCents < 0 || product.price.currency !== "BRL") return;
      // Explicit public projection: never retain request IDs, session, balances or payload extras.
      const cover = Array.isArray(product.images) ? product.images.find((image) => image?.sortOrder === 0) : null;
      if (cover && (typeof cover.publicUrl !== "string" || typeof cover.altText !== "string" || cover.altText.length > 180)) return;
      const snapshotProduct = { name: product.name, amountCents: product.price.amountCents };
      if (cover) { snapshotProduct.imageUrl = cover.publicUrl; snapshotProduct.imageAlt = cover.altText; }
      products.push(snapshotProduct);
    }
    const cache = await caches.open(cacheName);
    for (let start = 0; start < products.length; start += 4) {
      await Promise.all(products.slice(start, start + 4).map(async (product) => {
        if (!product.imageUrl) return;
        try {
          const image = await fetch(product.imageUrl, { credentials: "omit", cache: "reload", redirect: "error" });
          if (image.ok && image.headers.get("content-type")?.startsWith("image/")) await cache.put(product.imageUrl, image);
        } catch { /* The text snapshot remains useful when a public image is unavailable. */ }
      }));
    }
    await cache.put(SNAPSHOT, new Response(JSON.stringify({ cohortId, cohortName: name, savedAt: Date.now(), partial: body.nextCursor != null, products }),
      { headers: { "Content-Type": "application/json" } }));
  } catch {
    // Keep the cohort's last valid, dated snapshot; the viewer refuses it after 24 hours.
  }
}
