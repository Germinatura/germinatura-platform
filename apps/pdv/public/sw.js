/* global self, caches, fetch, URL, Response */
const SHELL = "germinatura-pdv-shell-v1";
const CATALOG = "germinatura-pdv-catalog-v1";
const SNAPSHOT = "/offline/catalog-snapshot";
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
      if (key.startsWith("germinatura-pdv-") && key !== SHELL && key !== CATALOG) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // No API, auth, image, framework-chunk, mutation or third-party response cache.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith((async () => (await (await caches.open(SHELL)).match(url.pathname)) || fetch(request))());
  } else if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const shell = await (await caches.open(SHELL)).match("/offline");
      return shell || new Response("Sem conexão. Reconecte para abrir o PDV.", { status: 503 });
    }));
  }
});

let refreshing;
self.addEventListener("message", (event) => {
  if (event.data?.type !== "REFRESH_PUBLIC_CATALOG" || !event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  // Concurrent requests share one anonymous refresh; a failure never affects a sale.
  refreshing ??= refreshCatalog().finally(() => { refreshing = undefined; });
  event.waitUntil(refreshing);
});

async function refreshCatalog() {
  try {
    const response = await fetch("/api/v1/catalog/products?limit=50", { credentials: "omit", cache: "no-store", redirect: "error" });
    if (!response.ok) return;
    const body = await response.json();
    if (!Array.isArray(body.data) || body.data.length > 50) return;
    const products = [];
    for (const product of body.data) {
      if (product.sellablePdv !== true) continue;
      if (typeof product.name !== "string" || !product.name.length || product.name.length > 160
        || !Number.isSafeInteger(product.price?.amountCents) || product.price.amountCents < 0 || product.price.currency !== "BRL") return;
      // Explicit public projection: never retain request IDs, session, balances or payload extras.
      products.push({ name: product.name, amountCents: product.price.amountCents });
    }
    const cache = await caches.open(CATALOG);
    await cache.put(SNAPSHOT, new Response(JSON.stringify({ savedAt: Date.now(), partial: body.nextCursor != null, products }), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // Keep the last valid, dated snapshot; the viewer refuses it after 24 hours.
  }
}
