import { describe, expect, it } from "vitest";
import { columnsOf, compareSnapshots, snapshotSql } from "./snapshot.mjs";

type Table = { columns: string[]; current_columns: string[]; missing_columns: string[]; pk: string[]; rows: number; hash: string; tuples: string; row_hashes: string };
const table = (overrides: Partial<Table> = {}): Table => ({
  columns: ["id", "total"], current_columns: ["id", "total"], missing_columns: [], pk: ["id"], rows: 2, hash: "h", tuples: "t",
  row_hashes: "a:1,b:2", ...overrides,
});
const snapshot = (tables: Record<string, Table>, aggregates: Record<string, string> = { sales: "2/300" }) => ({ tables, aggregates });

describe("compareSnapshots", () => {
  it("accepts the expected new column and identical pre-existing content", () => {
    const before = snapshot({ sales: table() });
    const after = snapshot({ sales: table({ current_columns: ["id", "total", "cohort_id"] }), cohorts: table({ rows: 1 }) });
    const result = compareSnapshots(before, after, { expectedNewColumns: { sales: ["cohort_id"] }, requireSameTuples: true });
    expect(result.ok).toBe(true);
    expect(result.newTables).toEqual(["cohorts"]);
  });

  it("refuses a column added where it was not expected", () => {
    const before = snapshot({ suppliers: table() });
    const after = snapshot({ suppliers: table({ current_columns: ["id", "total", "cohort_id"] }) });
    expect(compareSnapshots(before, after).problems).toContain("suppliers: unexpected new columns (cohort_id)");
  });

  it("refuses an expected column that was not added", () => {
    const result = compareSnapshots(snapshot({ sales: table() }), snapshot({ sales: table() }), { expectedNewColumns: { sales: ["cohort_id"] } });
    expect(result.problems).toContain("sales: expected new columns missing (cohort_id)");
  });

  it("detects lost rows, changed values, lost columns, rewritten tuples and changed totals", () => {
    const before = snapshot({ sales: table(), items: table(), lines: table(), moves: table() });
    const after = snapshot({
      sales: table({ rows: 1 }),
      items: table({ hash: "other" }),
      lines: table({ missing_columns: ["total"] }),
      moves: table({ tuples: "rewritten" }),
    }, { sales: "2/301" });
    const { problems, ok } = compareSnapshots(before, after, { requireSameTuples: true });
    expect(ok).toBe(false);
    expect(problems).toEqual(expect.arrayContaining([
      "sales: rows 2 → 1",
      "items: content of pre-existing columns changed",
      "lines: columns disappeared (total)",
      "moves: pre-existing tuples were rewritten",
      "aggregate sales changed",
    ]));
  });

  it("refuses a table that disappeared", () => {
    expect(compareSnapshots(snapshot({ sales: table() }), snapshot({})).problems).toEqual(["sales: table disappeared"]);
  });

  it("in live mode accepts rows added by traffic but not changed or missing ones", () => {
    const before = snapshot({ sales: table() });
    expect(compareSnapshots(before, snapshot({ sales: table({ rows: 3, hash: "x", row_hashes: "a:1,b:2,c:3" }) }, { sales: "3/400" }), { allowNewRows: true }).ok).toBe(true);
    const changed = compareSnapshots(before, snapshot({ sales: table({ rows: 2, row_hashes: "a:1,b:9" }) }), { allowNewRows: true });
    expect(changed.problems).toContain("sales: 1 pre-existing rows changed");
    const missing = compareSnapshots(before, snapshot({ sales: table({ rows: 2, row_hashes: "a:1,c:3" }) }), { allowNewRows: true });
    expect(missing.problems).toContain("sales: 1 pre-existing rows missing");
  });
});

describe("snapshotSql", () => {
  it("is a single read-only SELECT", () => {
    const sql = snapshotSql({ perRow: true }).toLowerCase();
    expect(sql.trimStart().startsWith("with params as")).toBe(true);
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/);
  });

  it("restricts hashes to the columns of the earlier snapshot", () => {
    const columns = columnsOf(snapshot({ sales: table() }));
    expect(columns).toEqual({ sales: ["id", "total"] });
    expect(snapshotSql({ columns })).toContain('$cols${"sales":["id","total"]}$cols$');
  });
});

describe("compareSnapshots with expected catalogue rows", () => {
  it("accepts the expected new rows when every earlier row is unchanged", () => {
    const before = snapshot({ permissions: table() });
    const after = snapshot({ permissions: table({ rows: 3, hash: "other", row_hashes: "a:1,b:2,c:3" }) });
    expect(compareSnapshots(before, after, { expectedNewRows: { permissions: 1 } }).ok).toBe(true);
  });

  it("refuses a different number of new rows or a changed earlier row", () => {
    const before = snapshot({ permissions: table() });
    const twoMore = snapshot({ permissions: table({ rows: 4, row_hashes: "a:1,b:2,c:3,d:4" }) });
    expect(compareSnapshots(before, twoMore, { expectedNewRows: { permissions: 1 } }).problems).toContain("permissions: rows 2 → 4, expected +1");
    const changed = snapshot({ permissions: table({ rows: 3, row_hashes: "a:1,b:9,c:3" }) });
    expect(compareSnapshots(before, changed, { expectedNewRows: { permissions: 1 } }).problems).toContain("permissions: 1 pre-existing rows changed");
  });
});
