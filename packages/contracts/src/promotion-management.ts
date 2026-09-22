import { z } from "zod";

const safeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const promotionChannelSchema = z.enum(["PORTAL", "PDV", "RESERVA"]);
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const quantityPricePromotionSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive(), code: z.string(), name: z.string(),
  description: z.string().nullable(), active: z.boolean(), publicable: z.boolean(),
  priority: z.number().int().min(0).max(1000), cumulative: z.boolean(),
  validFrom: z.iso.datetime({ offset: true }), validTo: z.iso.datetime({ offset: true }).nullable(),
  globalRedemptionLimit: z.number().int().positive().nullable(),
  perUserRedemptionLimit: z.number().int().positive().nullable(),
  productIds: z.array(z.uuid()).min(1).max(100).refine(unique),
  channels: z.array(promotionChannelSchema).min(1).max(3).refine(unique),
  rule: z.object({ type: z.literal("QUANTIDADE_PRECO"), groupQuantity: z.number().int().min(2),
    groupPriceCents: safeInteger, maxGroupsPerLine: z.number().int().positive().nullable() }).strict(),
}).strict();

export const saveQuantityPricePromotionSchema = quantityPricePromotionSchema.omit({ id: true, revision: true }).extend({
  id: z.uuid().nullable(), expectedRevision: z.number().int().positive().nullable(),
  code: z.string().trim().min(1).max(80).regex(/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/),
  name: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(2000).nullable(),
  cumulative: z.literal(false), globalRedemptionLimit: z.null(), perUserRedemptionLimit: z.null(),
  reason: z.string().trim().min(4).max(500),
}).strict()
  .refine((value) => (value.id === null) === (value.expectedRevision === null), { message: "Informe a revisão ao editar" })
  .refine((value) => value.validTo === null || Date.parse(value.validTo) > Date.parse(value.validFrom), { message: "O fim deve ser posterior ao início" });

export const saveQuantityPricePromotionResponseSchema = z.object({
  data: quantityPricePromotionSchema.extend({ correlationId: z.uuid() }), request_id: z.string().min(1),
}).strict();
export type QuantityPricePromotion = z.infer<typeof quantityPricePromotionSchema>;
