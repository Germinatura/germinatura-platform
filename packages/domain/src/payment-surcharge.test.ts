import { describe, expect, it } from "vitest";
import { computePaymentSurchargeCents, paymentSurchargeMethodFor } from "./payment-surcharge";

describe("payment surcharge", () => {
  it("floors percentages to the cent", () => {
    expect(computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 349 }, 2_590)).toBe(90);
    expect(computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 250 }, 1_999)).toBe(49);
    expect(computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 1 }, 9_999)).toBe(0);
    expect(computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 10_000 }, 1)).toBe(1);
    expect(computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 9_999 }, Number.MAX_SAFE_INTEGER)).toBe(9_006_298_534_815_516);
  });

  it("charges a fixed acréscimo once and nothing on a zero base or NONE", () => {
    expect(computePaymentSurchargeCents({ mode: "FIXED", fixedCents: 150 }, 1)).toBe(150);
    expect(computePaymentSurchargeCents({ mode: "FIXED", fixedCents: 150 }, 0)).toBe(0);
    expect(computePaymentSurchargeCents({ mode: "NONE" }, 5_000)).toBe(0);
  });

  it("refuses invalid inputs instead of guessing", () => {
    expect(() => computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 0 }, 100)).toThrow(RangeError);
    expect(() => computePaymentSurchargeCents({ mode: "PERCENTAGE", rateBps: 10.5 }, 100)).toThrow(RangeError);
    expect(() => computePaymentSurchargeCents({ mode: "FIXED", fixedCents: 0 }, 100)).toThrow(RangeError);
    expect(() => computePaymentSurchargeCents({ mode: "NONE" }, 10.5)).toThrow(RangeError);
  });

  it("maps PDV channels to surcharge methods; vouchers and links are not eligible", () => {
    expect(paymentSurchargeMethodFor("DINHEIRO")).toBe("DINHEIRO");
    expect(paymentSurchargeMethodFor("PIX_AREA")).toBe("PIX");
    expect(paymentSurchargeMethodFor("MAQUININHA", "CREDITO")).toBe("CREDITO");
    expect(paymentSurchargeMethodFor("MAQUININHA", "DEBITO")).toBe("DEBITO");
    expect(paymentSurchargeMethodFor("MAQUININHA", "VOUCHER_REFEICAO")).toBeNull();
    expect(paymentSurchargeMethodFor("MAQUININHA", null)).toBeNull();
    expect(paymentSurchargeMethodFor("PAYMENT_LINK")).toBeNull();
  });
});
