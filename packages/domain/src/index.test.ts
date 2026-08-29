import { describe, expect, it } from "vitest";
import {
  addMoney,
  applyQuantityFixedPricePromotion,
  compareMoney,
  DomainError,
  formatMoneyBrl,
  isMoneyCents,
  moneyFromCents,
  multiplyMoney,
  parseBrlToCents,
  priceBaseCart,
  subtractMoney,
} from "./index";

function expectDomainError(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail(`Expected DomainError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    if (error instanceof DomainError) expect(error.code).toBe(code);
  }
}

describe("MoneyCents", () => {
  it("accepts only non-negative safe integer cents", () => {
    expect(moneyFromCents(0)).toBe(0);
    expect(moneyFromCents(1290)).toBe(1290);
    expect(moneyFromCents(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(isMoneyCents(1290)).toBe(true);

    for (const invalid of [-1, 12.9, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isMoneyCents(invalid)).toBe(false);
      expect(() => moneyFromCents(invalid)).toThrow(DomainError);
    }
  });

  it("parses canonical BRL decimal input without floating-point arithmetic", () => {
    expect(parseBrlToCents("12")).toBe(1200);
    expect(parseBrlToCents("12,9")).toBe(1290);
    expect(parseBrlToCents("12,90")).toBe(1290);
    expect(parseBrlToCents(" 12.90 ")).toBe(1290);
    expect(parseBrlToCents("0,01")).toBe(1);
  });

  it("rejects ambiguous or unsupported BRL input", () => {
    for (const invalid of ["", "R$ 12,90", "1.234,56", "12,901", "-12,90", "+12,90", "1e2", "0".repeat(19)]) {
      expect(() => parseBrlToCents(invalid)).toThrow(DomainError);
    }

    expectDomainError(() => parseBrlToCents("90071992547409,92"), "MONEY_OVERFLOW");
  });

  it("formats cents as BRL deterministically", () => {
    expect(formatMoneyBrl(moneyFromCents(0))).toBe("R$ 0,00");
    expect(formatMoneyBrl(moneyFromCents(1290))).toBe("R$ 12,90");
    expect(formatMoneyBrl(moneyFromCents(123456))).toBe("R$ 1.234,56");
  });

  it("performs checked arithmetic", () => {
    const tenReais = moneyFromCents(1000);
    const twoFifty = moneyFromCents(250);

    expect(addMoney(tenReais, twoFifty)).toBe(1250);
    expect(subtractMoney(tenReais, twoFifty)).toBe(750);
    expect(multiplyMoney(twoFifty, 3)).toBe(750);
    expect(multiplyMoney(twoFifty, 0)).toBe(0);
    expect(compareMoney(tenReais, twoFifty)).toBe(1);
    expect(compareMoney(twoFifty, tenReais)).toBe(-1);
    expect(compareMoney(tenReais, moneyFromCents(1000))).toBe(0);
  });

  it("rejects underflow, invalid quantity and arithmetic overflow", () => {
    expectDomainError(
      () => subtractMoney(moneyFromCents(100), moneyFromCents(101)),
      "MONEY_UNDERFLOW",
    );
    expectDomainError(
      () => multiplyMoney(moneyFromCents(100), 1.5),
      "INVALID_MONEY_QUANTITY",
    );
    expectDomainError(
      () => addMoney(moneyFromCents(Number.MAX_SAFE_INTEGER), moneyFromCents(1)),
      "INVALID_MONEY_CENTS",
    );
  });
});

describe("base cart pricing", () => {
  it("returns a zero quote for an empty cart", () => {
    expect(priceBaseCart([])).toEqual({
      lines: [],
      totalCents: 0,
      rounding: "NONE",
    });
  });

  it("prices one or more canonical lines deterministically", () => {
    expect(priceBaseCart([
      { productId: "product-a", unitPriceCents: moneyFromCents(1_250), quantity: 2 },
      { productId: "product-b", unitPriceCents: moneyFromCents(399), quantity: 3 },
    ])).toEqual({
      lines: [
        { productId: "product-a", unitPriceCents: 1_250, quantity: 2, subtotalCents: 2_500 },
        { productId: "product-b", unitPriceCents: 399, quantity: 3, subtotalCents: 1_197 },
      ],
      totalCents: 3_697,
      rounding: "NONE",
    });
  });

  it("rejects invalid quantities and product identifiers", () => {
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectDomainError(
        () => priceBaseCart([
          { productId: "product-a", unitPriceCents: moneyFromCents(100), quantity },
        ]),
        "INVALID_PRICING_QUANTITY",
      );
    }

    for (const productId of ["", " product-a", "product-a "]) {
      expectDomainError(
        () => priceBaseCart([
          { productId, unitPriceCents: moneyFromCents(100), quantity: 1 },
        ]),
        "INVALID_PRICING_PRODUCT_ID",
      );
    }
  });

  it("rejects duplicate products instead of silently aggregating them", () => {
    expectDomainError(
      () => priceBaseCart([
        { productId: "product-a", unitPriceCents: moneyFromCents(100), quantity: 1 },
        { productId: "product-a", unitPriceCents: moneyFromCents(200), quantity: 1 },
      ]),
      "DUPLICATE_PRICING_PRODUCT",
    );
  });

  it("fails closed when a line or cart total overflows safe integer cents", () => {
    expectDomainError(
      () => priceBaseCart([
        {
          productId: "product-a",
          unitPriceCents: moneyFromCents(Number.MAX_SAFE_INTEGER),
          quantity: 2,
        },
      ]),
      "INVALID_MONEY_CENTS",
    );

    expectDomainError(
      () => priceBaseCart([
        {
          productId: "product-a",
          unitPriceCents: moneyFromCents(Number.MAX_SAFE_INTEGER),
          quantity: 1,
        },
        { productId: "product-b", unitPriceCents: moneyFromCents(1), quantity: 1 },
      ]),
      "INVALID_MONEY_CENTS",
    );
  });
});

describe("QUANTIDADE_PRECO promotion", () => {
  const item = (quantity: number, unitPriceCents = 1_500) => ({
    productId: "product-a",
    unitPriceCents: moneyFromCents(unitPriceCents),
    quantity,
  });
  const rule = (overrides: Partial<Parameters<typeof applyQuantityFixedPricePromotion>[1]> = {}) => ({
    promotionId: "promotion-a",
    type: "QUANTIDADE_PRECO" as const,
    productId: "product-a",
    groupQuantity: 2,
    groupPriceCents: moneyFromCents(1_000),
    maxGroupsPerLine: null,
    ...overrides,
  });

  it("keeps quantities below the group at base price", () => {
    expect(applyQuantityFixedPricePromotion(item(1), rule())).toEqual({
      productId: "product-a",
      unitPriceCents: 1_500,
      quantity: 1,
      originalSubtotalCents: 1_500,
      discountCents: 0,
      effectiveSubtotalCents: 1_500,
      appliedPromotion: null,
      rounding: "NONE",
    });
  });

  it("applies one complete group", () => {
    expect(applyQuantityFixedPricePromotion(item(2), rule())).toMatchObject({
      originalSubtotalCents: 3_000,
      discountCents: 2_000,
      effectiveSubtotalCents: 1_000,
      appliedPromotion: {
        groups: 1,
        promotedQuantity: 2,
        remainderQuantity: 0,
        savingsCents: 2_000,
      },
    });
  });

  it("prices the required three-unit example as R$25", () => {
    expect(applyQuantityFixedPricePromotion(item(3), rule())).toEqual({
      productId: "product-a",
      unitPriceCents: 1_500,
      quantity: 3,
      originalSubtotalCents: 4_500,
      discountCents: 2_000,
      effectiveSubtotalCents: 2_500,
      appliedPromotion: {
        promotionId: "promotion-a",
        type: "QUANTIDADE_PRECO",
        groupQuantity: 2,
        groupPriceCents: 1_000,
        groups: 1,
        promotedQuantity: 2,
        remainderQuantity: 1,
        savingsCents: 2_000,
      },
      rounding: "NONE",
    });
  });

  it("forms the maximum number of groups and prices the remainder at base price", () => {
    expect(applyQuantityFixedPricePromotion(item(5), rule())).toMatchObject({
      originalSubtotalCents: 7_500,
      discountCents: 4_000,
      effectiveSubtotalCents: 3_500,
      appliedPromotion: {
        groups: 2,
        promotedQuantity: 4,
        remainderQuantity: 1,
        savingsCents: 4_000,
      },
    });
  });

  it("honors the persisted maximum number of groups per line", () => {
    expect(applyQuantityFixedPricePromotion(
      item(5),
      rule({ maxGroupsPerLine: 1 }),
    )).toMatchObject({
      originalSubtotalCents: 7_500,
      discountCents: 2_000,
      effectiveSubtotalCents: 5_500,
      appliedPromotion: {
        groups: 1,
        promotedQuantity: 2,
        remainderQuantity: 3,
        savingsCents: 2_000,
      },
    });
  });

  it("does not apply a valid rule to a different product", () => {
    expect(applyQuantityFixedPricePromotion(
      item(3, 100),
      rule({ productId: "product-b", groupPriceCents: moneyFromCents(1_000) }),
    )).toMatchObject({
      originalSubtotalCents: 300,
      discountCents: 0,
      effectiveSubtotalCents: 300,
      appliedPromotion: null,
    });
  });

  it("rejects invalid rules and promotions without a positive saving", () => {
    for (const groupQuantity of [0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectDomainError(
        () => applyQuantityFixedPricePromotion(item(2), rule({ groupQuantity })),
        "INVALID_PROMOTION_GROUP_QUANTITY",
      );
    }

    for (const groupPriceCents of [3_000, 3_001]) {
      expectDomainError(
        () => applyQuantityFixedPricePromotion(
          item(2),
          rule({ groupPriceCents: moneyFromCents(groupPriceCents) }),
        ),
        "INVALID_PROMOTION_GROUP_PRICE",
      );
    }

    for (const maxGroupsPerLine of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectDomainError(
        () => applyQuantityFixedPricePromotion(item(2), rule({ maxGroupsPerLine })),
        "INVALID_PROMOTION_GROUP_LIMIT",
      );
    }

    expectDomainError(
      () => applyQuantityFixedPricePromotion(item(2), rule({ promotionId: " promotion-a" })),
      "INVALID_PROMOTION_ID",
    );
    expectDomainError(
      () => applyQuantityFixedPricePromotion(item(2), rule({ productId: "" })),
      "INVALID_PROMOTION_PRODUCT_ID",
    );
  });

  it("fails closed on base or promotion arithmetic overflow", () => {
    expectDomainError(
      () => applyQuantityFixedPricePromotion(
        item(2, Number.MAX_SAFE_INTEGER),
        rule({ groupPriceCents: moneyFromCents(1) }),
      ),
      "INVALID_MONEY_CENTS",
    );

    expectDomainError(
      () => applyQuantityFixedPricePromotion(
        item(1, Math.ceil(Number.MAX_SAFE_INTEGER / 2)),
        rule({ groupPriceCents: moneyFromCents(1) }),
      ),
      "INVALID_MONEY_CENTS",
    );
  });
});
