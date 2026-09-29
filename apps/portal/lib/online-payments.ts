import { createApiError, idempotencyKeySchema, onlinePaymentActionResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
export const onlinePaymentFailure = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });

// Database refusals shown to finance in plain language.
const knownErrors: Array<[string, string, number]> = [
  ["PAYMENT_RECOVERY_ALREADY_RESOLVED", "Este item já foi resolvido.", 409],
  ["PAYMENT_RECOVERY_NOT_FOUND", "Item de recuperação não encontrado ou já resolvido.", 404],
  ["PAYMENT_RECEIPT_NOT_FOUND", "Evento não encontrado.", 404],
  ["PAYMENT_LINK_NOT_UNCERTAIN", "Só links em situação incerta podem ser reconciliados.", 409],
  ["PAYMENT_LINK_ALREADY_REGISTERED", "Este ID de link já pertence a outra cobrança.", 409],
  ["REFUND_NOT_UNCERTAIN", "Só estornos em situação incerta podem ser reconciliados.", 409],
  ["PAYMENT_TRANSACTION_NOT_FOUND", "Só pagamentos informados pelo PicPay podem ser estornados.", 404],
  ["REFUND_EXCEEDS_PAYMENT", "O estorno ultrapassa o valor pago ainda não estornado.", 409],
  ["REFUND_ALREADY_IN_PROGRESS", "Já existe um estorno em andamento para esta transação.", 409],
  ["INVALID_", "Confira os dados informados.", 422],
  ["IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo.", 409],
  ["IDEMPOTENCY_IN_PROGRESS", "A ação já está em processamento.", 409],
  ["FINANCE_REQUIRED", "Somente o financeiro executa esta ação.", 403],
];

/** Runs one audited finance action: permission, Idempotency-Key, validated body and database RPC. */
export async function runOnlinePaymentAction<T>(
  request: Request, schema: z.ZodType<T> | null, rpc: (body: T, idempotencyKey: string) => { name: string; args: Record<string, unknown> },
): Promise<NextResponse> {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) return onlinePaymentFailure("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", requestId, 422);
  let body = null as T;
  if (schema) {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return onlinePaymentFailure("INVALID_REQUEST", "Confira os dados informados.", requestId, 422);
    body = parsed.data;
  }
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const call = rpc(body, key.data);
    const { data, error } = await client.rpc(call.name, { ...call.args, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID() });
    if (error) {
      const known = knownErrors.find(([code]) => error.message.includes(code));
      return known
        ? onlinePaymentFailure(known[0].replace(/_$/, "_REQUEST"), known[1], requestId, known[2])
        : onlinePaymentFailure("ONLINE_PAYMENTS_UNAVAILABLE", "Pagamentos online temporariamente indisponíveis.", requestId, 503);
    }
    const result = typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : {};
    return NextResponse.json(onlinePaymentActionResponseSchema.parse({ data: result, request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return onlinePaymentFailure(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return onlinePaymentFailure("ONLINE_PAYMENTS_UNAVAILABLE", "Pagamentos online temporariamente indisponíveis.", requestId, 503);
  }
}
