import { createApiError } from "@germinatura/contracts";
import { createRequestId, structuredLog } from "@germinatura/observability";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

function validSignature(rawBody: string, provided: string | null, secret: string): boolean {
  if (!provided) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = provided.replace(/^sha256=/, "");
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const secret = process.env.ABACATEPAY_WEBHOOK_SECRET;
  if (process.env.PAYMENTS_ENABLED !== "true" || !secret) {
    return NextResponse.json(createApiError("PAYMENTS_DISABLED", "Integração de pagamentos desabilitada", requestId), { status: 503 });
  }

  const rawBody = await request.text();
  if (!validSignature(rawBody, request.headers.get("x-webhook-signature"), secret)) {
    structuredLog("warn", "abacatepay.webhook.invalid_signature", { request_id: requestId });
    return NextResponse.json(createApiError("INVALID_WEBHOOK_SIGNATURE", "Assinatura inválida", requestId), { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody) as { event?: string; data?: { status?: string; id?: string; metadata?: { id?: string } } };
    const paid = body.event === "BILLING_PAID" || body.data?.status === "PAID" || body.data?.status === "PAGO";
    const externalId = body.data?.id ?? body.data?.metadata?.id;
    if (paid && externalId) {
      await prisma.$transaction(async (transaction) => {
        const order = await transaction.pedidoRifa.findUnique({ where: { abacatePayId: externalId } });
        if (!order || order.status === "PAGO") return;
        await transaction.pedidoRifa.update({ where: { id: order.id }, data: { status: "PAGO" } });
        await transaction.numeroRifa.updateMany({ where: { pedidoRifaId: order.id }, data: { status: "VENDIDO" } });
      });
    }
    return NextResponse.json({ received: true, request_id: requestId });
  } catch (error) {
    structuredLog("error", "abacatepay.webhook.failed", { request_id: requestId, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(createApiError("WEBHOOK_PROCESSING_FAILED", "Falha ao processar webhook", requestId), { status: 500 });
  }
}
