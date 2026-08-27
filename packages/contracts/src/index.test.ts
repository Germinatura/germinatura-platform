import { describe, expect, it } from "vitest";
import { apiErrorSchema, createApiClient, moneyCentsSchema, sessionUserSchema } from "./index";

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
