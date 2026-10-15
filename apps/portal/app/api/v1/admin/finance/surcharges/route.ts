import {
  idempotencyKeySchema, paymentSurchargeRulesResponseSchema, savePaymentSurchargeRuleRequestSchema, savePaymentSurchargeRuleResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { databaseSurchargeRulesSchema, surchargeErrorResponse, toSurchargeRules } from "@/lib/payment-surcharges";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });

/** PR D: finance reads the acréscimo of each method in the cohort and its version history. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_payment_surcharge_rules");
    if (error?.message.includes("COHORT_REQUIRED")) return surchargeErrorResponse("COHORT_REQUIRED", "Selecione uma turma.", requestId, 409);
    const rows = databaseSurchargeRulesSchema.safeParse(data);
    if (error || !rows.success) return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(paymentSurchargeRulesResponseSchema.parse({ data: toSurchargeRules(rows.data), request_id: requestId }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return surchargeErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
  }
}

const databaseSavedSchema = z.object({
  rule_id: z.uuid(), method: z.string(), version: z.number().int(), mode: z.string(), rate_bps: z.number().int().nullable(),
  fixed_cents: z.number().int().nullable(), reason: z.string(), created_at: z.string(),
});

/** Sets the acréscimo of one method: a new immutable version with its reason. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = savePaymentSurchargeRuleRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) {
    return surchargeErrorResponse("INVALID_SURCHARGE_RULE", "Escolha um modo (sem acréscimo, percentual ou fixo), o valor e o motivo.", requestId, 422);
  }
  const value = parsed.data;
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_payment_surcharge_rule", {
      p_method: value.method, p_mode: value.mode,
      p_rate_bps: value.mode === "PERCENTAGE" ? value.rateBps : null,
      p_fixed_cents: value.mode === "FIXED" ? value.fixedCents : null,
      p_reason: value.reason, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("PAYMENT_SURCHARGE_RULE_UNCHANGED")) return surchargeErrorResponse("SURCHARGE_RULE_UNCHANGED", "Esta já é a regra em vigor.", requestId, 409);
      if (error.message.includes("COHORT_REQUIRED")) return surchargeErrorResponse("COHORT_REQUIRED", "Selecione uma turma antes de alterar o acréscimo.", requestId, 409);
      if (error.message.includes("FINANCE_MANAGE_REQUIRED")) return surchargeErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
      if (error.message.includes("IDEMPOTENCY_")) return surchargeErrorResponse("IDEMPOTENCY_CONFLICT", "Esta alteração já está em processamento.", requestId, 409);
      if (error.message.includes("INVALID_PAYMENT_SURCHARGE_RULE")) return surchargeErrorResponse("INVALID_SURCHARGE_RULE", "Confira o modo, o valor e o motivo.", requestId, 422);
      return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
    }
    const row = databaseSavedSchema.safeParse(data);
    if (!row.success) return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(savePaymentSurchargeRuleResponseSchema.parse({
      data: {
        ruleId: row.data.rule_id, method: row.data.method, version: row.data.version, mode: row.data.mode, rateBps: row.data.rate_bps,
        fixedCents: row.data.fixed_cents, reason: row.data.reason, createdAt: row.data.created_at,
      },
      request_id: requestId,
    }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return surchargeErrorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return surchargeErrorResponse("SURCHARGES_UNAVAILABLE", "Acréscimos temporariamente indisponíveis.", requestId, 503);
  }
}
