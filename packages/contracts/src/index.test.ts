import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  catalogProductFlagsSchema,
  catalogSlugSchema,
  createApiClient,
  idempotencyKeySchema,
  idempotencyStatusSchema,
  moneyCentsSchema,
  productSkuSchema,
  sessionUserSchema,
} from "./index";

describe("shared contracts", () => {
  it("rejects an invalid session identity", () => {
    expect(() => sessionUserSchema.parse({ id: "1" })).toThrow();
  });

  it("accepts the standard API error envelope", () => {
    expect(
      apiErrorSchema.parse({ code: "FORBIDDEN", message: "Acesso negado", request_id: "req-1" }),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("validates money as safe non-negative integer cents", () => {
    expect(moneyCentsSchema.parse(1290)).toBe(1290);

    for (const invalid of [-1, 12.9, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(moneyCentsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates portable idempotency keys and persisted statuses", () => {
    expect(idempotencyKeySchema.parse("checkout:550e8400-e29b-41d4-a716-446655440000")).toContain("checkout:");
    expect(idempotencyStatusSchema.parse("SUCCEEDED")).toBe("SUCCEEDED");

    for (const invalid of ["", "contains whitespace", "a".repeat(129)]) {
      expect(idempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates canonical catalog identifiers", () => {
    expect(catalogSlugSchema.parse("camiseta-turma-2026")).toBe("camiseta-turma-2026");
    expect(productSkuSchema.parse("CAMISETA-2026_P")).toBe("CAMISETA-2026_P");

    for (const invalid of [" Camiseta", "camiseta_azul", "camiseta--azul", "Camiseta"]) {
      expect(catalogSlugSchema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of ["sku minusculo", "SKU COM ESPACO", "-SKU", "SKU-"]) {
      expect(productSkuSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires every catalog behavior flag", () => {
    expect(catalogProductFlagsSchema.parse({
      active: true,
      published: false,
      sellablePdv: true,
      reservable: true,
      tracksLots: false,
    })).toMatchObject({ active: true, published: false, sellablePdv: true });
  });

  it("sends a Supabase bearer token through the shared API client", async () => {
    let receivedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      receivedInit = init;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const apiFetch = createApiClient({
      getAccessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    });

    await apiFetch("https://portal.test/api/v1/auth/session");

    expect(new Headers(receivedInit?.headers).get("Authorization")).toBe("Bearer access-token");
    expect(receivedInit?.credentials).toBe("include");
  });
});
