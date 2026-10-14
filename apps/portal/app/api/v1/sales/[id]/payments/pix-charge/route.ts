import { createApiError, pixChargeResponseSchema } from "@germinatura/contracts";
import { hasPermission } from "@germinatura/auth";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseSurchargeRulesSchema, toSurchargeRules } from "@/lib/payment-surcharges";
import { pixChargeAmount, pixChargeFor, pixReceiverMessages } from "@/lib/pix-charge";

interface RouteContext { params: Promise<{ id: string }>; }

const saleSchema = z.object({ id: z.uuid(), total_cents: z.number().int().nonnegative(), status: z.string(), created_by: z.uuid() });

function errorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/**
 * H2d: the static Pix QR (BR Code) of a PDV sale awaiting payment, for the seller who made it. Read-only: it records
 * nothing and confirms nothing; the operator still checks the PicPay app and confirms manually. The amount comes from
 * the sale and the Pix acréscimo in force (or without it when ?waiveSurcharge=true by someone who may waive it).
 */
export async function GET(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return errorResponse("INVALID_SALE", "Venda inválida", requestId, 422);
  const waive = new URL(request.url).searchParams.get("waiveSurcharge") === "true";

  let user;
  try {
    user = await requirePermission("sales.create");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("PIX_CHARGE_UNAVAILABLE", "QR Pix temporariamente indisponível", requestId, 503);
  }
  if (waive && !hasPermission(user, "sales.surcharge.waive")) {
    return errorResponse("SURCHARGE_WAIVER_FORBIDDEN", "Você não pode remover o acréscimo", requestId, 403);
  }

  let supabase;
  try {
    supabase = await createAuthenticatedSupabaseClient(request);
  } catch {
    return errorResponse("PIX_CHARGE_UNAVAILABLE", "QR Pix temporariamente indisponível", requestId, 503);
  }
  const [saleResult, rulesResult] = await Promise.all([
    supabase.from("sales").select("id,total_cents,status,created_by").eq("id", id).maybeSingle(),
    supabase.rpc("list_payment_surcharge_rules"),
  ]);
  if (saleResult.error || rulesResult.error) return errorResponse("PIX_CHARGE_UNAVAILABLE", "QR Pix temporariamente indisponível", requestId, 503);
  const sale = saleSchema.safeParse(saleResult.data);
  // Only the seller's own sale, and only while it waits for payment (the same rule as the manual confirmation).
  if (!sale.success || sale.data.created_by !== user.id) return errorResponse("SALE_NOT_FOUND", "Venda não encontrada", requestId, 404);
  if (sale.data.status !== "AWAITING_PAYMENT") return errorResponse("SALE_NOT_AWAITING_PAYMENT", "A venda não aguarda pagamento", requestId, 409);
  const rules = databaseSurchargeRulesSchema.safeParse(rulesResult.data);
  if (!rules.success) return errorResponse("PIX_CHARGE_UNAVAILABLE", "QR Pix temporariamente indisponível", requestId, 503);
  const rule = toSurchargeRules(rules.data).rules.find((item) => item.method === "PIX");
  if (!rule) return errorResponse("PIX_CHARGE_UNAVAILABLE", "QR Pix temporariamente indisponível", requestId, 503);

  const amount = pixChargeAmount({ saleTotalCents: sale.data.total_cents, rule, waive });
  if (amount.amountCents <= 0) return errorResponse("PIX_CHARGE_UNAVAILABLE", "Venda sem valor a cobrar", requestId, 409);
  // The receiver comes only from this environment's configuration; without a valid one there is no QR at all.
  const charge = pixChargeFor({
    PICPAY_PIX_KEY: process.env.PICPAY_PIX_KEY,
    PICPAY_PIX_MERCHANT_NAME: process.env.PICPAY_PIX_MERCHANT_NAME,
    PICPAY_PIX_MERCHANT_CITY: process.env.PICPAY_PIX_MERCHANT_CITY,
  }, sale.data.id, amount.amountCents);
  if (charge.problem !== null) return errorResponse("PIX_RECEIVER_NOT_CONFIGURED", pixReceiverMessages[charge.problem], requestId, 503);

  return NextResponse.json(pixChargeResponseSchema.parse({
    data: { saleId: sale.data.id, ...amount, waived: waive, txid: charge.txid, payload: charge.payload },
    request_id: requestId,
  }), { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
