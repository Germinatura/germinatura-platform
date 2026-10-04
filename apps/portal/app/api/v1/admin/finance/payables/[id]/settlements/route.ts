import { createApiError, idempotencyKeySchema, purchasePayableCommandResponseSchema, settlePurchasePayableSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    await requirePermission("finance.manage");
    const payableId = z.uuid().safeParse((await params).id);
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const body = settlePurchasePayableSchema.safeParse(await request.json().catch(() => null));
    if (!payableId.success || !key.success || !body.success) return fail("INVALID_PAYABLE_SETTLEMENT", "Confira valor, data, método, referência e motivo.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("settle_purchase_payable", {
      p_payable_id: payableId.data, p_amount_cents: body.data.amountCents,
      p_effective_on: body.data.effectiveOn, p_payment_method: body.data.paymentMethod,
      p_reference: body.data.reference, p_reason: body.data.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "PURCHASE_PAYABLE_NOT_FOUND") return fail(error.message, "Obrigação não encontrada.", 404);
      if (["PURCHASE_PAYABLE_ALREADY_SETTLED", "PURCHASE_PAYABLE_AMOUNT_EXCEEDED", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) {
        return fail(error.message, "O saldo mudou ou a solicitação já foi processada. Atualize a página.", 409);
      }
      if (["22023", "23514", "22003"].includes(error.code)) return fail("INVALID_PAYABLE_SETTLEMENT", "Confira os dados da liquidação.", 422);
      return fail("FINANCE_UNAVAILABLE", "Não foi possível registrar a liquidação.", 503);
    }
    const result = purchasePayableCommandResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("FINANCE_UNAVAILABLE", "Não foi possível confirmar a liquidação.", 503);
    return NextResponse.json(result.data, { status: 201, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("FINANCE_UNAVAILABLE", "Não foi possível registrar a liquidação.", 503);
  }
}
