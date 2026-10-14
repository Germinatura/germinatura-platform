import {
  historicalAdjustmentResponseSchema, historicalAdjustmentsResponseSchema, idempotencyKeySchema, recordHistoricalAdjustmentRequestSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { camelize, financeHistoryDatabaseError, financeHistoryErrorResponse, financeHistoryFailure } from "@/lib/finance-history";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** PR E: historical adjustments without cash, and the negative count adjustments a CMV/PERDA increase can recognise. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_finance_historical_adjustments");
    if (error) return financeHistoryDatabaseError(error.message, requestId);
    return NextResponse.json(historicalAdjustmentsResponseSchema.parse({ data: camelize(data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    return financeHistoryFailure(error, requestId);
  }
}

/** Records one adjustment of one result component; no account, no cash. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = recordHistoricalAdjustmentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return financeHistoryErrorResponse("INVALID_REQUEST", "Confira os dados do ajuste.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("record_finance_historical_adjustment", {
      p_component: parsed.data.component, p_direction: parsed.data.direction, p_amount_cents: parsed.data.amountCents,
      p_competence_on: parsed.data.competenceOn, p_category: parsed.data.category, p_justification: parsed.data.justification,
      p_reference: parsed.data.reference, p_provenance: parsed.data.provenance,
      p_stock_movement_ids: parsed.data.stockMovementIds.length > 0 ? parsed.data.stockMovementIds : null,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return financeHistoryDatabaseError(error.message, requestId);
    return NextResponse.json(historicalAdjustmentResponseSchema.parse({ data: camelize(data), request_id: requestId }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    return financeHistoryFailure(error, requestId);
  }
}
