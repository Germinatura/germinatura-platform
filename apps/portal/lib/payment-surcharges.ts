import { createApiError, paymentSurchargeHistoryItemSchema, paymentSurchargeRuleSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

// PR D: acréscimo por meio de pagamento.

/** RPC arguments of the acréscimo shown to the customer and of the optional waiver. */
export function surchargeRpcArgs(value: { surchargeCents?: number; waiveSurcharge?: boolean; surchargeWaiverReason?: string }) {
  return {
    p_surcharge_cents: value.surchargeCents ?? null,
    p_waive_surcharge: value.waiveSurcharge ?? false,
    p_surcharge_waiver_reason: value.surchargeWaiverReason ?? null,
  };
}

const surchargeErrors: Record<string, { status: number; message: string }> = {
  PAYMENT_SURCHARGE_CHANGED: { status: 409, message: "O acréscimo deste meio de pagamento mudou. Confira o novo total com o cliente antes de cobrar." },
  PAYMENT_SURCHARGE_NOT_APPLICABLE: { status: 409, message: "Não há acréscimo para remover neste meio de pagamento." },
  SURCHARGE_WAIVE_FORBIDDEN: { status: 403, message: "Você não tem permissão para remover o acréscimo." },
  INVALID_SURCHARGE_WAIVER_REASON: { status: 422, message: "Explique por que o acréscimo foi removido." },
  INVALID_PAYMENT_SURCHARGE: { status: 422, message: "Acréscimo inválido." },
};

/** The acréscimo errors of the confirmation commands, or null when the message is about something else. */
export function surchargeDatabaseError(message: string, requestId: string, details?: string | null) {
  const code = Object.keys(surchargeErrors).find((candidate) => message.includes(candidate));
  if (!code) return null;
  let expected: number | undefined;
  try {
    const parsed = details ? z.object({ expected_cents: z.number().int().nonnegative() }).safeParse(JSON.parse(details)) : null;
    expected = parsed?.success ? parsed.data.expected_cents : undefined;
  } catch {
    expected = undefined;
  }
  return NextResponse.json(createApiError(code, surchargeErrors[code].message, requestId, expected === undefined ? undefined : { expectedSurchargeCents: expected }), {
    status: surchargeErrors[code].status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

export const databaseSurchargeRulesSchema = z.object({
  cohort_id: z.uuid(),
  rules: z.array(z.object({
    method: z.string(), mode: z.string(), rate_bps: z.number().int().nullable(), fixed_cents: z.number().int().nullable(),
    version: z.number().int(), rule_id: z.uuid().nullable(), reason: z.string().nullable(), updated_at: z.string().nullable(),
    updated_by_name: z.string().nullable(),
  })),
  history: z.array(z.object({
    rule_id: z.uuid(), method: z.string(), version: z.number().int(), mode: z.string(), rate_bps: z.number().int().nullable(),
    fixed_cents: z.number().int().nullable(), reason: z.string(), created_at: z.string(), created_by_name: z.string(),
  })).nullable(),
});

export function toSurchargeRules(value: z.infer<typeof databaseSurchargeRulesSchema>) {
  return {
    cohortId: value.cohort_id,
    rules: value.rules.map((rule) => paymentSurchargeRuleSchema.parse({
      method: rule.method, mode: rule.mode, rateBps: rule.rate_bps, fixedCents: rule.fixed_cents, version: rule.version,
      ruleId: rule.rule_id, reason: rule.reason, updatedAt: rule.updated_at, updatedByName: rule.updated_by_name,
    })),
    history: value.history && value.history.map((item) => paymentSurchargeHistoryItemSchema.parse({
      ruleId: item.rule_id, method: item.method, version: item.version, mode: item.mode, rateBps: item.rate_bps,
      fixedCents: item.fixed_cents, reason: item.reason, createdAt: item.created_at, createdByName: item.created_by_name,
    })),
  };
}

export function surchargeErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
