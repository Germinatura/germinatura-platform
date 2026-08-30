import { describe, expect, it } from "vitest";
import { hasPermission, primaryRole } from "./index";

describe("RBAC", () => {
  it("selects the most privileged role", () => {
    expect(primaryRole(["CONSUMIDOR", "ADMIN"])).toBe("ADMIN");
  });

  it("supports the complete v2.1 role set", () => {
    expect(hasPermission({ roles: ["ESTOQUE"] }, "inventory.manage")).toBe(true);
    expect(hasPermission({ roles: ["FINANCEIRO"] }, "finance.manage")).toBe(true);
    expect(hasPermission({ roles: ["COMUNICACAO"] }, "communications.manage")).toBe(true);
    expect(hasPermission({ roles: ["MODERADOR"] }, "community.moderate")).toBe(true);
    expect(hasPermission({ roles: ["CONSUMIDOR"] }, "sales.read.own")).toBe(true);
    expect(hasPermission({ roles: ["CONSUMIDOR"] }, "admin.access")).toBe(false);
  });

  it("allows sellers to create sales but not manage users", () => {
    const seller = { roles: ["VENDEDOR"] as const };
    expect(hasPermission(seller, "sales.create")).toBe(true);
    expect(hasPermission(seller, "users.manage")).toBe(false);
  });
});
