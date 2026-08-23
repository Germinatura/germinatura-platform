import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./index";

describe("environment configuration", () => {
  it("parses the local greenfield configuration", () => {
    const env = parseServerEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-publishable-key",
      NEXT_PUBLIC_PORTAL_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_PDV_URL: "http://127.0.0.1:3001",
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });
});
