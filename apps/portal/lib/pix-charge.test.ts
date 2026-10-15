import { describe, expect, it } from "vitest";
import { pixChargeAmount, pixChargeFor } from "./pix-charge";

// Fictitious receiver for tests only.
const env = { PICPAY_PIX_KEY: "123e4567-e12b-12d1-a456-426655440000", PICPAY_PIX_MERCHANT_NAME: "Comissao Teste", PICPAY_PIX_MERCHANT_CITY: "Sao Paulo" };
const saleId = "71000000-0000-4000-8000-000000000001";
// The amount field (54) right after the currency (53 = 986), read by its declared length.
const amountOf = (payload: string) => {
  const start = payload.indexOf("5303986") + 7;
  const length = Number(payload.slice(start + 2, start + 4));
  return payload.slice(start, start + 2) === "54" ? payload.slice(start + 4, start + 4 + length) : undefined;
};

describe("PDV Pix charge", () => {
  it("charges the sale total when there is no Pix acréscimo", () => {
    expect(pixChargeAmount({ saleTotalCents: 2590, rule: { mode: "NONE", rateBps: null, fixedCents: null }, waive: false }))
      .toEqual({ productCents: 2590, surchargeCents: 0, amountCents: 2590 });
  });

  it("adds a percentage acréscimo floored to the cent, and a fixed one once", () => {
    expect(pixChargeAmount({ saleTotalCents: 2590, rule: { mode: "PERCENTAGE", rateBps: 100, fixedCents: null }, waive: false }))
      .toEqual({ productCents: 2590, surchargeCents: 25, amountCents: 2615 });
    expect(pixChargeAmount({ saleTotalCents: 2590, rule: { mode: "FIXED", rateBps: null, fixedCents: 150 }, waive: false }))
      .toEqual({ productCents: 2590, surchargeCents: 150, amountCents: 2740 });
  });

  it("charges the total alone when the acréscimo is waived", () => {
    expect(pixChargeAmount({ saleTotalCents: 2590, rule: { mode: "PERCENTAGE", rateBps: 100, fixedCents: null }, waive: true }))
      .toEqual({ productCents: 2590, surchargeCents: 0, amountCents: 2590 });
  });

  it("puts the decided amount in the payload and regenerates only when it changes", () => {
    const base = pixChargeFor(env, saleId, 2590);
    const surcharged = pixChargeFor(env, saleId, 2615);
    expect(base.problem).toBeNull();
    expect(amountOf(base.payload ?? "")).toBe("25.90");
    expect(amountOf(surcharged.payload ?? "")).toBe("26.15");
    expect(pixChargeFor(env, saleId, 2590).payload).toBe(base.payload);
    expect(surcharged.payload).not.toBe(base.payload);
    expect(base.txid).toBe("PDV7100000000004000800000");
  });

  it("produces no code at all without a valid receiver in the environment", () => {
    expect(pixChargeFor({}, saleId, 2590)).toEqual({ problem: "MISSING", payload: null, txid: null });
    expect(pixChargeFor({ ...env, PICPAY_PIX_KEY: "chave-inventada" }, saleId, 2590)).toEqual({ problem: "INVALID_KEY", payload: null, txid: null });
  });
});
