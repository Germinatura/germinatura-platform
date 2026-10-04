import { reconcilePaymentLinkRefundRequestSchema } from "@germinatura/contracts";
import { z } from "zod";
import { onlinePaymentFailure, runOnlinePaymentAction } from "@/lib/online-payments";

interface RouteContext { params: Promise<{ id: string }>; }

/** Finance settles an uncertain refund after checking the PicPay panel. */
export async function POST(request: Request, context: RouteContext) {
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return onlinePaymentFailure("REFUND_NOT_FOUND", "Estorno não encontrado.", crypto.randomUUID(), 404);
  return runOnlinePaymentAction(request, reconcilePaymentLinkRefundRequestSchema, (body) => ({
    name: "reconcile_uncertain_payment_link_refund", args: { p_refund_id: id.data, p_processed: body.processed, p_note: body.note },
  }));
}
