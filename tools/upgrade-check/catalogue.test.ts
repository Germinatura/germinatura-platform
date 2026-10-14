import { describe, expect, it } from "vitest";
import { catalogueProblems, expectedCatalogue } from "./catalogue.mjs";
import { compareSnapshots } from "./snapshot.mjs";

const cohortMigrations = ["cohort_foundation", "cohort_scope_columns", "cohort_scope_validation", "cohort_classification", "cohort_authorization",
  "cohort_isolation", "cohort_context_api", "cohort_consolidated", "cohort_explicit_context"];

type Table = { columns: string[]; current_columns: string[]; missing_columns: string[]; pk: string[]; rows: number; hash: string; tuples: string; row_hashes: string };
const table = (rows: number, rowHashes: string, overrides: Partial<Table> = {}): Table => ({
  columns: ["id", "key"], current_columns: ["id", "key"], missing_columns: [], pk: ["id"], rows, hash: rowHashes, tuples: rowHashes, row_hashes: rowHashes, ...overrides,
});
const snapshot = (tables: Record<string, Table>) => ({ tables, aggregates: {} });
const before = snapshot({ permissions: table(2, "a:1,b:2"), role_permissions: table(2, "x:1,y:2") });

describe("catalogue expected from the applied migrations", () => {
  it("the Phase 5 rollback (9 cohort migrations) expects only cohorts.manage, with no role grant", () => {
    const expected = expectedCatalogue(cohortMigrations);
    expect(expected.expectedNewRows).toEqual({ permissions: 1, role_permissions: 0 });
    expect(expected.permissions).toEqual({ "cohorts.manage": [] });
  });

  it("the full upgrade (cohorts + PR D) also expects sales.surcharge.waive granted to ADMIN only", () => {
    const expected = expectedCatalogue([...cohortMigrations, "profile_username_change", "payment_surcharges"]);
    expect(expected.expectedNewRows).toEqual({ permissions: 2, role_permissions: 1 });
    expect(expected.permissions).toEqual({ "cohorts.manage": [], "sales.surcharge.waive": ["ADMIN"] });
  });

  it("still catches real mutations: an extra permission, a missing grant, a rewritten row", () => {
    const { expectedNewRows } = expectedCatalogue(cohortMigrations);
    const exact = snapshot({ permissions: table(3, "a:1,b:2,c:3"), role_permissions: table(2, "x:1,y:2") });
    expect(compareSnapshots(before, exact, { expectedNewRows, requireSameTuples: true }).ok).toBe(true);
    // The failure the CI reported, reversed: PR D's rows expected where PR D was not applied.
    const prD = expectedCatalogue([...cohortMigrations, "payment_surcharges"]).expectedNewRows;
    expect(compareSnapshots(before, exact, { expectedNewRows: prD, requireSameTuples: true }).problems)
      .toEqual(expect.arrayContaining(["permissions: rows 2 → 3, expected +2", "role_permissions: rows 2 → 2, expected +1"]));
    const extra = snapshot({ permissions: table(4, "a:1,b:2,c:3,d:4"), role_permissions: table(2, "x:1,y:2") });
    expect(compareSnapshots(before, extra, { expectedNewRows, requireSameTuples: true }).problems).toContain("permissions: rows 2 → 4, expected +1");
    const granted = snapshot({ permissions: table(3, "a:1,b:2,c:3"), role_permissions: table(3, "x:1,y:2,z:3") });
    expect(compareSnapshots(before, granted, { expectedNewRows, requireSameTuples: true }).ok).toBe(false);
    const rewritten = snapshot({ permissions: table(3, "a:9,b:2,c:3"), role_permissions: table(2, "x:1,y:2") });
    expect(compareSnapshots(before, rewritten, { expectedNewRows, requireSameTuples: true }).ok).toBe(false);
  });

  it("checks the content: exactly once, granted to exactly the expected roles", () => {
    const expected = expectedCatalogue([...cohortMigrations, "payment_surcharges"]);
    const clean = { "cohorts.manage": { count: 1, roles: [] }, "sales.surcharge.waive": { count: 1, roles: ["ADMIN"] } };
    expect(catalogueProblems(expected, clean)).toEqual([]);
    expect(catalogueProblems(expected, { ...clean, "sales.surcharge.waive": { count: 1, roles: ["ADMIN", "VENDEDOR"] } }))
      .toEqual(["catálogo: sales.surcharge.waive concedida a [ADMIN, VENDEDOR], esperado [ADMIN]"]);
    expect(catalogueProblems(expected, { ...clean, "sales.surcharge.waive": { count: 1, roles: ["FINANCEIRO"] } })).toHaveLength(1);
    expect(catalogueProblems(expected, { ...clean, "sales.surcharge.waive": { count: 0, roles: [] } })).toHaveLength(2);
    expect(catalogueProblems(expected, { ...clean, "cohorts.manage": { count: 1, roles: ["ADMIN"] } })).toHaveLength(1);
  });
});
