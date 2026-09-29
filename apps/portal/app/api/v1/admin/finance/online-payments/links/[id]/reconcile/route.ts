import { reconcilePaymentLinkRequestSchema } from "@germinatura/contracts";
import { z } from "zod";
import { onlinePaymentFailure, runOnlinePaymentAction } from "@/lib/online-payments";

interface RouteContext { params: Promise<{ id: string }>; }

/** Finance settles an uncertain link: found in the PicPay panel, or confirmed never created. */
export async function POST(request: Request, context: RouteContext) {
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return onlinePaymentFailure("PAYMENT_LINK_NOT_FOUND", "Link não encontrado.", crypto.randomUUID(), 404);
  return runOnlinePaymentAction(request, reconcilePaymentLinkRequestSchema, (body) => ({
    name: "reconcile_uncertain_payment_link",
    args: { p_charge_id: id.data, p_provider_link_id: body.providerLinkId, p_checkout_url: body.checkoutUrl, p_note: body.note },
  }));
}
