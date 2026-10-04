import { describe, expect, it } from "vitest";
import { STAGING_HOSTS, stagingTarget } from "./guard.mjs";

const ref = "abcdefghijklmnopqrst";
const base = {
  LOAD_TARGET: "staging",
  LOAD_SUPABASE_PROJECT_ID: ref,
  LOAD_SUPABASE_URL: `https://${ref}.supabase.co`,
  LOAD_SUPABASE_ACCESS_TOKEN: "token-presente",
};

describe("load harness target guard", () => {
  it("accepts only the staging Workers", () => {
    const target = stagingTarget(base);
    expect(target.portal).toBe(`https://${STAGING_HOSTS.portal}`);
    expect(target.pdv).toBe(`https://${STAGING_HOSTS.pdv}`);
  });

  it("refuses without the explicit staging target", () => {
    expect(() => stagingTarget({ ...base, LOAD_TARGET: "production" })).toThrow(/LOAD_TARGET/);
    expect(() => stagingTarget({ ...base, LOAD_TARGET: undefined })).toThrow(/LOAD_TARGET/);
  });

  it("refuses production, local and look-alike hosts", () => {
    for (const portal of [
      "https://germinatura-portal-production.germinatura.workers.dev",
      "https://germinatura.app",
      "http://germinatura-portal-staging.germinatura.workers.dev",
      "https://germinatura-portal-staging.germinatura.workers.dev.evil.test",
      "http://127.0.0.1:3000",
    ]) {
      expect(() => stagingTarget({ ...base, LOAD_PORTAL_URL: portal }), portal).toThrow(/recusado|Invalid URL/);
    }
  });

  it("refuses a database that is not the staging project", () => {
    expect(() => stagingTarget({ ...base, LOAD_SUPABASE_URL: "https://outroprojetoxxxxxxxxx.supabase.co" })).toThrow(/não corresponde/);
    expect(() => stagingTarget({ ...base, LOAD_PRODUCTION_SUPABASE_PROJECT_ID: ref })).toThrow(/produção/);
    expect(() => stagingTarget({ ...base, LOAD_SUPABASE_ACCESS_TOKEN: "" })).toThrow(/Credencial/);
  });
});
