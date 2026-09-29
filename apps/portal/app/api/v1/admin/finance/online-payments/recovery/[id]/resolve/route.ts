import { resolvePaymentRecoveryRequestSchema } from "@germinatura/contracts";
import { z } from "zod";
import { onlinePaymentFailure, runOnlinePaymentAction } from "@/lib/online-payments";

interface RouteContext { params: Promise<{ id: string }>; }

/** Finance closes a recovery item with a note. */
export async function POST(request: Request, context: RouteContext) {
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return onlinePaymentFailure("PAYMENT_RECOVERY_NOT_FOUND", "Item de recuperação não encontrado.", crypto.randomUUID(), 404);
  return runOnlinePaymentAction(request, resolvePaymentRecoveryRequestSchema, (body) => ({
    name: "resolve_payment_recovery_item", args: { p_item_id: id.data, p_note: body.note },
  }));
}
