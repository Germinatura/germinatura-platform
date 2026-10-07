import { idempotencyKeySchema, linkPicpayTransactionRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

interface RouteContext { params: Promise<{ id: string }>; }
const databaseResultSchema = z.object({ transaction_id: z.uuid(), payment_attempt_id: z.uuid().nullable(), action: z.enum(["LINK", "UNLINK"]) });

/** Links a PicPay transaction to a PDV payment by hand (or unlinks it), with a reason. */
export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = linkPicpayTransactionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !key.success || !parsed.success) {
    return picpayErrorResponse("INVALID_REQUEST", "Informe o pagamento do PDV e o motivo.", requestId, 422);
  }
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("link_picpay_transaction", {
      p_transaction_id: id, p_payment_attempt_id: parsed.data.paymentAttemptId, p_reason: parsed.data.reason, p_idempotency_key: key.data,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Vínculo temporariamente indisponível.", requestId, 503);
    return NextResponse.json({ data: { transactionId: row.data.transaction_id, paymentAttemptId: row.data.payment_attempt_id, action: row.data.action },
      request_id: requestId }, { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Vínculo temporariamente indisponível.", requestId, 503);
  }
}
