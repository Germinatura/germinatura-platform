import { createApiError, idempotencyKeySchema, raffleCampaignResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const resultSchema = z.object({
  campaign_id: z.uuid(), status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "CLOSED", "DRAWN", "CANCELLED"]),
  number_count: z.number().int(), starts_at: z.string(), ends_at: z.string(), correlation_id: z.uuid(),
  released_reservations: z.number().int().optional(), paid_sales_to_refund: z.number().int().optional(),
}).passthrough();

// Database refusals in plain language for the raffle manager.
const knownErrors: Array<[string, string, number]> = [
  ["RAFFLE_STRUCTURE_LOCKED", "A estrutura da rifa só pode mudar enquanto ela é rascunho.", 409],
  ["RAFFLE_TRANSITION_INVALID", "Esta ação não é permitida no estado atual da rifa.", 409],
  ["RAFFLE_PERIOD_OVER", "O período de vendas já terminou; ajuste as datas no rascunho.", 409],
  ["RAFFLE_PENDING_RESERVATIONS", "Há reservas aguardando pagamento; pause a rifa e aguarde que expirem ou sejam pagas.", 409],
  ["RAFFLE_ALREADY_DRAWN", "Uma rifa sorteada não pode ser cancelada.", 409],
  ["RAFFLE_CAMPAIGN_NOT_FOUND", "Rifa não encontrada.", 404],
  ["INVALID_RAFFLE_CAMPAIGN_CONTEXT", "O produto precisa estar ativo e publicado e a localização precisa ser central e ativa.", 422],
  ["INVALID_", "Confira os dados informados.", 422],
  ["IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo.", 409],
  ["IDEMPOTENCY_IN_PROGRESS", "A ação já está em processamento.", 409],
  ["RAFFLE_MANAGE_FORBIDDEN", "Somente a gestão de rifas executa esta ação.", 403],
];

/** One audited raffle administration action: permission, Idempotency-Key, validated body and database RPC. */
export async function runRaffleAdminAction<T>(
  request: Request, context: { params: Promise<{ id: string }> }, schema: z.ZodType<T> | null,
  rpc: (campaignId: string, body: T) => { name: string; args: Record<string, unknown> },
): Promise<NextResponse> {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const id = z.uuid().safeParse((await context.params).id);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!id.success) return fail("RAFFLE_CAMPAIGN_NOT_FOUND", "Rifa não encontrada.", 404);
  if (!key.success) return fail("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key inválida ou ausente", 422);
  let body = null as T;
  if (schema) {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail("INVALID_RAFFLE_REQUEST", "Confira os dados informados.", 422);
    body = parsed.data;
  }
  try {
    await requirePermission("raffles.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const call = rpc(id.data, body);
    const { data, error } = await client.rpc(call.name, { ...call.args, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID() });
    if (error) {
      const known = knownErrors.find(([code]) => error.message.includes(code));
      return known ? fail(known[0].replace(/_$/, "_REQUEST"), known[1], known[2]) : fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503);
    }
    const result = resultSchema.safeParse(data);
    if (!result.success) return fail("RAFFLE_INVALID_DATA", "Rifa temporariamente indisponível", 503);
    const value = result.data;
    return NextResponse.json(raffleCampaignResponseSchema.parse({ data: {
      campaignId: value.campaign_id, status: value.status, numberCount: value.number_count, startsAt: value.starts_at,
      endsAt: value.ends_at, correlationId: value.correlation_id,
      ...(value.released_reservations === undefined ? {} : { releasedReservations: value.released_reservations }),
      ...(value.paid_sales_to_refund === undefined ? {} : { paidSalesToRefund: value.paid_sales_to_refund }),
    }, request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503);
  }
}
