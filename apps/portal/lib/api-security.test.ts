import { describe, expect, it } from "vitest";
import { apiAccessRule, rolesSatisfyAccess } from "./api-security";

describe("inventory API access", () => {
  it("allows inventory operators and administrators only", () => {
    expect(apiAccessRule("/api/v1/admin/inventory/distributions")?.access).toBe("inventory");
    expect(rolesSatisfyAccess(["ESTOQUE"], "inventory")).toBe(true);
    expect(rolesSatisfyAccess(["ADMIN"], "inventory")).toBe(true);
    expect(rolesSatisfyAccess(["VENDEDOR"], "inventory")).toBe(false);
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "inventory")).toBe(false);
  });
});
