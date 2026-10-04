import { createApiError, idempotencyKeySchema, purchasePayableCommandResponseSchema, reversePurchasePayableSettlementSchema } from "@germinatura/contracts";
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
    const settlementId = z.uuid().safeParse((await params).id);
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const body = reversePurchasePayableSettlementSchema.safeParse(await request.json().catch(() => null));
    if (!settlementId.success || !key.success || !body.success) return fail("INVALID_PAYABLE_REVERSAL", "Confira data e motivo da reversão.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("reverse_purchase_payable_settlement", {
      p_settlement_id: settlementId.data, p_effective_on: body.data.effectiveOn,
      p_reason: body.data.reason, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail("FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "PAYABLE_SETTLEMENT_NOT_FOUND") return fail(error.message, "Liquidação não encontrada.", 404);
      if (["PAYABLE_SETTLEMENT_ALREADY_REVERSED", "PAYABLE_REVERSAL_TARGET_INVALID", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message)) {
        return fail(error.message, "A liquidação mudou ou já foi revertida. Atualize a página.", 409);
      }
      if (["22023", "23514"].includes(error.code)) return fail("INVALID_PAYABLE_REVERSAL", "Confira a data e o motivo da reversão.", 422);
      return fail("FINANCE_UNAVAILABLE", "Não foi possível reverter a liquidação.", 503);
    }
    const result = purchasePayableCommandResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail("FINANCE_UNAVAILABLE", "Não foi possível confirmar a reversão.", 503);
    return NextResponse.json(result.data, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("FINANCE_UNAVAILABLE", "Não foi possível reverter a liquidação.", 503);
  }
}
