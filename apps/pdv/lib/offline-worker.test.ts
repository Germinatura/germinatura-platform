import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../public/offline.js", import.meta.url), "utf8");

const cohortA = "c0000000-0000-4000-8000-000000002026";
const cohortB = "c0000000-0000-4000-8000-000000002027";
const catalogOf = (cohort: string) => `germinatura-pdv-catalog-v2:${cohort}`;
const SNAPSHOT = "/offline/catalog-snapshot";

/** One device: the Cache Storage shared by the service worker and the offline screen. */
function device() {
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return { put: async (key: string, value: Response) => { store.set(key, value); }, match: async (key: string) => store.get(key)?.clone() };
    },
    has: async (name: string) => stores.has(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  return { stores, caches };
}

function worker(shared = device()) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fetcher = vi.fn(async () => new Response("shell"));
  runInNewContext(source, {
    self: { location: { origin: "https://pdv.test" }, addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: shared.caches, fetch: fetcher, URL, Response,
  });
  async function lifecycle(name: string, data = {}) {
    let pending: Promise<unknown> | undefined;
    listeners[name]({ ...data, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return { listeners, stores: shared.stores, fetcher, lifecycle, shared };
}

/** The Portal's public catalog of one cohort, as the PDV forwards it; the resolved cohort is named in a header. */
function catalog(cohort: string | null, names: string[]) {
  return Response.json({ data: names.map((name) => ({ name, sellablePdv: true, price: { amountCents: 1000, currency: "BRL" } })), nextCursor: null },
    { headers: cohort ? { "x-germinatura-cohort": cohort } : {} });
}
const refresh = (cohortId: string, slug: string, name = `Turma ${slug}`) =>
  ({ data: { type: "REFRESH_COHORT_CATALOG", cohortId, slug, name }, source: { url: "https://pdv.test/" } });
const clear = { data: { type: "CLEAR_OFFLINE_CATALOGS" }, source: { url: "https://pdv.test/login" } };

interface FakeNode { tag?: string; textContent: string; children: FakeNode[] }

/** Opens the offline screen (public/offline.js) on the device, with the PDV cohort cookie as it stands. */
async function openOfflineScreen(shared: ReturnType<typeof device>, cookie: string) {
  const nodes = new Map<string, FakeNode & Record<string, unknown>>();
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const element: FakeNode & Record<string, unknown> = { id, textContent: "", value: "", disabled: false, children: [] };
      element.replaceChildren = () => { element.children = []; };
      element.append = (...items: FakeNode[]) => { element.children.push(...items); };
      element.addEventListener = () => undefined;
      nodes.set(id, element);
    }
    return nodes.get(id)!;
  };
  const createElement = (tag: string) => {
    const element: FakeNode & Record<string, unknown> = { tag, textContent: "", children: [] };
    element.append = (...items: FakeNode[]) => { element.children.push(...items); };
    return element;
  };
  runInNewContext(viewerSource, {
    document: { cookie, getElementById: node, createElement, addEventListener: () => undefined },
    caches: shared.caches, Intl, Date, setInterval: () => 0, URL: { createObjectURL: () => "blob:local" }, decodeURIComponent,
  });
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  const products = node("catalog").children.map((card) => card.children.find((child) => child.tag === "h2")?.textContent);
  return { products, status: node("status").textContent, cohort: node("cohort").textContent };
}

describe("PDV offline cache boundary", () => {
  it("prepares only the explicit public shell with credentials omitted", async () => {
    const w = worker();
    await w.lifecycle("install");
    expect(w.stores.get("germinatura-pdv-shell-v2")?.size).toBe(5);
    expect(w.fetcher).toHaveBeenCalledWith("/offline", { credentials: "omit", cache: "reload", redirect: "error" });
    expect(w.stores.get("germinatura-pdv-shell-v2")?.has("/")).toBe(false);
  });

  it("does not intercept mutations, APIs, images or third-party assets", () => {
    const w = worker();
    for (const [url, method, destination] of [["https://pdv.test/api/v1/sales/checkout", "POST", ""], ["https://pdv.test/api/v1/auth/session", "GET", ""],
      ["https://other.test/offline", "GET", ""], ["https://pdv.test/_next/static/chunk.js", "GET", ""],
      ["https://storage.test/storage/v1/object/public/product-images/products/a.webp", "GET", "image"]]) {
      const respondWith = vi.fn();
      w.listeners.fetch({ request: { url, method, mode: "cors", destination }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it("falls back to session-free HTML without caching operational navigation", async () => {
    const w = worker();
    await w.lifecycle("install");
    w.fetcher.mockRejectedValueOnce(new Error("offline"));
    let result: Promise<Response> | undefined;
    w.listeners.fetch({ request: { url: "https://pdv.test/", method: "GET", mode: "navigate" }, respondWith: (response: Promise<Response>) => { result = response; } });
    expect(await (await result)?.text()).toBe("shell");
    expect(w.stores.get("germinatura-pdv-shell-v2")?.has("/")).toBe(false);
  });

  it("drops the pre-cohort catalog and older shells on activation", async () => {
    const w = worker();
    for (const name of ["germinatura-pdv-catalog-v1", "germinatura-pdv-shell-v1", catalogOf(cohortA), "germinatura-pdv-shell-v2", "other-app"]) await w.shared.caches.open(name);
    await w.lifecycle("activate");
    expect([...w.stores.keys()].sort()).toEqual([catalogOf(cohortA), "germinatura-pdv-shell-v2", "other-app"].sort());
  });

  it("saves the cohort's public catalog under that cohort, projecting only public fields", async () => {
    const w = worker();
    const imageUrl = "https://storage.test/product.webp";
    w.fetcher
      .mockResolvedValueOnce(Response.json({ data: [{ name: "Produto", sellablePdv: true, price: { amountCents: 1250, currency: "BRL" }, images: [{ sortOrder: 0, publicUrl: imageUrl, altText: "Produto embalado" }], balance: 10, user: "private" }], nextCursor: "more", request_id: "not-cached" },
        { headers: { "x-germinatura-cohort": cohortA } }))
      .mockResolvedValueOnce(new Response("image", { headers: { "Content-Type": "image/webp" } }));
    await w.lifecycle("message", refresh(cohortA, "turma-2026", "Turma 2026"));
    const snapshot = w.stores.get(catalogOf(cohortA))?.get(SNAPSHOT);
    expect(await snapshot?.clone().json()).toEqual({ cohortId: cohortA, cohortName: "Turma 2026", savedAt: expect.any(Number), partial: true,
      products: [{ name: "Produto", amountCents: 1250, imageUrl, imageAlt: "Produto embalado" }] });
    expect(w.stores.get(catalogOf(cohortA))?.has(imageUrl)).toBe(true);
    // Anonymous, by the cohort's public slug: no session, no cookie, no default cohort.
    expect(w.fetcher).toHaveBeenCalledWith("/api/v1/catalog/products?limit=50&turma=turma-2026", { credentials: "omit", cache: "no-store", redirect: "error" });
    // A failed refresh keeps the cohort's last valid copy.
    w.fetcher.mockRejectedValueOnce(new Error("offline"));
    await w.lifecycle("message", refresh(cohortA, "turma-2026", "Turma 2026"));
    expect(w.stores.get(catalogOf(cohortA))?.get(SNAPSHOT)).toBe(snapshot);
  });

  it("cohort A, then B: each copy stays under its own cohort; offline, B never sees A's products and A gets only A's back", async () => {
    const shared = device();
    const w = worker(shared);
    w.fetcher.mockResolvedValueOnce(catalog(cohortA, ["Camiseta 2026"]));
    await w.lifecycle("message", refresh(cohortA, "turma-2026"));
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortA}`)).products).toEqual(["Camiseta 2026"]);

    // Switched to B, still online: B's copy is saved apart; A's is not reused.
    w.fetcher.mockResolvedValueOnce(catalog(cohortB, ["Moletom 2027"]));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    const offlineB = await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortB}`);
    expect(offlineB.products).toEqual(["Moletom 2027"]);
    expect(offlineB.cohort).toBe("Turma: Turma turma-2027");

    // Back to A: only A's copy.
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortA}`)).products).toEqual(["Camiseta 2026"]);
  });

  it("B without its own copy shows no copy, even when A's (the default cohort's) exists", async () => {
    const shared = device();
    const w = worker(shared);
    w.fetcher.mockResolvedValueOnce(catalog(cohortA, ["Camiseta 2026"]));
    await w.lifecycle("message", refresh(cohortA, "turma-2026"));
    const offlineB = await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortB}`);
    expect(offlineB.products).toEqual([]);
    expect(offlineB.status).toContain("Nenhuma cópia válida");
    expect(shared.stores.has(catalogOf(cohortB))).toBe(false);
  });

  it("a copy filed under the wrong cohort is refused by the offline screen", async () => {
    const shared = device();
    const cache = await shared.caches.open(catalogOf(cohortB));
    await cache.put(SNAPSHOT, Response.json({ cohortId: cohortA, cohortName: "Turma 2026", savedAt: Date.now(), partial: false, products: [{ name: "Camiseta 2026", amountCents: 1000 }] }));
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortB}`)).products).toEqual([]);
  });

  it("without a concrete cohort (none, all, malformed) the offline screen opens no copy", async () => {
    const shared = device();
    const w = worker(shared);
    w.fetcher.mockResolvedValueOnce(catalog(cohortA, ["Camiseta 2026"]));
    await w.lifecycle("message", refresh(cohortA, "turma-2026"));
    for (const cookie of ["", "germinatura_pdv_cohort=all", "germinatura_pdv_cohort=2026", `other=${cohortA}`]) {
      const screen = await openOfflineScreen(shared, cookie);
      expect(screen.products, cookie).toEqual([]);
      expect(screen.status, cookie).toContain("Nenhuma turma selecionada");
    }
  });

  it("never refreshes without a concrete cohort and its slug, nor with all", async () => {
    const w = worker();
    for (const data of [{ type: "REFRESH_COHORT_CATALOG" }, { type: "REFRESH_COHORT_CATALOG", cohortId: "all", slug: "turma-2026", name: "Todas" },
      { type: "REFRESH_COHORT_CATALOG", cohortId: cohortA, name: "Turma 2026" }, { type: "REFRESH_COHORT_CATALOG", cohortId: cohortA, slug: "../2026", name: "Turma 2026" },
      { type: "REFRESH_PUBLIC_CATALOG", defaultCohort: true }]) {
      await w.lifecycle("message", { data, source: { url: "https://pdv.test/" } });
    }
    expect(w.fetcher).not.toHaveBeenCalled();
    expect(w.stores.size).toBe(0);
  });

  it("stores nothing when the Portal resolved another cohort, or none, for the slug", async () => {
    const w = worker();
    w.fetcher.mockResolvedValueOnce(catalog(cohortA, ["Camiseta 2026"]));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    w.fetcher.mockResolvedValueOnce(catalog(null, ["Camiseta 2026"]));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    expect(w.stores.has(catalogOf(cohortB))).toBe(false);
  });

  it("a cohort that stopped being public (404) loses its copy instead of falling back", async () => {
    const shared = device();
    const w = worker(shared);
    w.fetcher.mockResolvedValueOnce(catalog(cohortB, ["Moletom 2027"]));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    w.fetcher.mockResolvedValueOnce(Response.json({ code: "COHORT_NOT_FOUND" }, { status: 404 }));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    expect(shared.stores.has(catalogOf(cohortB))).toBe(false);
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortB}`)).products).toEqual([]);
  });

  it("logout or another person's sign-in clears every cohort's copy", async () => {
    const shared = device();
    const w = worker(shared);
    w.fetcher.mockResolvedValueOnce(catalog(cohortA, ["Camiseta 2026"])).mockResolvedValueOnce(catalog(cohortB, ["Moletom 2027"]));
    await w.lifecycle("message", refresh(cohortA, "turma-2026"));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    await w.shared.caches.open("germinatura-pdv-shell-v2");
    await w.lifecycle("message", clear);
    expect([...shared.stores.keys()]).toEqual(["germinatura-pdv-shell-v2"]);
    // The next person, even with a leftover cookie of the previous one, finds no copy.
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortA}`)).products).toEqual([]);
  });

  it("a handoff into another cohort: the previous copy is cleared and only the new cohort's is saved", async () => {
    const shared = device();
    const w = worker(shared);
    w.fetcher.mockResolvedValueOnce(catalog(cohortA, ["Camiseta 2026"]));
    await w.lifecycle("message", refresh(cohortA, "turma-2026"));
    // /acesso clears before opening the PDV; the PDV home then refreshes the cohort stored with the handoff code.
    await w.lifecycle("message", clear);
    w.fetcher.mockResolvedValueOnce(catalog(cohortB, ["Moletom 2027"]));
    await w.lifecycle("message", refresh(cohortB, "turma-2027"));
    expect([...shared.stores.keys()]).toEqual([catalogOf(cohortB)]);
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortB}`)).products).toEqual(["Moletom 2027"]);
    expect((await openOfflineScreen(shared, `germinatura_pdv_cohort=${cohortA}`)).products).toEqual([]);
  });

  it("rejects invalid cent values and foreign messages", async () => {
    const w = worker();
    await w.lifecycle("message", { ...refresh(cohortA, "turma-2026"), source: { url: "https://foreign.test/" } });
    await w.lifecycle("message", { ...clear, source: { url: "https://foreign.test/" } });
    expect(w.fetcher).not.toHaveBeenCalled();
    w.fetcher.mockResolvedValueOnce(Response.json({ data: [{ name: "Bad", sellablePdv: true, price: { amountCents: 1.5, currency: "BRL" } }] }, { headers: { "x-germinatura-cohort": cohortA } }));
    await w.lifecycle("message", refresh(cohortA, "turma-2026"));
    expect(w.stores.get(catalogOf(cohortA))?.has(SNAPSHOT) ?? false).toBe(false);
  });
});
