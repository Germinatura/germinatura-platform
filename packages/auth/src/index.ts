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
    "communications.manage",
    "community.moderate",
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
  ESTOQUE: [
    "portal.access",
    "catalog.read",
    "inventory.read",
    "inventory.manage",
  ],
  FINANCEIRO: [
    "portal.access",
    "sales.read.all",
    "finance.manage",
  ],
  COMUNICACAO: [
    "portal.access",
    "communications.manage",
  ],
  MODERADOR: [
    "portal.access",
    "community.moderate",
  ],
  CONSUMIDOR: [
    "portal.access",
    "catalog.read",
    "reservations.manage.own",
    "raffles.buy",
  ],
};

const rolePriority: Readonly<Record<AppRole, number>> = {
  ADMIN: 7,
  VENDEDOR: 6,
  ESTOQUE: 5,
  FINANCEIRO: 4,
  COMUNICACAO: 3,
  MODERADOR: 2,
  CONSUMIDOR: 1,
};

export function primaryRole(roles: readonly AppRole[]): AppRole {
  return [...roles].sort((left, right) => rolePriority[right] - rolePriority[left])[0] ?? "CONSUMIDOR";
}

export function hasPermission(
  user: { roles: readonly AppRole[] },
  permission: Permission,
): boolean {
  return user.roles.some((role) => rolePermissions[role].includes(permission));
}
