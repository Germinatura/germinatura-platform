import { describe, expect, it } from "vitest";
import { adminSellerShiftSchema, cashPaymentRequestSchema, closeSellerShiftRequestSchema, openSellerShiftRequestSchema } from "./cash-shifts";
import { confirmedSaleReversalRequestSchema, featureFlagKeySchema, paymentIntegrationChannelSchema } from "./index";

describe("cash and shift contracts", () => {
  it("knows the cash feature flag and the internal cash channel", () => {
    // Every seeded flag must parse, otherwise the flag list endpoint fails and hides navigation.
    expect(featureFlagKeySchema.parse("cash_payment")).toBe("cash_payment");
    expect(paymentIntegrationChannelSchema.parse("DINHEIRO")).toBe("DINHEIRO");
  });

  it("accepts only integer cents", () => {
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 5_000 }).success).toBe(true);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: 50.5 }).success).toBe(false);
    expect(cashPaymentRequestSchema.safeParse({ tenderedCents: -1 }).success).toBe(false);
    expect(openSellerShiftRequestSchema.safeParse({ locationId: "50000000-0000-4000-8000-000000000002", openingCashCents: 0 }).success).toBe(true);
  });

  it("reverses by another means unless a payout shift is named", () => {
    const base = { reason: "Cliente desistiu da compra", refundReference: "EST-CASH-0001" };
    expect(confirmedSaleReversalRequestSchema.parse(base)).not.toHaveProperty("cashPayoutShiftId");
    expect(confirmedSaleReversalRequestSchema.parse({ ...base, cashPayoutShiftId: "68000000-0000-4000-8000-000000000001" }))
      .toMatchObject({ cashPayoutShiftId: "68000000-0000-4000-8000-000000000001" });
    expect(confirmedSaleReversalRequestSchema.safeParse({ ...base, cashPayoutShiftId: "gaveta-1" }).success).toBe(false);
  });

  it("describes a reviewed shift with its physical refunds", () => {
    const shift = {
      shiftId: "68000000-0000-4000-8000-000000000002", status: "CLOSED", locationId: "50000000-0000-4000-8000-000000000002",
      openedAt: "2026-09-30T12:00:00.000Z", closedAt: "2026-09-30T20:00:00.000Z", openingCashCents: 1_000,
      cashSalesCount: 3, cashSalesTotalCents: 7_770, cashRefundsCount: 1, cashRefundsTotalCents: 2_590,
      expectedCashCents: 6_180, countedCashCents: 6_180, differenceCents: 0, justification: null,
      sellerId: "10000000-0000-4000-8000-000000000002", sellerName: "Vendedor Teste", locationName: "Mochila do vendedor",
    };
    expect(adminSellerShiftSchema.parse(shift).expectedCashCents).toBe(6_180);
    expect(adminSellerShiftSchema.safeParse({ ...shift, cashRefundsTotalCents: -2_590 }).success).toBe(false);
  });

  it("requires a meaningful justification when one is sent", () => {
    expect(closeSellerShiftRequestSchema.safeParse({ countedCashCents: 3_590, justification: null }).success).toBe(true);
    expect(closeSellerShiftRequestSchema.safeParse({ countedCashCents: 3_500, justification: "curta" }).success).toBe(false);
    expect(closeSellerShiftRequestSchema.safeParse({ countedCashCents: 3_500, justification: "Troco dado a mais" }).success).toBe(true);
  });
});
