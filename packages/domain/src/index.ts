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

export interface QuantityFixedPriceLineQuote {
  readonly productId: string;
  readonly unitPriceCents: MoneyCents;
  readonly quantity: number;
  readonly originalSubtotalCents: MoneyCents;
  readonly discountCents: MoneyCents;
  readonly effectiveSubtotalCents: MoneyCents;
  readonly appliedPromotion: QuantityFixedPricePromotionExplanation | null;
  readonly rounding: "NONE";
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

  const groups = Math.floor(baseLine.quantity / rule.groupQuantity);
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
