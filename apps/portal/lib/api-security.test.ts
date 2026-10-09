import { describe, expect, it } from "vitest";
import { apiAccessRule, apiAccessRules, rolesSatisfyAccess, writeNeedsCohort } from "./api-security";

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
    expect(apiAccessRule("/api/v1/admin/finance/shifts")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/terminals")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/sales")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/entries")?.methods).toEqual(["GET", "POST"]);
    expect(apiAccessRule("/api/v1/admin/finance/statement")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/reservations")?.access).toBe("admin");
    expect(apiAccessRule("/api/v1/admin/announcements")?.access).toBe("communications");
    expect(apiAccessRule("/api/v1/admin/share-campaigns")?.access).toBe("communications");
    expect(apiAccessRule("/api/v1/sales/33f00000-0000-4000-8000-000000000001/payments/payment-link")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/payments/payment-links/33f00000-0000-4000-8000-000000000001")?.access).toBe("authenticated");
    expect(apiAccessRule("/api/v1/payments/payment-links/33f00000-0000-4000-8000-000000000001")?.methods).toEqual(["GET"]);
    expect(apiAccessRule("/api/v1/admin/finance/online-payments")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/online-payments/recovery/33f00000-0000-4000-8000-000000000001/resolve")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/online-payments/refunds/33f00000-0000-4000-8000-000000000001/reconcile")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/online-payments/refunds/x/y/reconcile")).toBeUndefined();
    expect(apiAccessRule("/api/v1/notifications/preferences")?.methods).toEqual(["GET", "PUT"]);
    expect(apiAccessRule("/api/v1/catalog/products/33f00000-0000-4000-8000-000000000001/stock-alert")?.access).toBe("authenticated");
    expect(rolesSatisfyAccess(["COMUNICACAO"], "communications")).toBe(true);
    expect(rolesSatisfyAccess(["VENDEDOR"], "communications")).toBe(false);
    expect(apiAccessRule("/api/v1/admin/reservations/settings")?.methods).toEqual(["GET", "PUT"]);
    expect(apiAccessRule("/api/v1/admin/reservations/73000000-0000-4000-8000-000000000001/ready")?.access).toBe("admin");
    expect(apiAccessRule("/api/v1/admin/finance/entries/6c000000-0000-4000-8000-000000000001/reverse")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/sales/6b000000-0000-4000-8000-000000000001")?.methods).toEqual(["GET"]);
    expect(apiAccessRule("/api/v1/admin/finance/terminals/6a000000-0000-4000-8000-000000000001")?.methods).toEqual(["PATCH"]);
    expect(apiAccessRule("/api/v1/admin/finance/payables/63000000-0000-4000-8000-000000000001/settlements")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/payables/settlements/63000000-0000-4000-8000-000000000001/reverse")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/balances")?.methods).toEqual(["GET"]);
    expect(apiAccessRule("/api/v1/admin/finance/opening-position")?.methods).toEqual(["GET", "POST"]);
    expect(apiAccessRule("/api/v1/admin/finance/balance-checks")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/statement-imports/63000000-0000-4000-8000-000000000001/bulk")?.methods).toEqual(["POST"]);
    expect(apiAccessRule("/api/v1/admin/finance/statement-imports/63000000-0000-4000-8000-000000000001/bulk/preview")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/statement-lines/63000000-0000-4000-8000-000000000001/link")?.methods).toEqual(["POST"]);
    expect(apiAccessRule("/api/v1/admin/finance/statement-lines/63000000-0000-4000-8000-000000000001/link-candidates")?.methods).toEqual(["GET"]);
    expect(apiAccessRule("/api/v1/admin/finance/picpay/files")?.methods).toEqual(["GET", "POST"]);
    expect(apiAccessRule("/api/v1/admin/finance/picpay/files/preview")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/picpay/exceptions/resolve")?.methods).toEqual(["POST"]);
    expect(apiAccessRule("/api/v1/admin/finance/picpay/transactions/63000000-0000-4000-8000-000000000001/link")?.access).toBe("finance");
    expect(apiAccessRule("/api/v1/admin/finance/picpay/periods")?.methods).toEqual(["GET", "POST"]);
    expect(rolesSatisfyAccess(["ADMIN"], "finance")).toBe(true);
    expect(rolesSatisfyAccess(["FINANCEIRO"], "finance")).toBe(true);
    expect(rolesSatisfyAccess(["ESTOQUE"], "finance")).toBe(false);
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "finance")).toBe(false);
  });
});

describe("cash and shift API access", () => {
  it("allows only sellers to operate shifts and cash payments", () => {
    expect(apiAccessRule("/api/v1/pdv/shifts")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/pdv/sales")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/pdv/terminals")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/pdv/pickups")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/pdv/pickups/74000000-0000-4000-8000-000000000001/complete")?.methods).toEqual(["POST"]);
    expect(apiAccessRule("/api/v1/pdv/shifts/67000000-0000-4000-8000-000000000001/close")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/sales/67000000-0000-4000-8000-000000000001/payments/cash")?.access).toBe("seller");
    expect(apiAccessRule("/api/v1/pdv/shifts/not-a-uuid!/close")).toBeUndefined();
    expect(rolesSatisfyAccess(["CONSUMIDOR"], "seller")).toBe(false);
  });
});

describe("cohort context of API writes (ADR 0011)", () => {
  it("ADMIN_MASTER satisfies every level; cohort administration is ADMIN_MASTER only", () => {
    for (const level of ["admin", "finance", "inventory", "stock", "communications", "seller", "master"] as const) {
      expect(rolesSatisfyAccess(["ADMIN_MASTER"], level)).toBe(true);
    }
    expect(rolesSatisfyAccess(["ADMIN"], "master")).toBe(false);
    expect(apiAccessRule("/api/v1/admin/cohorts")?.access).toBe("master");
    expect(apiAccessRule("/api/v1/admin/cohorts/c0000000-0000-4000-8000-000000002026")?.access).toBe("master");
    expect(apiAccessRule("/api/v1/admin/users/10000000-0000-4000-8000-000000000001/admin-master")?.access).toBe("master");
  });

  it("every write needs a concrete cohort except the documented global operations", () => {
    const global = apiAccessRules.filter((rule) => rule.cohort === "global").map((rule) => rule.path).sort();
    expect(global).toEqual([
      "/api/auth/logout", "/api/auth/reset-password", "/api/v1/account/sessions", "/api/v1/account/sessions/:id",
      "/api/v1/admin/bootstrap", "/api/v1/admin/cohorts", "/api/v1/admin/cohorts/:id", "/api/v1/admin/users/:id/admin-master",
      "/api/v1/notifications/:id/read", "/api/v1/notifications/preferences", "/api/v1/profile", "/api/v1/session/cohort",
    ]);
    expect(writeNeedsCohort(apiAccessRule("/api/v1/sales/checkout"), "POST")).toBe(true);
    expect(writeNeedsCohort(apiAccessRule("/api/v1/admin/users"), "POST")).toBe(true);
    expect(writeNeedsCohort(apiAccessRule("/api/v1/admin/users"), "GET")).toBe(false);
    expect(writeNeedsCohort(undefined, "POST")).toBe(true);
    expect(writeNeedsCohort(apiAccessRule("/api/v1/admin/cohorts"), "POST")).toBe(false);
  });
});
