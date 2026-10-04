import { z } from "zod";

const safeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const promotionChannelSchema = z.enum(["PORTAL", "PDV", "RESERVA"]);
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const quantityPriceRuleSchema = z.object({
  type: z.literal("QUANTIDADE_PRECO"), groupQuantity: z.number().int().min(2),
  groupPriceCents: safeInteger, maxGroupsPerLine: z.number().int().positive().nullable(),
}).strict();
export const percentageRuleSchema = z.object({
  type: z.literal("PERCENTUAL"), percentageBasisPoints: z.number().int().min(1).max(9_999),
}).strict();
export const fixedUnitPriceRuleSchema = z.object({
  type: z.literal("VALOR_FIXO_UNITARIO"), fixedUnitPriceCents: safeInteger,
}).strict();
export const buyPayRuleSchema = z.object({
  type: z.literal("LEVE_PAGUE"), buyQuantity: z.number().int().min(2).max(1_000),
  payQuantity: z.number().int().min(1), maxGroupsPerLine: z.number().int().positive().nullable(),
}).strict().refine((rule) => rule.payQuantity < rule.buyQuantity, { message: "Pague menos unidades do que leva" });
export const promotionTierSchema = z.object({
  minQuantity: z.number().int().min(2).max(1_000_000), percentageBasisPoints: z.number().int().min(1).max(9_999),
}).strict();
export const tieredRuleSchema = z.object({
  type: z.literal("ESCALONADA"), tiers: z.array(promotionTierSchema).min(1).max(10),
}).strict().refine((rule) => rule.tiers.every((tier, index) => index === 0
  || (tier.minQuantity > rule.tiers[index - 1].minQuantity && tier.percentageBasisPoints > rule.tiers[index - 1].percentageBasisPoints)),
{ message: "As faixas devem crescer em quantidade e desconto" });
export const comboRuleSchema = z.object({
  type: z.literal("COMBO_MIX"),
  components: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(1_000) }).strict()).min(2).max(10)
    .refine((components) => unique(components.map((component) => component.productId)), { message: "Produtos repetidos no combo" }),
  comboPriceCents: safeInteger, maxCombosPerCart: z.number().int().positive().nullable(),
}).strict();
export const couponRuleSchema = z.object({
  type: z.literal("CUPOM"),
  code: z.string().min(3).max(40).regex(/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/),
  discount: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("PERCENTUAL"), percentageBasisPoints: z.number().int().min(1).max(9_999) }).strict(),
    z.object({ kind: z.literal("VALOR_FIXO"), amountCents: safeInteger.refine((value) => value >= 1) }).strict(),
  ]),
}).strict();
export const managedPromotionRuleSchema = z.discriminatedUnion("type", [
  quantityPriceRuleSchema, percentageRuleSchema, fixedUnitPriceRuleSchema, buyPayRuleSchema, tieredRuleSchema, comboRuleSchema,
  couponRuleSchema,
]);

const managedPromotionFields = {
  id: z.uuid(), revision: z.number().int().positive(), code: z.string(), name: z.string(),
  description: z.string().nullable(), active: z.boolean(), publicable: z.boolean(),
  priority: z.number().int().min(0).max(1000), cumulative: z.boolean(),
  validFrom: z.iso.datetime({ offset: true }), validTo: z.iso.datetime({ offset: true }).nullable(),
  globalRedemptionLimit: z.number().int().positive().nullable(),
  perUserRedemptionLimit: z.number().int().positive().nullable(),
  productIds: z.array(z.uuid()).min(1).max(100).refine(unique),
  channels: z.array(promotionChannelSchema).min(1).max(3).refine(unique),
};

export const managedPromotionSchema = z.object({
  ...managedPromotionFields, rule: managedPromotionRuleSchema,
}).strict();
export const quantityPricePromotionSchema = z.object({
  ...managedPromotionFields, rule: quantityPriceRuleSchema,
}).strict();

const { revision: _revision, ...saveBaseFields } = managedPromotionFields;
void _revision;
const saveFields = {
  ...saveBaseFields,
  id: z.uuid().nullable(), expectedRevision: z.number().int().positive().nullable(),
  code: z.string().trim().min(1).max(80).regex(/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/),
  name: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(2000).nullable(),
  reason: z.string().trim().min(4).max(500),
};

type SaveRefinementValue = { id: string | null; expectedRevision: number | null; validFrom: string; validTo: string | null };
function saveRefinements<T extends z.ZodObject>(schema: T) {
  return schema
    .refine((value) => { const candidate=value as SaveRefinementValue; return (candidate.id === null) === (candidate.expectedRevision === null); }, { message: "Informe a revisão ao editar" })
    .refine((value) => { const candidate=value as SaveRefinementValue; return candidate.validTo === null || Date.parse(candidate.validTo) > Date.parse(candidate.validFrom); }, { message: "O fim deve ser posterior ao início" });
}

// PROMO-004: only a coupon may be cumulative. Limits are consumed atomically at checkout (PROMO-007).
export const savePromotionSchema = saveRefinements(z.object({
  ...saveFields, rule: managedPromotionRuleSchema,
}).strict()).refine((value) => !value.cumulative || value.rule.type === "CUPOM", { message: "Só cupons podem ser cumulativos" });
/** Legacy quantity-only command: no cumulativity and no limits. */
export const saveQuantityPricePromotionSchema = saveRefinements(z.object({
  ...saveFields, cumulative: z.literal(false), globalRedemptionLimit: z.null(), perUserRedemptionLimit: z.null(),
  rule: quantityPriceRuleSchema,
}).strict());

export const savePromotionResponseSchema = z.object({
  data: managedPromotionSchema.extend({ correlationId: z.uuid() }), request_id: z.string().min(1),
}).strict();
export const saveQuantityPricePromotionResponseSchema = z.object({
  data: quantityPricePromotionSchema.extend({ correlationId: z.uuid() }), request_id: z.string().min(1),
}).strict();
export type ManagedPromotion = z.infer<typeof managedPromotionSchema>;
export type QuantityPricePromotion = z.infer<typeof quantityPricePromotionSchema>;
