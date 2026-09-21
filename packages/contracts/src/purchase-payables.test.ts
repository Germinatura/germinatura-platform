import { describe, expect, it } from "vitest";
import {
  reversePurchasePayableSettlementSchema,
  settlePurchasePayableSchema,
} from "./purchase-payables";

describe("purchase payable contracts", () => {
  it("accepts a partial cash settlement without a client-computed balance", () => {
    const result = settlePurchasePayableSchema.safeParse({
      amountCents: 750,
      effectiveOn: "2026-09-20",
      paymentMethod: "PIX PicPay Empresas",
      reference: "E2E-PIX-001",
      reason: "Pagamento parcial conferido",
    });
    expect(result.success).toBe(true);
    expect(settlePurchasePayableSchema.safeParse({
      amountCents: 750,
      effectiveOn: "2026-09-20",
      paymentMethod: "PIX PicPay Empresas",
      reference: "E2E-PIX-001",
      reason: "Pagamento parcial conferido",
      remainingCents: 0,
    }).success).toBe(false);
  });

  it("rejects imprecise, zero and undocumented payments", () => {
    const base = { effectiveOn: "2026-09-20", paymentMethod: "PIX", reference: "REF-1", reason: "Pagamento conferido" };
    expect(settlePurchasePayableSchema.safeParse({ ...base, amountCents: 0 }).success).toBe(false);
    expect(settlePurchasePayableSchema.safeParse({ ...base, amountCents: 10.5 }).success).toBe(false);
    expect(settlePurchasePayableSchema.safeParse({ ...base, amountCents: 10, reference: "" }).success).toBe(false);
  });

  it("requires an effective date and reason for reversal", () => {
    expect(reversePurchasePayableSettlementSchema.safeParse({ effectiveOn: "2026-09-20", reason: "Pagamento lançado em duplicidade" }).success).toBe(true);
    expect(reversePurchasePayableSettlementSchema.safeParse({ effectiveOn: "2026-09-20", reason: "x" }).success).toBe(false);
  });
});
