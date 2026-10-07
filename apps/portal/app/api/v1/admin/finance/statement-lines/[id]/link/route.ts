import { idempotencyKeySchema, picpayStatementLinkRequestSchema, picpayStatementLinkResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { statementDatabaseError, statementErrorResponse } from "@/lib/picpay-statement";

interface RouteContext { params: Promise<{ id: string }>; }
const databaseResultSchema = z.object({ line_id: z.uuid(), resolution: z.literal("VINCULADA") });

/** Links a pending line to the existing record that already carries its effect; the line adds nothing of its own. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = picpayStatementLinkRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return statementErrorResponse("INVALID_REQUEST", "Escolha um único registro para vincular.", requestId, 422);
  }
  const body = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("link_picpay_statement_line", {
      p_line_id: id, p_payable_settlement_id: body.payableSettlementId, p_manual_entry_id: body.manualEntryId, p_reason: body.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return statementDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return statementErrorResponse("STATEMENT_UNAVAILABLE", "Vínculo temporariamente indisponível.", requestId, 503);
    return NextResponse.json(picpayStatementLinkResponseSchema.parse({ data: { lineId: row.data.line_id, resolution: "VINCULADA" }, request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return statementErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return statementErrorResponse("STATEMENT_UNAVAILABLE", "Vínculo temporariamente indisponível.", requestId, 503);
  }
}
