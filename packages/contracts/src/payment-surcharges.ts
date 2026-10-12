import { z } from "zod";

// PR D: acréscimo por meio de pagamento, all values in integer cents or basis points. The acréscimo is charged to
// the customer; it is never the PicPay fee (that one comes only from the reconciliation).
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const paymentSurchargeMethodSchema = z.enum(["DINHEIRO", "PIX", "CREDITO", "DEBITO"]);
export type PaymentSurchargeMethodKey = z.infer<typeof paymentSurchargeMethodSchema>;
export const paymentSurchargeModeSchema = z.enum(["NONE", "PERCENTAGE", "FIXED"]);
export type PaymentSurchargeMode = z.infer<typeof paymentSurchargeModeSchema>;

export const paymentSurchargeRuleSchema = z.object({
  method: paymentSurchargeMethodSchema,
  mode: paymentSurchargeModeSchema,
  rateBps: z.number().int().min(1).max(10_000).nullable(),
  fixedCents: z.number().int().min(1).max(1_000_000).nullable(),
  // 0 = never configured (NONE).
  version: z.number().int().nonnegative(),
  ruleId: z.uuid().nullable(),
  reason: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  updatedByName: z.string().nullable(),
}).strict();
export type PaymentSurchargeRuleView = z.infer<typeof paymentSurchargeRuleSchema>;

export const paymentSurchargeHistoryItemSchema = z.object({
  ruleId: z.uuid(),
  method: paymentSurchargeMethodSchema,
  version: z.number().int().positive(),
  mode: paymentSurchargeModeSchema,
  rateBps: z.number().int().nullable(),
  fixedCents: z.number().int().nullable(),
  reason: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  createdByName: z.string(),
}).strict();
export type PaymentSurchargeHistoryItem = z.infer<typeof paymentSurchargeHistoryItemSchema>;

export const paymentSurchargeRulesResponseSchema = z.object({
  data: z.object({
    cohortId: z.uuid(),
    rules: z.array(paymentSurchargeRuleSchema).length(4),
    // Finance only; sellers receive null.
    history: z.array(paymentSurchargeHistoryItemSchema).nullable(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type PaymentSurchargeRulesResponse = z.infer<typeof paymentSurchargeRulesResponseSchema>;

const reason = z.string().trim().min(3).max(500);
// One explicit mode per rule: never a percentage and a fixed value at the same time.
export const savePaymentSurchargeRuleRequestSchema = z.discriminatedUnion("mode", [
  z.object({ method: paymentSurchargeMethodSchema, mode: z.literal("NONE"), reason }).strict(),
  z.object({ method: paymentSurchargeMethodSchema, mode: z.literal("PERCENTAGE"), rateBps: z.number().int().min(1).max(10_000), reason }).strict(),
  z.object({ method: paymentSurchargeMethodSchema, mode: z.literal("FIXED"), fixedCents: z.number().int().min(1).max(1_000_000), reason }).strict(),
]);
export type SavePaymentSurchargeRuleRequest = z.infer<typeof savePaymentSurchargeRuleRequestSchema>;

export const savePaymentSurchargeRuleResponseSchema = z.object({
  data: z.object({
    ruleId: z.uuid(),
    method: paymentSurchargeMethodSchema,
    version: z.number().int().positive(),
    mode: paymentSurchargeModeSchema,
    rateBps: z.number().int().nullable(),
    fixedCents: z.number().int().nullable(),
    reason: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

/** Snapshot of the acréscimo of one payment (null when there was none). */
export const paymentSurchargeSnapshotSchema = z.object({
  method: paymentSurchargeMethodSchema,
  mode: z.enum(["PERCENTAGE", "FIXED"]),
  rateBps: z.number().int().nullable(),
  fixedCents: z.number().int().nullable(),
  baseCents: cents,
  expectedCents: cents,
  appliedCents: cents,
  waived: z.boolean(),
  waiverReason: z.string().nullable(),
}).strict();
export type PaymentSurchargeSnapshot = z.infer<typeof paymentSurchargeSnapshotSchema>;

/** What the operator showed the customer, and the optional waiver ("Remover acréscimo"). */
export const paymentSurchargeConfirmationShape = {
  surchargeCents: cents.optional(),
  waiveSurcharge: z.boolean().optional(),
  surchargeWaiverReason: z.string().trim().min(5).max(500).optional(),
};

export function refineSurchargeWaiver(
  value: { waiveSurcharge?: boolean; surchargeWaiverReason?: string; surchargeCents?: number },
  context: z.RefinementCtx,
) {
  if (value.waiveSurcharge && !value.surchargeWaiverReason) {
    context.addIssue({ code: "custom", path: ["surchargeWaiverReason"], message: "Explique por que o acréscimo foi removido" });
  }
  if (!value.waiveSurcharge && value.surchargeWaiverReason) {
    context.addIssue({ code: "custom", path: ["surchargeWaiverReason"], message: "O motivo só acompanha a remoção do acréscimo" });
  }
  if (value.waiveSurcharge && !value.surchargeCents) {
    context.addIssue({ code: "custom", path: ["surchargeCents"], message: "Informe o acréscimo que está sendo removido" });
  }
}

export function toPaymentSurchargeSnapshot(value: {
  method: string; mode: string; rate_bps: number | null; fixed_cents: number | null; base_cents: number;
  expected_cents: number; applied_cents: number; waived: boolean; waiver_reason: string | null;
} | null | undefined): PaymentSurchargeSnapshot | null {
  if (!value) return null;
  return paymentSurchargeSnapshotSchema.parse({
    method: value.method, mode: value.mode, rateBps: value.rate_bps, fixedCents: value.fixed_cents, baseCents: value.base_cents,
    expectedCents: value.expected_cents, appliedCents: value.applied_cents, waived: value.waived, waiverReason: value.waiver_reason,
  });
}

/** Database shape of the snapshot (private.payment_surcharge_json). */
export const databasePaymentSurchargeSchema = z.object({
  method: paymentSurchargeMethodSchema,
  mode: z.enum(["PERCENTAGE", "FIXED"]),
  rate_bps: z.number().int().nullable(),
  fixed_cents: z.number().int().nullable(),
  base_cents: z.number().int().nonnegative(),
  expected_cents: z.number().int().nonnegative(),
  applied_cents: z.number().int().nonnegative(),
  waived: z.boolean(),
  waiver_reason: z.string().nullable(),
});
