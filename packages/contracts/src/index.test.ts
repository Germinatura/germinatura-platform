import { describe, expect, it } from "vitest";
import { apiErrorSchema, createApiClient, sessionUserSchema } from "./index";

describe("shared contracts", () => {
  it("rejects an invalid session identity", () => {
    expect(() => sessionUserSchema.parse({ id: "1" })).toThrow();
  });

  it("accepts the standard API error envelope", () => {
    expect(
      apiErrorSchema.parse({ code: "FORBIDDEN", message: "Acesso negado", request_id: "req-1" }),
    ).toMatchObject({ code: "FORBIDDEN" });
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
