import { cohortSummarySchema, createApiError, type CohortSummary } from "@germinatura/contracts";
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
];

export function cohortAdminFailure(error: unknown, requestId: string, fallback: string) {
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  if (error instanceof AuthorizationError) {
    return NextResponse.json(createApiError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId), { status: error.status, headers });
  }
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  const known = failures.find(([key]) => message.includes(key));
  if (known) return NextResponse.json(createApiError(known[1], known[2], requestId), { status: known[3], headers });
  return NextResponse.json(createApiError("COHORT_ADMIN_UNAVAILABLE", fallback, requestId), { status: 503, headers });
}
