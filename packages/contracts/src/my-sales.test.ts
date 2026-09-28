import { describe, expect, it } from "vitest";
import { mySaleSchema, mySalesQuerySchema } from "./index";

const sale = {
  saleId: "69000000-0000-4000-8000-000000000001", status: "AWAITING_PAYMENT", createdAt: "2026-09-30T12:00:00.000Z",
  locationId: "50000000-0000-4000-8000-000000000002", originalTotalCents: 2_590, discountTotalCents: 0, totalCents: 2_590,
  pendingReason: "AWAITING_PAYMENT", reservationExpiresAt: "2026-09-30T12:15:00.000Z",
  payment: { attemptId: "69000000-0000-4000-8000-000000000002", status: "CREATED", integrationChannel: null, confirmationSource: null, confirmedAt: null },
  items: [{ productName: "Item público A", quantity: 1, totalCents: 2_590 }],
};

describe("my sales contracts", () => {
  it("accepts only the known filters", () => {
    expect(mySalesQuerySchema.safeParse({ filter: "PENDING" }).success).toBe(true);
    expect(mySalesQuerySchema.safeParse({ filter: "ALL" }).success).toBe(false);
    expect(mySalesQuerySchema.safeParse({ cursor: "nao-e-uuid" }).success).toBe(false);
  });

  it("never lists drafts and keeps money in cents", () => {
    expect(mySaleSchema.parse(sale).pendingReason).toBe("AWAITING_PAYMENT");
    expect(mySaleSchema.safeParse({ ...sale, status: "DRAFT" }).success).toBe(false);
    expect(mySaleSchema.safeParse({ ...sale, totalCents: 25.9 }).success).toBe(false);
  });
});
