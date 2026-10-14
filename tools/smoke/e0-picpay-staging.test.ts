import { describe, expect, it } from "vitest";
import { e0Target, EXPECTED_STAGING_REF, PRODUCTION_REF } from "./e0-picpay-staging.mjs";

const staging = {
  LOAD_TARGET: "staging",
  LOAD_PORTAL_URL: "https://germinatura-portal-staging.germinatura.workers.dev",
  LOAD_PDV_URL: "https://germinatura-pdv-staging.germinatura.workers.dev",
  LOAD_SUPABASE_PROJECT_ID: EXPECTED_STAGING_REF,
  LOAD_SUPABASE_URL: `https://${EXPECTED_STAGING_REF}.supabase.co`,
  LOAD_SUPABASE_ACCESS_TOKEN: "token-de-teste",
};

// The E0 smoke activates PicPay isolation for good: it must only ever reach the staging project and Workers.
describe("E0 staging smoke guard", () => {
  it("accepts exactly the staging project and Workers", () => {
    expect(e0Target(staging)).toMatchObject({ projectRef: EXPECTED_STAGING_REF, portal: staging.LOAD_PORTAL_URL });
  });

  it("refuses the production project, wherever it appears", () => {
    expect(() => e0Target({ ...staging, LOAD_SUPABASE_PROJECT_ID: PRODUCTION_REF, LOAD_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }))
      .toThrow(/produção/);
    expect(() => e0Target({ ...staging, LOAD_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` })).toThrow(/produção/);
    expect(() => e0Target({ ...staging, LOAD_PORTAL_URL: `https://${PRODUCTION_REF}.example.com` })).toThrow(/produção/);
  });

  it("refuses any other project, even a well-formed one", () => {
    const other = "abcdefghijklmnopqrst";
    expect(() => e0Target({ ...staging, LOAD_SUPABASE_PROJECT_ID: other, LOAD_SUPABASE_URL: `https://${other}.supabase.co` })).toThrow(/Projeto recusado/);
    expect(() => e0Target({ ...staging, LOAD_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" })).toThrow();
  });

  it("refuses hosts other than the staging Workers", () => {
    expect(() => e0Target({ ...staging, LOAD_PORTAL_URL: "https://germinatura-portal.germinatura.workers.dev" })).toThrow(/recusado/);
    expect(() => e0Target({ ...staging, LOAD_PORTAL_URL: "http://127.0.0.1:3000" })).toThrow(/recusado/);
    expect(() => e0Target({ ...staging, LOAD_PDV_URL: "https://germinatura-pdv.example.com" })).toThrow(/recusado/);
  });

  it("needs the explicit staging target and the management credential", () => {
    expect(() => e0Target({ ...staging, LOAD_TARGET: "production" })).toThrow(/LOAD_TARGET=staging/);
    expect(() => e0Target({ ...staging, LOAD_SUPABASE_ACCESS_TOKEN: "" })).toThrow(/Credencial/);
  });
});
