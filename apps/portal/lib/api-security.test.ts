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
    expect(apiAccessRule("/api/v1/inventory/returns")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/inventory/returns/63000000-0000-4000-8000-000000000001")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/admin/inventory/returns")?.access).toBe("inventory");
    expect(apiAccessRule("/api/v1/admin/inventory/returns/63000000-0000-4000-8000-000000000001")?.access).toBe("inventory");
    expect(apiAccessRule("/api/v1/inventory/losses")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/inventory/losses/63000000-0000-4000-8000-000000000001")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/admin/inventory/losses")?.access).toBe("inventory");
    expect(apiAccessRule("/api/v1/admin/inventory/losses/63000000-0000-4000-8000-000000000001")?.access).toBe("inventory");
    expect(apiAccessRule("/api/v1/admin/inventory/loss-settings")?.access).toBe("inventory");
    expect(apiAccessRule("/api/v1/inventory/counts")?.access).toBe("stock");
    expect(apiAccessRule("/api/v1/inventory/counts/63000000-0000-4000-8000-000000000001")?.access).toBe("stock");
    expect(apiAccessRule("/api/v1/admin/inventory/counts/63000000-0000-4000-8000-000000000001")?.access).toBe("inventory");
    expect(rolesSatisfyAccess(["ESTOQUE"], "stock")).toBe(true);
    expect(rolesSatisfyAccess(["VENDEDOR"], "stock")).toBe(true);
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "stock")).toBe(false);
    expect(rolesSatisfyAccess(["VENDEDOR"], "seller")).toBe(true);
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "seller")).toBe(false);
  });
});

describe("procurement API access", () => {
  it("allows supplier management only to administrators and stock operators", () => {
    expect(apiAccessRule("/api/v1/admin/procurement/suppliers")?.access).toBe("procurement");
    expect(apiAccessRule("/api/v1/admin/procurement/orders")?.access).toBe("procurement");
    expect(apiAccessRule("/api/v1/admin/procurement/receipts")?.access).toBe("procurement");
    expect(apiAccessRule("/api/v1/admin/procurement/orders/63000000-0000-4000-8000-000000000001/cancel")?.access).toBe("procurement");
    expect(rolesSatisfyAccess(["ADMIN"], "procurement")).toBe(true);
    expect(rolesSatisfyAccess(["ESTOQUE"], "procurement")).toBe(true);
    expect(rolesSatisfyAccess(["FINANCEIRO"], "procurement")).toBe(false);
    expect(rolesSatisfyAccess(["VENDEDOR"], "procurement")).toBe(false);
  });
});

describe("purchase payable API access", () => {
  it("allows only finance operators and administrators", () => {
    expect(apiAccessRule("/api/v1/admin/finance/payables")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/payables/63000000-0000-4000-8000-000000000001/settlements")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/payables/settlements/63000000-0000-4000-8000-000000000001/reverse")?.access).toBe("finance");
    expect(rolesSatisfyAccess(["ADMIN"], "finance")).toBe(true);
    expect(rolesSatisfyAccess(["FINANCEIRO"], "finance")).toBe(true);
    expect(rolesSatisfyAccess(["ESTOQUE"], "finance")).toBe(false);
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "finance")).toBe(false);
  });
});
