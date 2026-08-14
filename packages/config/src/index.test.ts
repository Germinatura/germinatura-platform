import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./index";

describe("environment configuration", () => {
  it("keeps payments disabled by default", () => {
    const env = parseServerEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anon-key",
      NEXT_PUBLIC_PORTAL_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_PDV_URL: "http://127.0.0.1:3001",
    });
    expect(env.PAYMENTS_ENABLED).toBe("false");
  });
});
