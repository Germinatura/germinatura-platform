import { z } from "zod";

// Snapshot written by private.price_sale_items for the single winning rule of a line (PROMO-004).
export const promotionSnapshotSchema = z.discriminatedUnion("type", [
  z.object({
    promotion_id: z.uuid(), type: z.literal("QUANTIDADE_PRECO"), priority: z.number().int(),
    group_quantity: z.number().int().min(2), group_price_cents: z.number().int().nonnegative(),
    max_groups_per_line: z.number().int().positive().nullable(), groups: z.number().int().positive(),
    promoted_quantity: z.number().int().positive(), remainder_quantity: z.number().int().nonnegative(),
    savings_cents: z.number().int().nonnegative(),
  }),
  z.object({
    promotion_id: z.uuid(), type: z.literal("PERCENTUAL"), priority: z.number().int(),
    percentage_basis_points: z.number().int().min(1).max(9_999),
    discounted_unit_price_cents: z.number().int().nonnegative(), savings_cents: z.number().int().positive(),
  }),
  z.object({
    promotion_id: z.uuid(), type: z.literal("VALOR_FIXO_UNITARIO"), priority: z.number().int(),
    fixed_unit_price_cents: z.number().int().nonnegative(), savings_cents: z.number().int().positive(),
  }),
  z.object({
    promotion_id: z.uuid(), type: z.literal("LEVE_PAGUE"), priority: z.number().int(),
    buy_quantity: z.number().int().min(2), pay_quantity: z.number().int().positive(),
    max_groups_per_line: z.number().int().positive().nullable(), groups: z.number().int().positive(),
    free_quantity: z.number().int().positive(), savings_cents: z.number().int().positive(),
  }),
  z.object({
    promotion_id: z.uuid(), type: z.literal("ESCALONADA"), priority: z.number().int(),
    min_quantity: z.number().int().min(2), percentage_basis_points: z.number().int().min(1).max(9_999),
    discounted_unit_price_cents: z.number().int().nonnegative(), savings_cents: z.number().int().positive(),
  }),
  z.object({
    promotion_id: z.uuid(), type: z.literal("COMBO_MIX"), priority: z.number().int(),
    combo_price_cents: z.number().int().nonnegative(), combos: z.number().int().positive(),
    component_quantity: z.number().int().positive(), savings_cents: z.number().int().nonnegative(),
  }),
]);

export type PromotionSnapshot = z.infer<typeof promotionSnapshotSchema>;

/** Maps the stored snapshot to the public quote explanation. */
export function publicPromotion(value: PromotionSnapshot) {
  switch (value.type) {
    case "QUANTIDADE_PRECO":
      return { promotionId: value.promotion_id, type: value.type, groupQuantity: value.group_quantity,
        groupPriceCents: value.group_price_cents, groups: value.groups, promotedQuantity: value.promoted_quantity,
        remainderQuantity: value.remainder_quantity, savingsCents: value.savings_cents };
    case "PERCENTUAL":
      return { promotionId: value.promotion_id, type: value.type, percentageBasisPoints: value.percentage_basis_points,
        discountedUnitPriceCents: value.discounted_unit_price_cents, savingsCents: value.savings_cents };
    case "VALOR_FIXO_UNITARIO":
      return { promotionId: value.promotion_id, type: value.type, fixedUnitPriceCents: value.fixed_unit_price_cents,
        savingsCents: value.savings_cents };
    case "LEVE_PAGUE":
      return { promotionId: value.promotion_id, type: value.type, buyQuantity: value.buy_quantity,
        payQuantity: value.pay_quantity, groups: value.groups, freeQuantity: value.free_quantity,
        savingsCents: value.savings_cents };
    case "ESCALONADA":
      return { promotionId: value.promotion_id, type: value.type, minQuantity: value.min_quantity,
        percentageBasisPoints: value.percentage_basis_points,
        discountedUnitPriceCents: value.discounted_unit_price_cents, savingsCents: value.savings_cents };
    case "COMBO_MIX":
      return { promotionId: value.promotion_id, type: value.type, comboPriceCents: value.combo_price_cents,
        combos: value.combos, componentQuantity: value.component_quantity, savingsCents: value.savings_cents };
  }
}
