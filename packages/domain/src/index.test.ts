import { describe, expect, it } from "vitest";
import {
  addMoney,
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
