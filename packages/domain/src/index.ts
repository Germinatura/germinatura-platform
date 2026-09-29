export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

declare const moneyCentsBrand: unique symbol;

export type MoneyCents = number & {
  readonly [moneyCentsBrand]: "MoneyCents";
};

const maxSafeMoneyCents = Number.MAX_SAFE_INTEGER;
const maxSafeMoneyCentsBigInt = BigInt(maxSafeMoneyCents);
const brlDecimalPattern = /^(\d+)(?:[,.](\d{1,2}))?$/;
const brlIntegerFormatter = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
  useGrouping: true,
});

export function isMoneyCents(value: unknown): value is MoneyCents {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  );
}

export function moneyFromCents(value: number): MoneyCents {
  if (!isMoneyCents(value)) {
    throw new DomainError(
      "INVALID_MONEY_CENTS",
      "Money must be a non-negative safe integer expressed in cents",
    );
  }

  return value;
}

export function parseBrlToCents(value: string): MoneyCents {
  const normalizedValue = value.trim();
  const match = normalizedValue.length <= 18
    ? brlDecimalPattern.exec(normalizedValue)
    : null;
  if (!match) {
    throw new DomainError(
      "INVALID_BRL_DECIMAL",
      "BRL input must use an ungrouped decimal value with at most two decimal places",
    );
  }

  const wholeReais = BigInt(match[1]);
  const fractionalDigits = match[2] ?? "";
  const fractionalCents = BigInt(fractionalDigits.padEnd(2, "0"));
  const cents = (wholeReais * 100n) + fractionalCents;

  if (cents > maxSafeMoneyCentsBigInt) {
    throw new DomainError(
      "MONEY_OVERFLOW",
      "Money exceeds the maximum safe amount in cents",
    );
  }

  return moneyFromCents(Number(cents));
}

export function formatMoneyBrl(value: MoneyCents): string {
  const cents = moneyFromCents(value);
  const wholeReais = Math.floor(cents / 100);
  const fractionalCents = (cents % 100).toString().padStart(2, "0");

  return `R$ ${brlIntegerFormatter.format(wholeReais)},${fractionalCents}`;
}

export function addMoney(left: MoneyCents, right: MoneyCents): MoneyCents {
  return moneyFromCents(moneyFromCents(left) + moneyFromCents(right));
}

export function subtractMoney(left: MoneyCents, right: MoneyCents): MoneyCents {
  const result = moneyFromCents(left) - moneyFromCents(right);
  if (result < 0) {
    throw new DomainError(
      "MONEY_UNDERFLOW",
      "Money subtraction cannot produce a negative amount",
    );
  }

  return moneyFromCents(result);
}

export function multiplyMoney(value: MoneyCents, quantity: number): MoneyCents {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new DomainError(
      "INVALID_MONEY_QUANTITY",
      "Money quantity must be a non-negative safe integer",
    );
  }

  return moneyFromCents(moneyFromCents(value) * quantity);
}

export function compareMoney(left: MoneyCents, right: MoneyCents): -1 | 0 | 1 {
  const leftCents = moneyFromCents(left);
  const rightCents = moneyFromCents(right);

  if (leftCents === rightCents) return 0;
  return leftCents < rightCents ? -1 : 1;
}

export interface BasePricingItemInput {
  readonly productId: string;
  readonly unitPriceCents: MoneyCents;
  readonly quantity: number;
}

export interface BasePricingLine {
  readonly productId: string;
  readonly unitPriceCents: MoneyCents;
  readonly quantity: number;
  readonly subtotalCents: MoneyCents;
}

export interface BaseCartQuote {
  readonly lines: readonly BasePricingLine[];
  readonly totalCents: MoneyCents;
  readonly rounding: "NONE";
}

export interface QuantityFixedPricePromotionRule {
  readonly promotionId: string;
  readonly type: "QUANTIDADE_PRECO";
  readonly productId: string;
  readonly groupQuantity: number;
  readonly groupPriceCents: MoneyCents;
  readonly maxGroupsPerLine: number | null;
}

export interface QuantityFixedPricePromotionExplanation {
  readonly promotionId: string;
  readonly type: "QUANTIDADE_PRECO";
  readonly groupQuantity: number;
  readonly groupPriceCents: MoneyCents;
  readonly groups: number;
  readonly promotedQuantity: number;
  readonly remainderQuantity: number;
  readonly savingsCents: MoneyCents;
}

export interface PercentagePromotionRule {
  readonly promotionId: string;
  readonly type: "PERCENTUAL";
  readonly productId: string;
  readonly percentageBasisPoints: number;
}

export interface FixedUnitPricePromotionRule {
  readonly promotionId: string;
  readonly type: "VALOR_FIXO_UNITARIO";
  readonly productId: string;
  readonly fixedUnitPriceCents: MoneyCents;
}

export interface PercentagePromotionExplanation {
  readonly promotionId: string;
  readonly type: "PERCENTUAL";
  readonly percentageBasisPoints: number;
  readonly discountedUnitPriceCents: MoneyCents;
  readonly savingsCents: MoneyCents;
}

export interface FixedUnitPricePromotionExplanation {
  readonly promotionId: string;
  readonly type: "VALOR_FIXO_UNITARIO";
  readonly fixedUnitPriceCents: MoneyCents;
  readonly savingsCents: MoneyCents;
}

/** LEVE_PAGUE: every complete group of buyQuantity units charges only payQuantity units. */
export interface BuyPayPromotionRule {
  readonly promotionId: string;
  readonly type: "LEVE_PAGUE";
  readonly productId: string;
  readonly buyQuantity: number;
  readonly payQuantity: number;
  readonly maxGroupsPerLine: number | null;
}

export interface BuyPayPromotionExplanation {
  readonly promotionId: string;
  readonly type: "LEVE_PAGUE";
  readonly buyQuantity: number;
  readonly payQuantity: number;
  readonly groups: number;
  readonly freeQuantity: number;
  readonly savingsCents: MoneyCents;
}

export interface PromotionTier {
  readonly minQuantity: number;
  readonly percentageBasisPoints: number;
}

/** ESCALONADA: the highest reached tier applies its percentage to every unit (PROMO-003 floor per unit). */
export interface TieredPromotionRule {
  readonly promotionId: string;
  readonly type: "ESCALONADA";
  readonly productId: string;
  readonly tiers: readonly PromotionTier[];
}

export interface TieredPromotionExplanation {
  readonly promotionId: string;
  readonly type: "ESCALONADA";
  readonly minQuantity: number;
  readonly percentageBasisPoints: number;
  readonly discountedUnitPriceCents: MoneyCents;
  readonly savingsCents: MoneyCents;
}

/** COMBO_MIX: a set of distinct products sold together for one price (PROMO-005 allocation). */
export interface ComboPromotionRule {
  readonly promotionId: string;
  readonly type: "COMBO_MIX";
  readonly components: readonly { readonly productId: string; readonly quantity: number }[];
  readonly comboPriceCents: MoneyCents;
  readonly maxCombosPerCart: number | null;
  readonly priority: number;
}

export interface ComboPromotionExplanation {
  readonly promotionId: string;
  readonly type: "COMBO_MIX";
  readonly comboPriceCents: MoneyCents;
  readonly combos: number;
  readonly componentQuantity: number;
  readonly savingsCents: MoneyCents;
}

export type CouponDiscount =
  | { readonly kind: "PERCENTUAL"; readonly percentageBasisPoints: number }
  | { readonly kind: "VALOR_FIXO"; readonly amountCents: MoneyCents };

/**
 * CUPOM (PROMO-006): only offered when its code was informed. A non-cumulative coupon competes for its
 * eligible lines like a combo; a cumulative coupon applies on top of the winning line promotions.
 */
export interface CouponPromotionRule {
  readonly promotionId: string;
  readonly type: "CUPOM";
  readonly code: string;
  readonly productIds: readonly string[];
  readonly discount: CouponDiscount;
  readonly cumulative: boolean;
  readonly priority: number;
}

export interface CouponPromotionExplanation {
  readonly promotionId: string;
  readonly type: "CUPOM";
  readonly code: string;
  readonly discountKind: CouponDiscount["kind"];
  readonly percentageBasisPoints: number | null;
  readonly amountCents: MoneyCents | null;
  readonly cumulative: boolean;
  readonly savingsCents: MoneyCents;
}

export type AppliedPromotionExplanation = QuantityFixedPricePromotionExplanation
  | PercentagePromotionExplanation | FixedUnitPricePromotionExplanation | BuyPayPromotionExplanation
  | TieredPromotionExplanation | ComboPromotionExplanation | CouponPromotionExplanation;

export type PricingRounding = "NONE" | "FLOOR_PER_UNIT" | "FLOOR_PER_LINE" | "FLOOR_PER_UNIT_AND_LINE";

export interface QuantityFixedPriceLineQuote {
  readonly productId: string;
  readonly unitPriceCents: MoneyCents;
  readonly quantity: number;
  readonly originalSubtotalCents: MoneyCents;
  readonly discountCents: MoneyCents;
  readonly effectiveSubtotalCents: MoneyCents;
  readonly appliedPromotion: AppliedPromotionExplanation | null;
  /** Cumulative coupon applied on top of appliedPromotion (PROMO-004 #4). */
  readonly appliedCoupon?: CouponPromotionExplanation | null;
  readonly rounding: PricingRounding;
}

export interface PrioritizedQuantityPromotionRule extends QuantityFixedPricePromotionRule {
  readonly priority: number;
}

export type PrioritizedPromotionRule =
  | PrioritizedQuantityPromotionRule
  | (PercentagePromotionRule & { readonly priority: number })
  | (FixedUnitPricePromotionRule & { readonly priority: number })
  | (BuyPayPromotionRule & { readonly priority: number })
  | (TieredPromotionRule & { readonly priority: number });

export type CartPromotionRule = PrioritizedPromotionRule | ComboPromotionRule | CouponPromotionRule;

export interface PromotedCartQuote {
  readonly lines: readonly QuantityFixedPriceLineQuote[];
  readonly originalTotalCents: MoneyCents;
  readonly discountTotalCents: MoneyCents;
  readonly totalCents: MoneyCents;
  readonly rounding: PricingRounding;
}

/**
 * Prices a canonical cart using unit prices already resolved by a trusted
 * server-side caller. This base slice performs only integer-cent arithmetic,
 * so no rounding is applied.
 */
export function priceBaseCart(items: readonly BasePricingItemInput[]): BaseCartQuote {
  const productIds = new Set<string>();
  const lines: BasePricingLine[] = [];
  let totalCents = moneyFromCents(0);

  for (const item of items) {
    if (item.productId.length === 0 || item.productId.trim() !== item.productId) {
      throw new DomainError(
        "INVALID_PRICING_PRODUCT_ID",
        "Pricing product ID must be a non-empty canonical identifier",
      );
    }
    if (productIds.has(item.productId)) {
      throw new DomainError(
        "DUPLICATE_PRICING_PRODUCT",
        "Pricing cart cannot contain duplicate product IDs",
      );
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new DomainError(
        "INVALID_PRICING_QUANTITY",
        "Pricing quantity must be a positive safe integer",
      );
    }

    productIds.add(item.productId);
    const unitPriceCents = moneyFromCents(item.unitPriceCents);
    const subtotalCents = multiplyMoney(unitPriceCents, item.quantity);
    totalCents = addMoney(totalCents, subtotalCents);
    lines.push({
      productId: item.productId,
      unitPriceCents,
      quantity: item.quantity,
      subtotalCents,
    });
  }

  return { lines, totalCents, rounding: "NONE" };
}

function assertCanonicalIdentifier(value: string, code: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new DomainError(code, `${label} must be a non-empty canonical identifier`);
  }
}

/**
 * Applies one canonical QUANTIDADE_PRECO rule to a trusted, server-priced
 * item. The maximum number of complete groups receives the fixed group price;
 * remaining units keep their base unit price. Arithmetic stays in integer
 * cents and therefore applies no rounding.
 */
export function applyQuantityFixedPricePromotion(
  item: BasePricingItemInput,
  rule: QuantityFixedPricePromotionRule,
): QuantityFixedPriceLineQuote {
  const baseLine = priceBaseCart([item]).lines[0];
  assertCanonicalIdentifier(
    rule.promotionId,
    "INVALID_PROMOTION_ID",
    "Promotion ID",
  );
  assertCanonicalIdentifier(
    rule.productId,
    "INVALID_PROMOTION_PRODUCT_ID",
    "Promotion product ID",
  );
  if (rule.type !== "QUANTIDADE_PRECO") {
    throw new DomainError(
      "INVALID_PROMOTION_TYPE",
      "Quantity fixed-price promotion must use QUANTIDADE_PRECO",
    );
  }
  if (!Number.isSafeInteger(rule.groupQuantity) || rule.groupQuantity < 2) {
    throw new DomainError(
      "INVALID_PROMOTION_GROUP_QUANTITY",
      "Promotion group quantity must be a safe integer of at least two",
    );
  }
  if (
    rule.maxGroupsPerLine !== null
    && (!Number.isSafeInteger(rule.maxGroupsPerLine) || rule.maxGroupsPerLine < 1)
  ) {
    throw new DomainError(
      "INVALID_PROMOTION_GROUP_LIMIT",
      "Promotion group limit must be null or a positive safe integer",
    );
  }

  const groupPriceCents = moneyFromCents(rule.groupPriceCents);
  if (rule.productId !== baseLine.productId) {
    return {
      productId: baseLine.productId,
      unitPriceCents: baseLine.unitPriceCents,
      quantity: baseLine.quantity,
      originalSubtotalCents: baseLine.subtotalCents,
      discountCents: moneyFromCents(0),
      effectiveSubtotalCents: baseLine.subtotalCents,
      appliedPromotion: null,
      rounding: "NONE",
    };
  }

  const baseGroupPriceCents = multiplyMoney(baseLine.unitPriceCents, rule.groupQuantity);
  if (compareMoney(groupPriceCents, baseGroupPriceCents) >= 0) {
    throw new DomainError(
      "INVALID_PROMOTION_GROUP_PRICE",
      "Promotion group price must produce a positive saving",
    );
  }

  const availableGroups = Math.floor(baseLine.quantity / rule.groupQuantity);
  const groups = rule.maxGroupsPerLine === null
    ? availableGroups
    : Math.min(availableGroups, rule.maxGroupsPerLine);
  if (groups === 0) {
    return {
      productId: baseLine.productId,
      unitPriceCents: baseLine.unitPriceCents,
      quantity: baseLine.quantity,
      originalSubtotalCents: baseLine.subtotalCents,
      discountCents: moneyFromCents(0),
      effectiveSubtotalCents: baseLine.subtotalCents,
      appliedPromotion: null,
      rounding: "NONE",
    };
  }

  const promotedQuantity = groups * rule.groupQuantity;
  const remainderQuantity = baseLine.quantity - promotedQuantity;
  const promotedSubtotalCents = multiplyMoney(groupPriceCents, groups);
  const remainderSubtotalCents = multiplyMoney(baseLine.unitPriceCents, remainderQuantity);
  const effectiveSubtotalCents = addMoney(promotedSubtotalCents, remainderSubtotalCents);
  const discountCents = subtractMoney(baseLine.subtotalCents, effectiveSubtotalCents);

  return {
    productId: baseLine.productId,
    unitPriceCents: baseLine.unitPriceCents,
    quantity: baseLine.quantity,
    originalSubtotalCents: baseLine.subtotalCents,
    discountCents,
    effectiveSubtotalCents,
    appliedPromotion: {
      promotionId: rule.promotionId,
      type: rule.type,
      groupQuantity: rule.groupQuantity,
      groupPriceCents,
      groups,
      promotedQuantity,
      remainderQuantity,
      savingsCents: discountCents,
    },
    rounding: "NONE",
  };
}

/** Customer-favorable rounding: the discounted unit price is floored to the cent. */
function flooredPercentageUnitPrice(unitPriceCents: MoneyCents, basisPoints: number): MoneyCents {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 1 || basisPoints > 9_999) {
    throw new DomainError("INVALID_PROMOTION_PERCENTAGE", "Promotion percentage must be between 0.01% and 99.99%");
  }
  const numerator = BigInt(unitPriceCents) * BigInt(10_000 - basisPoints);
  return moneyFromCents(Number(numerator / 10_000n));
}

export function applyUnitPromotion(
  item: BasePricingItemInput,
  rule: PercentagePromotionRule | FixedUnitPricePromotionRule,
): QuantityFixedPriceLineQuote {
  const baseLine = priceBaseCart([item]).lines[0];
  assertCanonicalIdentifier(rule.promotionId, "INVALID_PROMOTION_ID", "Promotion ID");
  assertCanonicalIdentifier(rule.productId, "INVALID_PROMOTION_PRODUCT_ID", "Promotion product ID");
  if (rule.productId !== baseLine.productId) {
    return {
      productId: baseLine.productId, unitPriceCents: baseLine.unitPriceCents,
      quantity: baseLine.quantity, originalSubtotalCents: baseLine.subtotalCents,
      discountCents: moneyFromCents(0), effectiveSubtotalCents: baseLine.subtotalCents,
      appliedPromotion: null, rounding: "NONE",
    };
  }

  let effectiveUnitPriceCents: MoneyCents;
  let explanation: PercentagePromotionExplanation | FixedUnitPricePromotionExplanation;
  if (rule.type === "PERCENTUAL") {
    effectiveUnitPriceCents = flooredPercentageUnitPrice(baseLine.unitPriceCents, rule.percentageBasisPoints);
    explanation = {
      promotionId: rule.promotionId, type: rule.type,
      percentageBasisPoints: rule.percentageBasisPoints,
      discountedUnitPriceCents: effectiveUnitPriceCents,
      savingsCents: moneyFromCents(0),
    };
  } else {
    effectiveUnitPriceCents = moneyFromCents(rule.fixedUnitPriceCents);
    if (compareMoney(effectiveUnitPriceCents, baseLine.unitPriceCents) >= 0) {
      throw new DomainError("INVALID_PROMOTION_FIXED_PRICE", "Promotion unit price must produce a positive saving");
    }
    explanation = {
      promotionId: rule.promotionId, type: rule.type,
      fixedUnitPriceCents: effectiveUnitPriceCents, savingsCents: moneyFromCents(0),
    };
  }
  const effectiveSubtotalCents = multiplyMoney(effectiveUnitPriceCents, baseLine.quantity);
  const discountCents = subtractMoney(baseLine.subtotalCents, effectiveSubtotalCents);
  if (discountCents === 0) {
    return {
      productId: baseLine.productId, unitPriceCents: baseLine.unitPriceCents,
      quantity: baseLine.quantity, originalSubtotalCents: baseLine.subtotalCents,
      discountCents, effectiveSubtotalCents: baseLine.subtotalCents,
      appliedPromotion: null, rounding: "NONE",
    };
  }
  return {
    productId: baseLine.productId, unitPriceCents: baseLine.unitPriceCents,
    quantity: baseLine.quantity, originalSubtotalCents: baseLine.subtotalCents,
    discountCents, effectiveSubtotalCents,
    appliedPromotion: { ...explanation, savingsCents: discountCents },
    rounding: rule.type === "PERCENTUAL" ? "FLOOR_PER_UNIT" : "NONE",
  };
}

export function applyBuyPayPromotion(
  item: BasePricingItemInput,
  rule: BuyPayPromotionRule,
): QuantityFixedPriceLineQuote {
  const baseLine = priceBaseCart([item]).lines[0];
  assertCanonicalIdentifier(rule.promotionId, "INVALID_PROMOTION_ID", "Promotion ID");
  assertCanonicalIdentifier(rule.productId, "INVALID_PROMOTION_PRODUCT_ID", "Promotion product ID");
  if (!Number.isSafeInteger(rule.buyQuantity) || rule.buyQuantity < 2) {
    throw new DomainError("INVALID_PROMOTION_BUY_QUANTITY", "Buy quantity must be a safe integer of at least two");
  }
  if (!Number.isSafeInteger(rule.payQuantity) || rule.payQuantity < 1 || rule.payQuantity >= rule.buyQuantity) {
    throw new DomainError("INVALID_PROMOTION_PAY_QUANTITY", "Pay quantity must be at least one and below the buy quantity");
  }
  if (rule.maxGroupsPerLine !== null && (!Number.isSafeInteger(rule.maxGroupsPerLine) || rule.maxGroupsPerLine < 1)) {
    throw new DomainError("INVALID_PROMOTION_GROUP_LIMIT", "Promotion group limit must be null or a positive safe integer");
  }
  const unchanged: QuantityFixedPriceLineQuote = {
    productId: baseLine.productId, unitPriceCents: baseLine.unitPriceCents,
    quantity: baseLine.quantity, originalSubtotalCents: baseLine.subtotalCents,
    discountCents: moneyFromCents(0), effectiveSubtotalCents: baseLine.subtotalCents,
    appliedPromotion: null, rounding: "NONE",
  };
  if (rule.productId !== baseLine.productId) return unchanged;
  const availableGroups = Math.floor(baseLine.quantity / rule.buyQuantity);
  const groups = rule.maxGroupsPerLine === null ? availableGroups : Math.min(availableGroups, rule.maxGroupsPerLine);
  const freeQuantity = groups * (rule.buyQuantity - rule.payQuantity);
  const discountCents = multiplyMoney(baseLine.unitPriceCents, freeQuantity);
  if (discountCents === 0) return unchanged;
  return {
    ...unchanged,
    discountCents,
    effectiveSubtotalCents: subtractMoney(baseLine.subtotalCents, discountCents),
    appliedPromotion: {
      promotionId: rule.promotionId, type: rule.type, buyQuantity: rule.buyQuantity,
      payQuantity: rule.payQuantity, groups, freeQuantity, savingsCents: discountCents,
    },
  };
}

export function applyTieredPromotion(
  item: BasePricingItemInput,
  rule: TieredPromotionRule,
): QuantityFixedPriceLineQuote {
  const baseLine = priceBaseCart([item]).lines[0];
  assertCanonicalIdentifier(rule.promotionId, "INVALID_PROMOTION_ID", "Promotion ID");
  assertCanonicalIdentifier(rule.productId, "INVALID_PROMOTION_PRODUCT_ID", "Promotion product ID");
  if (rule.tiers.length < 1 || rule.tiers.length > 10) {
    throw new DomainError("INVALID_PROMOTION_TIERS", "Tiered promotion needs between one and ten tiers");
  }
  rule.tiers.forEach((tier, index) => {
    const previous = rule.tiers[index - 1];
    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity < 2
      || !Number.isSafeInteger(tier.percentageBasisPoints) || tier.percentageBasisPoints < 1 || tier.percentageBasisPoints > 9_999
      || (previous && (tier.minQuantity <= previous.minQuantity || tier.percentageBasisPoints <= previous.percentageBasisPoints))) {
      throw new DomainError("INVALID_PROMOTION_TIERS", "Tiers must grow in quantity and discount");
    }
  });
  const unchanged: QuantityFixedPriceLineQuote = {
    productId: baseLine.productId, unitPriceCents: baseLine.unitPriceCents,
    quantity: baseLine.quantity, originalSubtotalCents: baseLine.subtotalCents,
    discountCents: moneyFromCents(0), effectiveSubtotalCents: baseLine.subtotalCents,
    appliedPromotion: null, rounding: "NONE",
  };
  if (rule.productId !== baseLine.productId) return unchanged;
  const tier = [...rule.tiers].reverse().find((candidate) => candidate.minQuantity <= baseLine.quantity);
  if (!tier) return unchanged;
  const discountedUnitPriceCents = flooredPercentageUnitPrice(baseLine.unitPriceCents, tier.percentageBasisPoints);
  const effectiveSubtotalCents = multiplyMoney(discountedUnitPriceCents, baseLine.quantity);
  const discountCents = subtractMoney(baseLine.subtotalCents, effectiveSubtotalCents);
  if (discountCents === 0) return unchanged;
  return {
    ...unchanged, discountCents, effectiveSubtotalCents,
    appliedPromotion: {
      promotionId: rule.promotionId, type: rule.type, minQuantity: tier.minQuantity,
      percentageBasisPoints: tier.percentageBasisPoints, discountedUnitPriceCents, savingsCents: discountCents,
    },
    rounding: "FLOOR_PER_UNIT",
  };
}

/** PROMO-004: code-unit order, matching PostgreSQL's byte-wise UUID ordering and independent of locale. */
function compareIdentifiers(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validateComboRule(rule: ComboPromotionRule): void {
  assertCanonicalIdentifier(rule.promotionId, "INVALID_PROMOTION_ID", "Promotion ID");
  const productIds = new Set(rule.components.map((component) => component.productId));
  if (rule.components.length < 2 || rule.components.length > 10 || productIds.size !== rule.components.length
    || rule.components.some((component) => !Number.isSafeInteger(component.quantity) || component.quantity < 1 || component.quantity > 1_000)
    || (rule.maxCombosPerCart !== null && (!Number.isSafeInteger(rule.maxCombosPerCart) || rule.maxCombosPerCart < 1))) {
    throw new DomainError("INVALID_PROMOTION_COMBO", "Combo needs 2 to 10 distinct components with positive quantities");
  }
}

/**
 * PROMO-005: splits a combo discount across its lines proportionally to each line's full value in the
 * combo; leftover cents follow the largest remainder, then the higher value, then the product ID.
 */
export function allocateComboDiscount(
  discountCents: MoneyCents,
  shares: readonly { readonly productId: string; readonly valueCents: MoneyCents }[],
): Map<string, MoneyCents> {
  const total = shares.reduce((sum, share) => sum + BigInt(share.valueCents), 0n);
  const discount = BigInt(discountCents);
  if (total === 0n || discount < 0n || discount > total) {
    throw new DomainError("INVALID_PROMOTION_COMBO_ALLOCATION", "Combo discount must fit inside the combo value");
  }
  const parts = shares.map((share) => ({
    ...share,
    floor: (discount * BigInt(share.valueCents)) / total,
    remainder: (discount * BigInt(share.valueCents)) % total,
  }));
  let leftover = discount - parts.reduce((sum, part) => sum + part.floor, 0n);
  const order = [...parts].sort((left, right) => (
    left.remainder === right.remainder
      ? (right.valueCents - left.valueCents) || compareIdentifiers(left.productId, right.productId)
      : left.remainder < right.remainder ? 1 : -1
  ));
  const allocation = new Map(parts.map((part) => [part.productId, part.floor]));
  for (const part of order) {
    if (leftover === 0n) break;
    allocation.set(part.productId, allocation.get(part.productId)! + 1n);
    leftover -= 1n;
  }
  return new Map([...allocation].map(([productId, cents]) => [productId, moneyFromCents(Number(cents))]));
}

function bestLineQuote(line: BasePricingLine, rules: readonly PrioritizedPromotionRule[]) {
  const candidates = rules
    .filter((rule) => rule.productId === line.productId)
    .map((rule) => ({ rule, quote: rule.type === "QUANTIDADE_PRECO"
      ? applyQuantityFixedPricePromotion(line, rule)
      : rule.type === "LEVE_PAGUE" ? applyBuyPayPromotion(line, rule)
        : rule.type === "ESCALONADA" ? applyTieredPromotion(line, rule) : applyUnitPromotion(line, rule) }))
    .filter(({ quote }) => quote.appliedPromotion !== null)
    .sort((left, right) => (
      right.rule.priority - left.rule.priority
      || left.quote.effectiveSubtotalCents - right.quote.effectiveSubtotalCents
      || compareIdentifiers(left.rule.promotionId, right.rule.promotionId)
    ));
  const winner = candidates[0];
  const quote: QuantityFixedPriceLineQuote = winner?.quote ?? {
    productId: line.productId, unitPriceCents: line.unitPriceCents, quantity: line.quantity,
    originalSubtotalCents: line.subtotalCents, discountCents: moneyFromCents(0),
    effectiveSubtotalCents: line.subtotalCents, appliedPromotion: null, rounding: "NONE",
  };
  return { quote, priority: winner?.rule.priority ?? null, promotionId: winner?.rule.promotionId ?? null };
}

function validateCouponRule(rule: CouponPromotionRule): void {
  assertCanonicalIdentifier(rule.promotionId, "INVALID_PROMOTION_ID", "Promotion ID");
  const discount = rule.discount;
  if (rule.productIds.length < 1 || new Set(rule.productIds).size !== rule.productIds.length
    || (discount.kind === "PERCENTUAL" && (!Number.isSafeInteger(discount.percentageBasisPoints)
      || discount.percentageBasisPoints < 1 || discount.percentageBasisPoints > 9_999))
    || (discount.kind === "VALOR_FIXO" && (!Number.isSafeInteger(discount.amountCents) || discount.amountCents < 1))) {
    throw new DomainError("INVALID_PROMOTION_COUPON", "Coupon needs eligible products and a positive discount");
  }
}

function couponExplanation(rule: CouponPromotionRule, savingsCents: MoneyCents): CouponPromotionExplanation {
  return {
    promotionId: rule.promotionId, type: rule.type, code: rule.code, discountKind: rule.discount.kind,
    percentageBasisPoints: rule.discount.kind === "PERCENTUAL" ? rule.discount.percentageBasisPoints : null,
    amountCents: rule.discount.kind === "VALOR_FIXO" ? rule.discount.amountCents : null,
    cumulative: rule.cumulative, savingsCents,
  };
}

/** Coupon discount per line over the given line values. PERCENTUAL floors the resulting price. */
function couponDiscounts(
  rule: CouponPromotionRule,
  lines: readonly { readonly productId: string; readonly valueCents: MoneyCents; readonly unitPriceCents: MoneyCents; readonly quantity: number }[],
  perUnit: boolean,
): Map<string, MoneyCents> {
  const discount = rule.discount;
  if (discount.kind === "PERCENTUAL") {
    return new Map(lines.map((line) => {
      const discounted = perUnit
        ? multiplyMoney(flooredPercentageUnitPrice(line.unitPriceCents, discount.percentageBasisPoints), line.quantity)
        : flooredPercentageUnitPrice(line.valueCents, discount.percentageBasisPoints);
      return [line.productId, subtractMoney(line.valueCents, discounted)];
    }));
  }
  const total = lines.reduce((sum, line) => addMoney(sum, line.valueCents), moneyFromCents(0));
  if (total === 0) return new Map(lines.map((line) => [line.productId, moneyFromCents(0)]));
  const amount = compareMoney(discount.amountCents, total) > 0 ? total : discount.amountCents;
  return allocateComboDiscount(amount, lines.map((line) => ({ productId: line.productId, valueCents: line.valueCents })));
}

type SetCandidate =
  | { readonly kind: "COMBO"; readonly rule: ComboPromotionRule; readonly saving: number }
  | { readonly kind: "COUPON"; readonly rule: CouponPromotionRule; readonly saving: number };

/**
 * PROMO-004/005/006: every line keeps at most one winning rule. Line rules pick by priority, lowest total
 * and stable ID. Set rules (combos and non-cumulative coupons) are then tried by priority, larger saving
 * and ID; a set rule takes its lines when its priority beats their line winners, or ties with a lower
 * cart total, or ties on both with a smaller ID. A line joins at most one set rule; units of a combo line
 * outside the combos keep the base price. Finally a cumulative coupon applies on top of the line totals.
 */
export function priceCartWithPromotions(
  items: readonly BasePricingItemInput[],
  rules: readonly CartPromotionRule[],
): PromotedCartQuote {
  const base = priceBaseCart(items);
  const lineRules = rules.filter((rule): rule is PrioritizedPromotionRule => rule.type !== "COMBO_MIX" && rule.type !== "CUPOM");
  const baseByProduct = new Map(base.lines.map((line) => [line.productId, line]));
  const best = new Map(base.lines.map((line) => [line.productId, bestLineQuote(line, lineRules)]));
  const coupons = rules.filter((rule): rule is CouponPromotionRule => rule.type === "CUPOM")
    .filter((rule, index, all) => all.findIndex((other) => other.promotionId === rule.promotionId) === index);
  if (coupons.length > 1) throw new DomainError("MULTIPLE_COUPONS", "At most one coupon can be priced");
  coupons.forEach(validateCouponRule);

  const setCandidates: SetCandidate[] = [];
  for (const rule of rules.filter((candidate): candidate is ComboPromotionRule => candidate.type === "COMBO_MIX")
    .filter((rule, index, all) => all.findIndex((other) => other.promotionId === rule.promotionId) === index)) {
    validateComboRule(rule);
    if (!rule.components.every((component) => baseByProduct.has(component.productId))) continue;
    const fullValue = rule.components.reduce((sum, component) => addMoney(sum,
      multiplyMoney(baseByProduct.get(component.productId)!.unitPriceCents, component.quantity)), moneyFromCents(0));
    if (compareMoney(moneyFromCents(rule.comboPriceCents), fullValue) >= 0) {
      throw new DomainError("INVALID_PROMOTION_COMBO_PRICE", "Combo price must produce a positive saving");
    }
    setCandidates.push({ kind: "COMBO", rule, saving: fullValue - rule.comboPriceCents });
  }
  for (const rule of coupons.filter((coupon) => !coupon.cumulative)) {
    const eligible = base.lines.filter((line) => rule.productIds.includes(line.productId));
    if (!eligible.length) continue;
    const discounts = couponDiscounts(rule, eligible.map((line) => ({ productId: line.productId,
      valueCents: line.subtotalCents, unitPriceCents: line.unitPriceCents, quantity: line.quantity })), true);
    setCandidates.push({ kind: "COUPON", rule, saving: [...discounts.values()].reduce((sum, value) => sum + value, 0) });
  }
  setCandidates.sort((left, right) => right.rule.priority - left.rule.priority || right.saving - left.saving
    || compareIdentifiers(left.rule.promotionId, right.rule.promotionId));

  const setLines = new Map<string, QuantityFixedPriceLineQuote>();
  for (const candidate of setCandidates) {
    let lineDiscounts: Map<string, MoneyCents>;
    let explain: (productId: string, discount: MoneyCents) => AppliedPromotionExplanation;
    let rounding: PricingRounding = "NONE";
    if (candidate.kind === "COMBO") {
      const rule = candidate.rule;
      if (rule.components.some((component) => setLines.has(component.productId))) continue;
      const available = Math.min(...rule.components.map((component) =>
        Math.floor(baseByProduct.get(component.productId)!.quantity / component.quantity)));
      const count = rule.maxCombosPerCart === null ? available : Math.min(available, rule.maxCombosPerCart);
      if (count === 0) continue;
      const shares = rule.components.map((component) => ({ productId: component.productId,
        valueCents: multiplyMoney(baseByProduct.get(component.productId)!.unitPriceCents, component.quantity * count) }));
      const comboValue = shares.reduce((sum, share) => addMoney(sum, share.valueCents), moneyFromCents(0));
      lineDiscounts = allocateComboDiscount(subtractMoney(comboValue, multiplyMoney(moneyFromCents(rule.comboPriceCents), count)), shares);
      const quantities = new Map(rule.components.map((component) => [component.productId, component.quantity * count]));
      explain = (productId, discount) => ({ promotionId: rule.promotionId, type: rule.type,
        comboPriceCents: moneyFromCents(rule.comboPriceCents), combos: count,
        componentQuantity: quantities.get(productId)!, savingsCents: discount });
    } else {
      const rule = candidate.rule;
      const eligible = base.lines.filter((line) => rule.productIds.includes(line.productId) && !setLines.has(line.productId));
      if (!eligible.length) continue;
      lineDiscounts = couponDiscounts(rule, eligible.map((line) => ({ productId: line.productId,
        valueCents: line.subtotalCents, unitPriceCents: line.unitPriceCents, quantity: line.quantity })), true);
      if (![...lineDiscounts.values()].some((value) => value > 0)) continue;
      explain = (_productId, discount) => couponExplanation(rule, discount);
      rounding = rule.discount.kind === "PERCENTUAL" ? "FLOOR_PER_UNIT" : "NONE";
    }
    const productIds = [...lineDiscounts.keys()];
    const lineWinners = productIds.map((productId) => best.get(productId)!);
    const withRule = productIds.reduce((sum, productId) => sum + baseByProduct.get(productId)!.subtotalCents - lineDiscounts.get(productId)!, 0);
    const withoutRule = lineWinners.reduce((sum, line) => sum + line.quote.effectiveSubtotalCents, 0);
    const linePriorities = lineWinners.flatMap((line) => line.priority === null ? [] : [line.priority]);
    const linePriority = linePriorities.length ? Math.max(...linePriorities) : null;
    const lineIds = lineWinners.flatMap((line) => line.promotionId === null ? [] : [line.promotionId]).sort(compareIdentifiers);
    const wins = linePriority === null || candidate.rule.priority > linePriority
      || (candidate.rule.priority === linePriority && (withRule < withoutRule
        || (withRule === withoutRule && compareIdentifiers(candidate.rule.promotionId, lineIds[0]) < 0)));
    if (!wins) continue;
    for (const productId of productIds) {
      const line = baseByProduct.get(productId)!;
      const lineDiscount = lineDiscounts.get(productId)!;
      setLines.set(productId, {
        productId, unitPriceCents: line.unitPriceCents, quantity: line.quantity,
        originalSubtotalCents: line.subtotalCents, discountCents: lineDiscount,
        effectiveSubtotalCents: subtractMoney(line.subtotalCents, lineDiscount),
        appliedPromotion: explain(productId, lineDiscount), rounding,
      });
    }
  }

  let lines: QuantityFixedPriceLineQuote[] = base.lines.map((line) => setLines.get(line.productId) ?? best.get(line.productId)!.quote);
  const cumulative = coupons.find((coupon) => coupon.cumulative);
  if (cumulative) {
    const eligible = lines.filter((line) => cumulative.productIds.includes(line.productId));
    const discounts = couponDiscounts(cumulative, eligible.map((line) => ({ productId: line.productId,
      valueCents: line.effectiveSubtotalCents, unitPriceCents: line.unitPriceCents, quantity: line.quantity })), false);
    lines = lines.map((line) => {
      const couponDiscount = discounts.get(line.productId);
      if (couponDiscount === undefined || couponDiscount === 0) return line;
      const perLine = cumulative.discount.kind === "PERCENTUAL";
      const rounding: PricingRounding = !perLine ? line.rounding
        : line.rounding === "FLOOR_PER_UNIT" ? "FLOOR_PER_UNIT_AND_LINE" : "FLOOR_PER_LINE";
      return {
        ...line,
        discountCents: addMoney(line.discountCents, couponDiscount),
        effectiveSubtotalCents: subtractMoney(line.effectiveSubtotalCents, couponDiscount),
        appliedCoupon: couponExplanation(cumulative, couponDiscount),
        rounding,
      };
    });
  }

  let originalTotalCents = moneyFromCents(0);
  let discountTotalCents = moneyFromCents(0);
  let totalCents = moneyFromCents(0);
  for (const line of lines) {
    originalTotalCents = addMoney(originalTotalCents, line.originalSubtotalCents);
    discountTotalCents = addMoney(discountTotalCents, line.discountCents);
    totalCents = addMoney(totalCents, line.effectiveSubtotalCents);
  }
  const perUnit = lines.some((line) => line.rounding === "FLOOR_PER_UNIT" || line.rounding === "FLOOR_PER_UNIT_AND_LINE");
  const perLine = lines.some((line) => line.rounding === "FLOOR_PER_LINE" || line.rounding === "FLOOR_PER_UNIT_AND_LINE");
  const rounding: PricingRounding = perUnit && perLine ? "FLOOR_PER_UNIT_AND_LINE" : perUnit ? "FLOOR_PER_UNIT" : perLine ? "FLOOR_PER_LINE" : "NONE";
  return { lines, originalTotalCents, discountTotalCents, totalCents, rounding };
}

export function priceCartWithQuantityPromotions(
  items: readonly BasePricingItemInput[],
  rules: readonly PrioritizedQuantityPromotionRule[],
): PromotedCartQuote {
  return priceCartWithPromotions(items, rules);
}
export * from "./csv";
