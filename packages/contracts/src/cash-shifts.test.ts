import { describe, expect, it } from "vitest";
import { cashPaymentRequestSchema, closeSellerShiftRequestSchema, openSellerShiftRequestSchema } from "./cash-shifts";
import { featureFlagKeySchema, paymentIntegrationChannelSchema } from "./index";

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

  it("requires a meaningful justification when one is sent", () => {
    expect(closeSellerShiftRequestSchema.safeParse({ countedCashCents: 3_590, justification: null }).success).toBe(true);
    expect(closeSellerShiftRequestSchema.safeParse({ countedCashCents: 3_500, justification: "curta" }).success).toBe(false);
    expect(closeSellerShiftRequestSchema.safeParse({ countedCashCents: 3_500, justification: "Troco dado a mais" }).success).toBe(true);
  });
});
