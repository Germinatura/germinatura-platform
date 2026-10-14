import {
  cutoverCounterpartResponseSchema, cutoverCounterpartsResponseSchema, designateCutoverCounterpartRequestSchema, idempotencyKeySchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { camelize, financeHistoryDatabaseError, financeHistoryErrorResponse, financeHistoryFailure } from "@/lib/finance-history";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** PR E: cutover counterpart designations (presentation only) and what can still be designated. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_cutover_counterparts");
    if (error) return financeHistoryDatabaseError(error.message, requestId);
    return NextResponse.json(cutoverCounterpartsResponseSchema.parse({ data: camelize(data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    return financeHistoryFailure(error, requestId);
  }
}

/** Designates a manual income as the technical counterpart of an expense; nothing in the books changes. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = designateCutoverCounterpartRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return financeHistoryErrorResponse("INVALID_REQUEST", "Confira a contrapartida, a despesa e o motivo.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("designate_cutover_counterpart", {
      p_counterpart_manual_entry_id: parsed.data.counterpartManualEntryId, p_target_statement_line_id: parsed.data.targetStatementLineId,
      p_target_manual_expense_id: parsed.data.targetManualExpenseId, p_neutralized_cents: parsed.data.neutralizedCents, p_reason: parsed.data.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return financeHistoryDatabaseError(error.message, requestId);
    return NextResponse.json(cutoverCounterpartResponseSchema.parse({ data: camelize(data), request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    return financeHistoryFailure(error, requestId);
  }
}
