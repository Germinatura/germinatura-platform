import { idempotencyKeySchema, picpayIsolationActivationRequestSchema, picpayIsolationActivationResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { requireAdminMaster } from "@/lib/cohort-admin";
import { picpayDatabaseError, picpayErrorResponse } from "@/lib/picpay-reconciliation";

/**
 * E0 (ADR 0011), ADMIN_MASTER: activates PicPay isolation once (unassigned evidence leaves every cohort's books), after
 * the global evidence was attributed. A global operation, audited with its reason. There is no deactivation route.
 */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const body = picpayIsolationActivationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !body.success) return picpayErrorResponse("INVALID_REQUEST", "Informe o motivo da ativação (8 a 300 caracteres).", requestId, 422);
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("activate_picpay_attribution_isolation", {
      p_reason: body.data.reason, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) return picpayDatabaseError(error.message, requestId);
    const stored = z.object({ active: z.literal(true), activated_now: z.boolean(), activated_at: z.string().nullable(), reason: z.string() }).parse(data);
    return NextResponse.json(picpayIsolationActivationResponseSchema.parse({
      data: { active: stored.active, activatedNow: stored.activated_now, activatedAt: stored.activated_at, reason: stored.reason }, request_id: requestId,
    }), { status: stored.activated_now ? 201 : 200, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) return picpayErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return picpayErrorResponse("PICPAY_UNAVAILABLE", "Não foi possível ativar o isolamento.", requestId, 503);
  }
}
