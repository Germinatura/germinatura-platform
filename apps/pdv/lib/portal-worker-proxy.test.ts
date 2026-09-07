import { describe, expect, it, vi } from "vitest";
import { forwardPortalApi, isPortalApiPath } from "./portal-worker-proxy";

describe("PDV to Portal service binding", () => {
  it("keeps login/health local and forwards only API paths", () => {
    expect(isPortalApiPath("/api/auth/login")).toBe(false);
    expect(isPortalApiPath("/api/v1/health")).toBe(false);
    expect(isPortalApiPath("/offline")).toBe(false);
    expect(isPortalApiPath("/api/v1/catalog/products")).toBe(true);
  });
  it("preserves method, body, Origin, bearer and idempotency without accepting an arbitrary target", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://portal.test/api/v1/sales/checkout?limit=50");
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("origin")).toBe("https://pdv.test");
      expect(request.headers.get("authorization")).toBe("Bearer fictitious-test-token");
      expect(request.headers.get("idempotency-key")).toBe("test-once");
      expect(request.headers.has("x-middleware-rewrite")).toBe(false);
      expect(await request.text()).toBe('{"items":[]}');
      return Response.json({ code: "FORBIDDEN" }, { status: 403 });
    });
    const response = await forwardPortalApi(new Request("https://pdv.test/api/v1/sales/checkout?limit=50", { method: "POST", body: '{"items":[]}', headers: { Origin: "https://pdv.test", Authorization: "Bearer fictitious-test-token", "Idempotency-Key": "test-once", "x-middleware-rewrite": "https://untrusted.test" } }), { fetch: fetcher }, "https://portal.test");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not add credentials to the public catalog and preserves upstream errors", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      return Response.json({ code: "INVALID_QUERY" }, { status: 422 });
    });
    expect((await forwardPortalApi(new Request("https://pdv.test/api/v1/catalog/products"), { fetch: fetcher }, "https://portal.test")).status).toBe(422);
  });
  it("fails closed without the binding and never retries failed mutations", async () => {
    const request = new Request("https://pdv.test/api/v1/sales/checkout", { method: "POST" });
    expect((await forwardPortalApi(request, undefined, "https://portal.test")).status).toBe(503);
    const fetcher = vi.fn(async () => { throw new Error("unavailable"); });
    expect((await forwardPortalApi(request, { fetch: fetcher }, "https://portal.test")).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
