import { describe, expect, it } from "vitest";
import { hasPermission, primaryRole } from "./index";

describe("RBAC", () => {
  it("selects the most privileged role", () => {
    expect(primaryRole(["CONSUMER", "ADMIN"])).toBe("ADMIN");
  });

  it("allows sellers to create sales but not manage users", () => {
    const seller = { roles: ["VENDEDOR"] as const };
    expect(hasPermission(seller, "sales.create")).toBe(true);
    expect(hasPermission(seller, "users.manage")).toBe(false);
  });
});
