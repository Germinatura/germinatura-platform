import { financeEntryResponseSchema, idempotencyKeySchema, reverseFinanceEntryRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseFinanceEntrySchema, financeEntryDatabaseError, financeEntryErrorResponse, toFinanceEntry } from "@/lib/finance-entries";

interface RouteContext { params: Promise<{ id: string }>; }

/** Undoes a manual entry with one compensating entry; the original stays untouched. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = reverseFinanceEntryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return financeEntryErrorResponse("INVALID_REQUEST", "Informe o motivo do estorno.", requestId, 422);
  }
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("reverse_finance_entry", {
      p_entry_id: id, p_reason: parsed.data.reason, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return financeEntryDatabaseError(error.message, requestId);
    const row = databaseFinanceEntrySchema.safeParse(data);
    if (!row.success) return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(financeEntryResponseSchema.parse({ data: toFinanceEntry(row.data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return financeEntryErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return financeEntryErrorResponse("FINANCE_UNAVAILABLE", "Lançamentos temporariamente indisponíveis.", requestId, 503);
  }
}
