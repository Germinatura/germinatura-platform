import { cohortOverviewSchema, cohortSummarySchema, createApiError, userCohortMembershipSchema, type CohortOverview, type CohortSummary, type UserCohortMembership } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";

/**
 * ADR 0011: cohort administration is ADMIN_MASTER only and global, so it is allowed in "Todas as turmas"
 * (api-security marks these routes `cohort: "global"`). The database checks `cohorts.manage` again.
 */
export async function requireAdminMaster() {
  const user = await requireSession();
  if (!user.adminMaster) throw new AuthorizationError(403, "Somente ADMIN_MASTER");
  return user;
}

const storedCohortSchema = z.object({
  id: z.uuid(), name: z.string(), year: z.number().int(), slug: z.string(),
  status: z.enum(["PREPARING", "ACTIVE", "ARCHIVED"]), is_default: z.boolean(),
});

export function toCohortSummary(data: unknown): CohortSummary {
  const stored = storedCohortSchema.parse(data);
  return cohortSummarySchema.parse({ id: stored.id, name: stored.name, year: stored.year, slug: stored.slug, status: stored.status, isDefault: stored.is_default });
}

const storedOverviewSchema = z.array(storedCohortSchema.extend({
  members_active: z.number().int(), members_inactive: z.number().int(), roles: z.record(z.string(), z.number().int()),
  open_operations: z.array(z.string()),
}));

export function toCohortOverview(data: unknown): CohortOverview[] {
  return storedOverviewSchema.parse(data).map((row) => cohortOverviewSchema.parse({
    id: row.id, name: row.name, year: row.year, slug: row.slug, status: row.status, isDefault: row.is_default,
    membersActive: row.members_active, membersInactive: row.members_inactive, roles: row.roles, openOperations: row.open_operations,
  }));
}

const storedMembershipsSchema = z.array(z.object({
  cohort_id: z.uuid(), name: z.string(), year: z.number().int(), status: z.enum(["PREPARING", "ACTIVE", "ARCHIVED"]), is_default: z.boolean(),
  membership: z.enum(["ACTIVE", "INACTIVE", "NONE"]), roles: z.array(z.string()), blockers: z.array(z.string()),
}));

export function toUserCohortMemberships(data: unknown): UserCohortMembership[] {
  return storedMembershipsSchema.parse(data).map((row) => userCohortMembershipSchema.parse({
    cohortId: row.cohort_id, name: row.name, year: row.year, status: row.status, isDefault: row.is_default,
    membership: row.membership, roles: row.roles, blockers: row.blockers,
  }));
}

/** Labels of the open work that blocks deactivating a membership or archiving a cohort (from the database details). */
export const openOperationLabels: Record<string, string> = {
  OPEN_SHIFT: "turno de caixa aberto", OPEN_SHIFTS: "turnos de caixa abertos", SELLER_STOCK: "estoque no local do vendedor",
  PENDING_STOCK_REQUESTS: "transferências ou devoluções pendentes", PENDING_SALES: "vendas aguardando pagamento",
  LAST_COHORT_ADMIN: "é o último ADMIN ativo da turma", PENDING_PAYMENTS: "pagamentos em andamento",
  OPEN_PAYMENT_LINKS: "links de pagamento ativos", OPEN_RESERVATIONS: "reservas em aberto",
  ACTIVE_STOCK_RESERVATIONS: "estoque reservado", PENDING_APPROVALS: "contagens ou perdas aguardando aprovação",
  OPEN_RAFFLES: "rifas ativas ou pausadas",
};

export function describeOpenOperations(detail: string | null | undefined): string {
  return (detail ?? "").split(",").filter(Boolean).map((code) => openOperationLabels[code] ?? code).join("; ");
}

const failures: [string, string, string, number][] = [
  ["COHORTS_MANAGE_REQUIRED", "FORBIDDEN", "Somente ADMIN_MASTER", 403],
  ["ADMIN_MASTER_REQUIRED", "FORBIDDEN", "Somente ADMIN_MASTER", 403],
  ["COHORT_ALREADY_EXISTS", "COHORT_ALREADY_EXISTS", "Já existe uma turma com esse ano ou identificador.", 409],
  ["IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_IN_PROGRESS", "A operação ainda está em andamento.", 409],
  ["COHORT_NOT_FOUND", "COHORT_NOT_FOUND", "Turma não encontrada.", 404],
  ["DEFAULT_COHORT_CANNOT_BE_ARCHIVED", "DEFAULT_COHORT_CANNOT_BE_ARCHIVED", "A turma padrão não pode ser arquivada.", 409],
  ["LAST_ADMIN_MASTER_REQUIRED", "LAST_ADMIN_MASTER_REQUIRED", "É preciso manter ao menos um ADMIN_MASTER ativo.", 409],
  ["ADMIN_MASTER_REQUIRES_ACTIVE_IDENTITY", "ADMIN_MASTER_REQUIRES_ACTIVE_IDENTITY", "Só uma conta ativa e com cadastro completo pode ser ADMIN_MASTER.", 409],
  ["INVALID_COHORT", "INVALID_COHORT", "Revise os dados da turma.", 422],
  ["INVALID_ADMIN_MASTER_CHANGE", "INVALID_ADMIN_MASTER_CHANGE", "Revise a alteração.", 422],
  ["USER_NOT_FOUND", "USER_NOT_FOUND", "Pessoa não encontrada nesta turma.", 404],
  ["INVALID_MEMBERSHIP", "INVALID_MEMBERSHIP", "Revise a alteração do vínculo.", 422],
  ["COHORT_ARCHIVED", "COHORT_ARCHIVED", "A turma está arquivada: vínculos e papéis não mudam mais.", 409],
  ["COHORT_REQUIRED", "COHORT_REQUIRED", "Selecione uma turma.", 409],
  ["FORBIDDEN", "FORBIDDEN", "Permissão insuficiente", 403],
];

export function cohortAdminFailure(error: unknown, requestId: string, fallback: string) {
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  if (error instanceof AuthorizationError) {
    return NextResponse.json(createApiError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId), { status: error.status, headers });
  }
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  if (message === "COHORT_HAS_OPEN_OPERATIONS" || message === "MEMBERSHIP_HAS_OPEN_OPERATIONS") {
    const detail = error && typeof error === "object" && "details" in error ? String(error.details ?? "") : "";
    const what = message.includes("COHORT_HAS") ? "A turma ainda tem operações em aberto" : "A pessoa ainda tem operações em aberto nesta turma";
    return NextResponse.json(createApiError(message.includes("COHORT_HAS") ? "COHORT_HAS_OPEN_OPERATIONS" : "MEMBERSHIP_HAS_OPEN_OPERATIONS",
      `${what}: ${describeOpenOperations(detail)}.`, requestId, detail.split(",").filter(Boolean)), { status: 409, headers });
  }
  // The database answers with the bare code as the message; codes overlap as substrings, so compare exactly.
  const known = failures.find(([key]) => message === key);
  if (known) return NextResponse.json(createApiError(known[1], known[2], requestId), { status: known[3], headers });
  return NextResponse.json(createApiError("COHORT_ADMIN_UNAVAILABLE", fallback, requestId), { status: 503, headers });
}
