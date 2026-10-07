import { idempotencyKeySchema, resolvePicpayExceptionRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

const databaseResultSchema = z.object({ key: z.string(), action: z.enum(["RESOLVIDA", "REABERTA"]) });

/** Resolves an exception with a reason, or reopens it; never changes the evidence. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = resolvePicpayExceptionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return picpayErrorResponse("INVALID_REQUEST", "Informe a pendência e o motivo.", requestId, 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("resolve_picpay_exception", {
      p_key: parsed.data.key, p_action: parsed.data.action, p_reason: parsed.data.reason, p_idempotency_key: key.data,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const row = databaseResultSchema.safeParse(data);
    if (!row.success) return picpayErrorResponse("PICPAY_UNAVAILABLE", "Pendência temporariamente indisponível.", requestId, 503);
    return NextResponse.json({ data: row.data, request_id: requestId }, { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Pendência temporariamente indisponível.", requestId, 503);
  }
}
