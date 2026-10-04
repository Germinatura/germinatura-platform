import { requestPaymentLinkRefundRequestSchema } from "@germinatura/contracts";
import { runOnlinePaymentAction } from "@/lib/online-payments";

/** Finance asks for a provider refund; the jobs worker submits it once. */
export async function POST(request: Request) {
  return runOnlinePaymentAction(request, requestPaymentLinkRefundRequestSchema, (body) => ({
    name: "request_payment_link_refund",
    args: { p_transaction_id: body.transactionId, p_amount_cents: body.amountCents, p_reason: body.reason, p_recovery_item_id: body.recoveryItemId },
  }));
}
