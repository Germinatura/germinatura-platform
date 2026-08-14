import type { AppRole, Permission } from "@germinatura/contracts";

export const rolePermissions: Readonly<Record<AppRole, readonly Permission[]>> = {
  ADMIN: [
    "portal.access",
    "admin.access",
    "catalog.read",
    "catalog.manage",
    "inventory.read",
    "inventory.manage",
    "sales.create",
    "sales.read.own",
    "sales.read.all",
    "reservations.manage.own",
    "reservations.manage.all",
    "raffles.buy",
    "raffles.sell",
    "raffles.manage",
    "users.manage",
    "finance.manage",
  ],
  VENDEDOR: [
    "portal.access",
    "catalog.read",
    "inventory.read",
    "sales.create",
    "sales.read.own",
    "reservations.manage.own",
    "raffles.buy",
    "raffles.sell",
  ],
  CONSUMER: [
    "portal.access",
    "catalog.read",
    "reservations.manage.own",
    "raffles.buy",
  ],
};

const rolePriority: Readonly<Record<AppRole, number>> = {
  ADMIN: 3,
  VENDEDOR: 2,
  CONSUMER: 1,
};

export function primaryRole(roles: readonly AppRole[]): AppRole {
  return [...roles].sort((left, right) => rolePriority[right] - rolePriority[left])[0] ?? "CONSUMER";
}

export function hasPermission(
  user: { roles: readonly AppRole[] },
  permission: Permission,
): boolean {
  return user.roles.some((role) => rolePermissions[role].includes(permission));
}
