import { z } from "zod";
import { onlinePaymentFailure, runOnlinePaymentAction } from "@/lib/online-payments";

interface RouteContext { params: Promise<{ id: string }>; }

/** Finance re-runs a stored provider event; effects stay exactly-once. */
export async function POST(request: Request, context: RouteContext) {
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return onlinePaymentFailure("PAYMENT_RECEIPT_NOT_FOUND", "Evento não encontrado.", crypto.randomUUID(), 404);
  return runOnlinePaymentAction(request, null, () => ({ name: "replay_payment_webhook_receipt", args: { p_receipt_id: id.data } }));
}
