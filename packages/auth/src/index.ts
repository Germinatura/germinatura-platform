import { permissionSchema, type Permission, type SessionRole } from "@germinatura/contracts";

export const rolePermissions: Readonly<Record<SessionRole, readonly Permission[]>> = {
  // ADR 0011: global capability, every permission in every cohort (it still acts inside one concrete cohort).
  ADMIN_MASTER: permissionSchema.options,
  ADMIN: [
    "portal.access",
    "admin.access",
    "catalog.read",
    "catalog.manage",
    "inventory.read",
    "inventory.manage",
    "inventory.transfer.own",
    "inventory.return.own",
    "inventory.loss.own",
    "inventory.count.own",
    "procurement.manage",
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
    "closeouts.create",
    "closeouts.manage",
    "communications.manage",
    "community.moderate",
    "audit.read",
  ],
  VENDEDOR: [
    "portal.access",
    "catalog.read",
    "inventory.read",
    "inventory.transfer.own",
    "inventory.return.own",
    "inventory.loss.own",
    "inventory.count.own",
    "sales.create",
    "sales.read.own",
    "reservations.manage.own",
    "raffles.buy",
    "raffles.sell",
    "closeouts.create",
  ],
  ESTOQUE: [
    "portal.access",
    "catalog.read",
    "inventory.read",
    "inventory.manage",
    "inventory.count.own",
    "procurement.manage",
  ],
  FINANCEIRO: [
    "portal.access",
    "sales.read.all",
    "finance.manage",
    "closeouts.manage",
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
    "sales.read.own",
    "reservations.manage.own",
    "raffles.buy",
  ],
};

const rolePriority: Readonly<Record<SessionRole, number>> = {
  ADMIN_MASTER: 8,
  ADMIN: 7,
  VENDEDOR: 6,
  ESTOQUE: 5,
  FINANCEIRO: 4,
  COMUNICACAO: 3,
  MODERADOR: 2,
  CONSUMIDOR: 1,
};

function isKnownRole(role: unknown): role is SessionRole {
  return typeof role === "string" && Object.hasOwn(rolePermissions, role);
}

function knownRoles(roles: unknown): SessionRole[] {
  return Array.isArray(roles) ? roles.filter(isKnownRole) : [];
}

/** Fail-closed: unknown, malformed or missing roles grant nothing. */
export function primaryRole(roles: readonly unknown[] | null | undefined): SessionRole {
  return knownRoles(roles).sort((left, right) => rolePriority[right] - rolePriority[left])[0] ?? "CONSUMIDOR";
}

/** Fail-closed: only known roles contribute permissions. */
export function hasPermission(
  user: { roles?: readonly unknown[] | null } | null | undefined,
  permission: Permission,
): boolean {
  return knownRoles(user?.roles).some((role) => rolePermissions[role].includes(permission));
}
