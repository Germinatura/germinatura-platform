import { createApiError, paymentLinkChargeResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { paymentLinkChargeFromRow } from "@/lib/payment-links";

interface RouteContext { params: Promise<{ id: string }>; }

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

/** Current state of a Payment Link, visible to whoever asked for it and to finance. */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const chargeId = z.uuid().safeParse(id);
  if (!chargeId.success) return fail("PAYMENT_LINK_NOT_FOUND", "Link de pagamento não encontrado", requestId, 404);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_payment_link_charge", { p_charge_id: chargeId.data });
    if (error?.message.includes("PAYMENT_LINK_NOT_FOUND")) return fail("PAYMENT_LINK_NOT_FOUND", "Link de pagamento não encontrado", requestId, 404);
    const charge = error ? null : paymentLinkChargeFromRow(data);
    if (!charge) return fail("PAYMENT_LINK_UNAVAILABLE", "Link de pagamento temporariamente indisponível", requestId, 503);
    return NextResponse.json(paymentLinkChargeResponseSchema.parse({ data: charge, request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("PAYMENT_LINK_UNAVAILABLE", "Link de pagamento temporariamente indisponível", requestId, 503);
  }
}
