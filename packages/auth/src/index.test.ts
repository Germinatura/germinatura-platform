import { describe, expect, it } from "vitest";
import { hasPermission, primaryRole } from "./index";

describe("RBAC", () => {
  it("selects the most privileged role", () => {
    expect(primaryRole(["CONSUMIDOR", "ADMIN"])).toBe("ADMIN");
  });

  it("supports the complete v2.1 role set", () => {
    expect(hasPermission({ roles: ["ESTOQUE"] }, "inventory.manage")).toBe(true);
    expect(hasPermission({ roles: ["VENDEDOR"] }, "inventory.transfer.own")).toBe(true);
    expect(hasPermission({ roles: ["ADMIN"] }, "inventory.transfer.own")).toBe(true);
    expect(hasPermission({ roles: ["ESTOQUE"] }, "inventory.transfer.own")).toBe(false);
    expect(hasPermission({ roles: ["VENDEDOR"] }, "inventory.return.own")).toBe(true);
    expect(hasPermission({ roles: ["ADMIN"] }, "inventory.return.own")).toBe(true);
    expect(hasPermission({ roles: ["VENDEDOR"] }, "inventory.loss.own")).toBe(true);
    expect(hasPermission({ roles: ["ADMIN"] }, "inventory.loss.own")).toBe(true);
    expect(hasPermission({ roles: ["VENDEDOR"] }, "inventory.count.own")).toBe(true);
    expect(hasPermission({ roles: ["ESTOQUE"] }, "inventory.count.own")).toBe(true);
    expect(hasPermission({ roles: ["ADMIN"] }, "procurement.manage")).toBe(true);
    expect(hasPermission({ roles: ["ESTOQUE"] }, "procurement.manage")).toBe(true);
    expect(hasPermission({ roles: ["VENDEDOR"] }, "procurement.manage")).toBe(false);
    expect(hasPermission({ roles: ["FINANCEIRO"] }, "finance.manage")).toBe(true);
    expect(hasPermission({ roles: ["FINANCEIRO"] }, "closeouts.manage")).toBe(true);
    expect(hasPermission({ roles: ["COMUNICACAO"] }, "communications.manage")).toBe(true);
    expect(hasPermission({ roles: ["MODERADOR"] }, "community.moderate")).toBe(true);
    expect(hasPermission({ roles: ["CONSUMIDOR"] }, "sales.read.own")).toBe(true);
    expect(hasPermission({ roles: ["CONSUMIDOR"] }, "admin.access")).toBe(false);
  });

  it("allows sellers to create sales but not manage users", () => {
    const seller = { roles: ["VENDEDOR"] as const };
    expect(hasPermission(seller, "sales.create")).toBe(true);
    expect(hasPermission(seller, "closeouts.create")).toBe(true);
    expect(hasPermission(seller, "closeouts.manage")).toBe(false);
    expect(hasPermission(seller, "users.manage")).toBe(false);
  });

  it("fails closed for unknown roles without dropping known ones", () => {
    expect(hasPermission({ roles: ["ADMIN", "UNKNOWN_ROLE"] }, "users.manage")).toBe(true);
    expect(hasPermission({ roles: ["UNKNOWN_ROLE"] }, "catalog.read")).toBe(false);
    expect(primaryRole(["UNKNOWN_ROLE"])).toBe("CONSUMIDOR");
    expect(primaryRole(["UNKNOWN_ROLE", "VENDEDOR"])).toBe("VENDEDOR");
  });

  it("ignores prototype keys and non-string role values", () => {
    for (const role of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(hasPermission({ roles: [role] }, "catalog.read")).toBe(false);
      expect(primaryRole([role])).toBe("CONSUMIDOR");
    }
    expect(hasPermission({ roles: [null, 1, {}, ["ADMIN"]] }, "admin.access")).toBe(false);
  });

  it("handles missing or malformed role payloads safely", () => {
    expect(primaryRole(undefined)).toBe("CONSUMIDOR");
    expect(primaryRole(null)).toBe("CONSUMIDOR");
    expect(primaryRole([])).toBe("CONSUMIDOR");
    expect(hasPermission({ roles: undefined }, "catalog.read")).toBe(false);
    expect(hasPermission({ roles: null }, "catalog.read")).toBe(false);
    expect(hasPermission({}, "catalog.read")).toBe(false);
    expect(hasPermission(null, "catalog.read")).toBe(false);
    expect(hasPermission({ roles: "ADMIN" as unknown as string[] }, "admin.access")).toBe(false);
  });
});
