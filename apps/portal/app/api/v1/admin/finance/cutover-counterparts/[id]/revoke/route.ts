import { cutoverCounterpartResponseSchema, idempotencyKeySchema, revokeCutoverCounterpartRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { camelize, financeHistoryDatabaseError, financeHistoryErrorResponse, financeHistoryFailure } from "@/lib/finance-history";

/** PR E: revokes a designation (append-only); the presentation goes back to the original entries. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const id = z.uuid().safeParse((await context.params).id);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = revokeCutoverCounterpartRequestSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !key.success || !parsed.success) return financeHistoryErrorResponse("INVALID_REQUEST", "Informe o motivo da revogação.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("revoke_cutover_counterpart", {
      p_designation_id: id.data, p_reason: parsed.data.reason, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return financeHistoryDatabaseError(error.message, requestId);
    return NextResponse.json(cutoverCounterpartResponseSchema.parse({ data: camelize(data), request_id: requestId }),
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    return financeHistoryFailure(error, requestId);
  }
}
