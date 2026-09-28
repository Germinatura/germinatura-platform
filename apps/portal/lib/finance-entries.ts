import { createApiError, financeEntrySchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

// Rows returned by private.finance_manual_entry_json.
export const databaseFinanceEntrySchema = z.object({
  id: z.uuid(), kind: z.string(), category: z.string().nullable(), account: z.string(), counter_account: z.string().nullable(),
  amount_cents: z.number().int(), occurred_on: z.string(), description: z.string(), reference: z.string().nullable(),
  reversal_of: z.uuid().nullable(), reversed_by: z.uuid().nullable(), actor_name: z.string(), created_at: z.string(),
});

export function toFinanceEntry(value: z.infer<typeof databaseFinanceEntrySchema>) {
  return financeEntrySchema.parse({
    id: value.id, kind: value.kind, category: value.category, account: value.account, counterAccount: value.counter_account,
    amountCents: value.amount_cents, occurredOn: value.occurred_on, description: value.description, reference: value.reference,
    reversalOf: value.reversal_of, reversedBy: value.reversed_by, actorName: value.actor_name, createdAt: value.created_at,
  });
}

export function financeEntryErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Maps database errors of the manual entry commands to API responses. */
export function financeEntryDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    FINANCE_ENTRY_ALREADY_REVERSED: "Este lançamento já foi estornado.",
    FINANCE_ENTRY_NOT_REVERSIBLE: "Um estorno não pode ser estornado.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return financeEntryErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("FINANCE_ENTRY_NOT_FOUND")) return financeEntryErrorResponse("NOT_FOUND", "Lançamento não encontrado.", requestId, 404);
  if (message.includes("FINANCE_CATEGORY_AUTOMATIC_ONLY")) return financeEntryErrorResponse("FINANCE_CATEGORY_AUTOMATIC_ONLY", "Receita de vendas vem só das vendas registradas.", requestId, 422);
  if (message.includes("FINANCE_MANAGE_REQUIRED")) return financeEntryErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return financeEntryErrorResponse("INVALID_REQUEST", "Confira os dados do lançamento.", requestId, 422);
  return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
}
