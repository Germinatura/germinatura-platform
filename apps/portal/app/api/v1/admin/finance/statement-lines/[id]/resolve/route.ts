import { idempotencyKeySchema, picpayStatementResolutionResponseSchema, resolvePicpayStatementLineRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { statementDatabaseError, statementErrorResponse } from "@/lib/picpay-statement";

interface RouteContext { params: Promise<{ id: string }>; }
const databaseResultSchema = z.object({ line_id: z.uuid(), resolution: z.string(), category: z.string().nullable() });

/** Reviews one imported line: reconcile with a sale or refund, classify, mark as already recorded, or reopen. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = resolvePicpayStatementLineRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return statementErrorResponse("INVALID_REQUEST", "Confira a revisão da linha.", requestId, 422);
  }
  const body = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("resolve_picpay_statement_line", {
      p_line_id: id, p_action: body.action,
      p_category: body.action === "CLASSIFICAR" ? body.category : null,
      p_payment_attempt_id: body.action === "CONCILIAR_VENDA" ? body.paymentAttemptId : null,
      p_refund_entry_id: body.action === "CONCILIAR_ESTORNO" ? body.refundEntryId : null,
      p_reason: body.action === "JA_REGISTRADO" || body.action === "REABRIR" ? body.reason : body.action === "CLASSIFICAR" ? body.note ?? null : null,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return statementDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Revisão temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayStatementResolutionResponseSchema.parse({
      data: { lineId: row.data.line_id, resolution: row.data.resolution, category: row.data.category }, request_id: requestId,
    }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Revisão temporariamente indisponível.", requestId, 503);
  }
}
