import { createApiError, financeOverviewSchema, type FinanceOverview } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { AuthorizationError } from "@/lib/auth";

// PR E: historical adjustments, cutover counterparts and the financial overview.

/** snake_case keys from the database → camelCase. Enum-valued keys (CMV, PURCHASE_RECEIPT…) are kept as they are. */
export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    /^[a-z0-9_]+$/.test(key) ? key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase()) : key,
    camelize(item),
  ]));
}

export function toFinanceOverview(data: unknown): FinanceOverview {
  const value = camelize(data) as Record<string, unknown> & { result?: Record<string, unknown> & { totals?: Record<string, unknown> } };
  const result = value.result ?? {};
  const totals = result.totals ?? {};
  return financeOverviewSchema.parse({
    period: value.period,
    position: value.position,
    payables: value.payables,
    result: {
      officialCents: totals.operatingProfitCents,
      registeredCents: totals.registeredOperatingProfitCents,
      historicalAdjustmentsCents: totals.historicalAdjustmentsCents,
      historicalCents: result.historicalCents ?? null,
      nativeCents: result.nativeCents ?? null,
      historicalAdjustments: result.historicalAdjustments ?? {},
      presentation: result.presentation,
      costVisibility: result.costVisibility,
    },
    counterparts: value.counterparts,
    bridge: value.bridge,
  });
}

export function financeHistoryErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}

const conflicts: Record<string, string> = {
  HISTORICAL_ADJUSTMENT_NOT_HISTORICAL: "A competência precisa ser anterior ao início da operação no Germinatura.",
  HISTORICAL_ADJUSTMENT_MOVEMENT_ALREADY_COVERED: "Um dos movimentos de estoque já é reconhecido por outro ajuste ativo.",
  HISTORICAL_ADJUSTMENT_ABOVE_REFERENCED_COST: "O valor passa do custo conhecido dos movimentos indicados.",
  HISTORICAL_ADJUSTMENT_BEFORE_MOVEMENT: "A competência não pode ser anterior à baixa do estoque.",
  HISTORICAL_ADJUSTMENT_MOVEMENT_NOT_ELIGIBLE: "Escolha apenas baixas por ajuste negativo desta turma.",
  HISTORICAL_ADJUSTMENT_NOT_REVERSIBLE: "Este ajuste já foi revertido ou é uma reversão.",
  OPENING_POSITION_REQUIRED: "Registre a posição de abertura antes.",
  CUTOVER_COUNTERPART_NOT_ELIGIBLE: "A contrapartida precisa ser uma receita manual desta turma, não estornada.",
  CUTOVER_COUNTERPART_NOT_HISTORICAL: "A contrapartida precisa ser anterior ao início da operação.",
  CUTOVER_COUNTERPART_ALREADY_DESIGNATED: "Esta contrapartida já está designada.",
  CUTOVER_COUNTERPART_AMOUNT_MISMATCH: "A contrapartida é usada inteira: o valor neutralizado é o valor dela.",
  CUTOVER_TARGET_NOT_IN_COHORT: "A despesa precisa ser desta turma (uma linha do extrato só depois de atribuída a ela).",
  CUTOVER_TARGET_NOT_EXPENSE: "Escolha uma despesa operacional: linha classificada como despesa ou lançamento de despesa.",
  CUTOVER_TARGET_NOT_HISTORICAL: "A despesa precisa ser anterior ao início da operação.",
  CUTOVER_TARGET_EXCEEDED: "A despesa não comporta esse valor além do que já está neutralizado.",
  CUTOVER_COUNTERPART_ALREADY_REVOKED: "Esta designação já foi revogada.",
  IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
  IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
};

/** Maps database errors of the historical finance commands to API responses. */
export function financeHistoryDatabaseError(message: string, requestId: string) {
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return financeHistoryErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("HISTORICAL_ADJUSTMENT_NOT_FOUND") || message.includes("CUTOVER_COUNTERPART_NOT_FOUND")) {
    return financeHistoryErrorResponse("NOT_FOUND", "Registro não encontrado.", requestId, 404);
  }
  if (message.includes("FINANCE_MANAGE_REQUIRED")) return financeHistoryErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("COHORT_REQUIRED")) return financeHistoryErrorResponse("COHORT_REQUIRED", "Selecione uma turma.", requestId, 422);
  if (message.includes("HISTORICAL_ADJUSTMENT_MOVEMENTS_REQUIRED")) {
    return financeHistoryErrorResponse("HISTORICAL_ADJUSTMENT_MOVEMENTS_REQUIRED", "Um aumento de CMV ou perda indica as baixas de estoque que reconhece.", requestId, 422);
  }
  if (message.includes("INVALID_")) return financeHistoryErrorResponse("INVALID_REQUEST", "Confira os dados enviados.", requestId, 422);
  return financeHistoryErrorResponse("FINANCE_UNAVAILABLE", "Financeiro temporariamente indisponível.", requestId, 503);
}

export function financeHistoryFailure(error: unknown, requestId: string) {
  if (error instanceof AuthorizationError) return financeHistoryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
  return financeHistoryErrorResponse("FINANCE_UNAVAILABLE", "Financeiro temporariamente indisponível.", requestId, 503);
}
