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

  it("allows sellers to use only the transfer request routes", () => {
    expect(apiAccessRule("/api/v1/inventory/transfer-requests")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/inventory/transfer-requests/63000000-0000-4000-8000-000000000001")?.access).toBe("seller");
    expect(rolesSatisfyAccess(["VENDEDOR"], "seller")).toBe(true);
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "seller")).toBe(false);
  });
});
