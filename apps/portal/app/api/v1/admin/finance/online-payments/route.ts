import { createApiError, onlinePaymentsAdminResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

const recoveryRowSchema = z.object({
  id: z.uuid(), kind: z.string(), status: z.string(), receipt_id: z.uuid().nullable(), charge_id: z.uuid().nullable(),
  sale_id: z.uuid().nullable(), amount_cents: z.number().int().nullable(), transaction_id: z.string().nullable(), detail: z.string(),
  opened_at: z.string(), resolved_at: z.string().nullable(), resolution_note: z.string().nullable(), resolved_by_name: z.string().nullable(),
});
const activitySchema = z.object({
  charges: z.array(z.object({
    charge_id: z.uuid(), sale_id: z.uuid(), order_number: z.string(), amount_cents: z.number().int(), status: z.string(),
    error_code: z.string().nullable(), paid_transaction_id: z.string().nullable(), checkout_url: z.string().nullable(),
    sale_status: z.string(), sale_channel: z.string(),
    requested_by_name: z.string(), inactivation_pending: z.boolean(), inactivated_at: z.string().nullable(),
    created_at: z.string(), updated_at: z.string(),
  })),
  refunds: z.array(z.object({
    refund_id: z.uuid(), transaction_id: z.string(), charge_id: z.uuid().nullable(), sale_id: z.uuid().nullable(),
    amount_cents: z.number().int(), reason: z.string(), status: z.string(), error_code: z.string().nullable(),
    requested_by_name: z.string(), created_at: z.string(), confirmed_at: z.string().nullable(),
  })),
});

/** ADR 0010: recovery queue, recent Payment Links and provider refunds for finance. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const recoveryStatus = new URL(request.url).searchParams.get("recovery") === "RESOLVED" ? "RESOLVED" : "OPEN";
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const [recovery, activity] = await Promise.all([
      client.rpc("list_payment_recovery_items", { p_status: recoveryStatus, p_limit: 100 }),
      client.rpc("list_payment_link_activity_admin", { p_limit: 50 }),
    ]);
    const items = z.array(recoveryRowSchema).safeParse(recovery.data);
    const rows = activitySchema.safeParse(activity.data);
    if (recovery.error || activity.error || !items.success || !rows.success) {
      return fail("ONLINE_PAYMENTS_UNAVAILABLE", "Pagamentos online temporariamente indisponíveis.", requestId, 503);
    }
    const payload = onlinePaymentsAdminResponseSchema.safeParse({
      data: {
        recovery: items.data.map((item) => ({
          id: item.id, kind: item.kind, status: item.status, receiptId: item.receipt_id, chargeId: item.charge_id, saleId: item.sale_id,
          amountCents: item.amount_cents, transactionId: item.transaction_id, detail: item.detail, openedAt: item.opened_at,
          resolvedAt: item.resolved_at, resolutionNote: item.resolution_note, resolvedByName: item.resolved_by_name,
        })),
        links: rows.data.charges.map((charge) => ({
          chargeId: charge.charge_id, saleId: charge.sale_id, orderNumber: charge.order_number, amountCents: charge.amount_cents,
          status: charge.status, errorCode: charge.error_code, paidTransactionId: charge.paid_transaction_id,
          checkoutUrl: charge.checkout_url, saleStatus: charge.sale_status,
          saleChannel: charge.sale_channel, requestedByName: charge.requested_by_name, inactivationPending: charge.inactivation_pending,
          inactivatedAt: charge.inactivated_at, createdAt: charge.created_at, updatedAt: charge.updated_at,
        })),
        refunds: rows.data.refunds.map((refund) => ({
          refundId: refund.refund_id, transactionId: refund.transaction_id, chargeId: refund.charge_id, saleId: refund.sale_id,
          amountCents: refund.amount_cents, reason: refund.reason, status: refund.status, errorCode: refund.error_code,
          requestedByName: refund.requested_by_name, createdAt: refund.created_at, confirmedAt: refund.confirmed_at,
        })),
      },
      request_id: requestId,
    });
    if (!payload.success) return fail("ONLINE_PAYMENTS_UNAVAILABLE", "Pagamentos online retornaram dados inválidos.", requestId, 503);
    return NextResponse.json(payload.data, { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("ONLINE_PAYMENTS_UNAVAILABLE", "Pagamentos online temporariamente indisponíveis.", requestId, 503);
  }
}
