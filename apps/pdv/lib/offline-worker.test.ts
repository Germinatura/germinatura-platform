import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

function worker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const fetcher = vi.fn(async () => new Response("shell"));
  const cacheApi = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return { put: async (key: string, value: Response) => { store.set(key, value); }, match: async (key: string) => store.get(key)?.clone() };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  runInNewContext(source, {
    self: { location: { origin: "https://pdv.test" }, addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: cacheApi, fetch: fetcher, URL, Response,
  });
  async function lifecycle(name: string, data = {}) {
    let pending: Promise<unknown> | undefined;
    listeners[name]({ ...data, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return { listeners, stores, fetcher, lifecycle };
}

describe("PDV offline cache boundary", () => {
  it("prepares only the explicit public shell with credentials omitted", async () => {
    const w = worker();
    await w.lifecycle("install");
    expect([...w.stores.values()][0].size).toBe(5);
    expect(w.fetcher).toHaveBeenCalledWith("/offline", { credentials: "omit", cache: "reload", redirect: "error" });
    expect([...w.stores.values()][0].has("/")).toBe(false);
  });

  it("does not intercept mutations, APIs or third-party assets", () => {
    const w = worker();
    for (const [url, method] of [["https://pdv.test/api/v1/sales/checkout", "POST"], ["https://pdv.test/api/v1/auth/session", "GET"], ["https://other.test/offline", "GET"], ["https://pdv.test/_next/static/chunk.js", "GET"]]) {
      const respondWith = vi.fn();
      w.listeners.fetch({ request: { url, method, mode: "cors" }, respondWith });
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
    expect([...w.stores.values()][0].has("/")).toBe(false);
  });

  it("projects only public fields and retains the previous snapshot on failure", async () => {
    const w = worker();
    w.fetcher.mockResolvedValueOnce(Response.json({ data: [{ name: "Produto", sellablePdv: true, price: { amountCents: 1250, currency: "BRL" }, balance: 10, user: "private" }], nextCursor: "more", request_id: "not-cached" }));
    const message = { data: { type: "REFRESH_PUBLIC_CATALOG" }, source: { url: "https://pdv.test/login" } };
    await w.lifecycle("message", message);
    const snapshot = w.stores.get("germinatura-pdv-catalog-v1")?.get("/offline/catalog-snapshot");
    expect(await snapshot?.clone().json()).toEqual({ savedAt: expect.any(Number), partial: true, products: [{ name: "Produto", amountCents: 1250 }] });
    expect(w.fetcher).toHaveBeenCalledWith("/api/v1/catalog/products?limit=50", { credentials: "omit", cache: "no-store", redirect: "error" });
    w.fetcher.mockRejectedValueOnce(new Error("offline"));
    await w.lifecycle("message", message);
    expect(w.stores.get("germinatura-pdv-catalog-v1")?.get("/offline/catalog-snapshot")).toBe(snapshot);
  });

  it("rejects invalid cent values and foreign refresh messages", async () => {
    const w = worker();
    await w.lifecycle("message", { data: { type: "REFRESH_PUBLIC_CATALOG" }, source: { url: "https://foreign.test/" } });
    expect(w.fetcher).not.toHaveBeenCalled();
    w.fetcher.mockResolvedValueOnce(Response.json({ data: [{ name: "Bad", sellablePdv: true, price: { amountCents: 1.5, currency: "BRL" } }] }));
    await w.lifecycle("message", { data: { type: "REFRESH_PUBLIC_CATALOG" }, source: { url: "https://pdv.test/" } });
    expect(w.stores.size).toBe(0);
  });
});
