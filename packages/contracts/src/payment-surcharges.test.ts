import { describe, expect, it } from "vitest";
import { cashPaymentRequestSchema, completePickupRequestSchema, manualPaymentConfirmationRequestSchema, permissionSchema } from "./index";
import { paymentSurchargeSnapshotSchema, savePaymentSurchargeRuleRequestSchema } from "./payment-surcharges";

describe("payment surcharge contracts", () => {
  it("accepts exactly one mode per rule, with a reason", () => {
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "CREDITO", mode: "PERCENTAGE", rateBps: 349, reason: "Repasse" }).success).toBe(true);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "DEBITO", mode: "FIXED", fixedCents: 150, reason: "Repasse" }).success).toBe(true);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "PIX", mode: "NONE", reason: "Sem acréscimo" }).success).toBe(true);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "CREDITO", mode: "PERCENTAGE", rateBps: 349, fixedCents: 10, reason: "Os dois" }).success).toBe(false);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "CREDITO", mode: "PERCENTAGE", rateBps: 3.49, reason: "Float" }).success).toBe(false);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "CREDITO", mode: "PERCENTAGE", rateBps: 0, reason: "Zero" }).success).toBe(false);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "CREDITO", mode: "FIXED", fixedCents: 150, reason: "  " }).success).toBe(false);
    expect(savePaymentSurchargeRuleRequestSchema.safeParse({ method: "VOUCHER", mode: "NONE", reason: "Voucher" }).success).toBe(false);
  });

  it("carries the acréscimo shown to the customer and requires a reason to waive it", () => {
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 3_000, surchargeCents: 100 }).success).toBe(true);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 3_000, surchargeCents: 1.5 }).success).toBe(false);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 3_000, surchargeCents: 100, waiveSurcharge: true }).success).toBe(false);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 3_000, surchargeCents: 100, waiveSurcharge: true, surchargeWaiverReason: "Cortesia da comissão" }).success).toBe(true);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 3_000, surchargeCents: 0, waiveSurcharge: true, surchargeWaiverReason: "Nada a remover" }).success).toBe(false);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 3_000, surchargeWaiverReason: "Sem remoção" }).success).toBe(false);
    expect(manualPaymentConfirmationRequestSchema.safeParse({ integrationChannel: "MAQUININHA", proofReference: "NSU-0001", cardMethod: "CREDITO", surchargeCents: 90 }).success).toBe(true);
    expect(completePickupRequestSchema.safeParse({ integrationChannel: "PIX_AREA", tenderedCents: null, proofReference: "PIX-0001", cardMethod: null, terminalId: null, surchargeCents: 25 }).success).toBe(true);
  });

  it("knows the waiver permission and the snapshot shape", () => {
    expect(permissionSchema.parse("sales.surcharge.waive")).toBe("sales.surcharge.waive");
    expect(paymentSurchargeSnapshotSchema.safeParse({ method: "CREDITO", mode: "PERCENTAGE", rateBps: 349, fixedCents: null, baseCents: 2_590,
      expectedCents: 90, appliedCents: 90, waived: false, waiverReason: null }).success).toBe(true);
    expect(paymentSurchargeSnapshotSchema.safeParse({ method: "CREDITO", mode: "NONE", rateBps: null, fixedCents: null, baseCents: 2_590,
      expectedCents: 0, appliedCents: 0, waived: false, waiverReason: null }).success).toBe(false);
  });
});
