import { describe, expect, it } from "vitest";
import { createPurchaseReceiptSchema, purchaseReceiptCommandResponseSchema } from "./purchase-receipts";

const valid = {
  orderId: "c4000000-0000-4000-8000-000000000001",
  orderItemId: "c4000000-0000-4000-8000-000000000002",
  quantity: 2, receivedOn: "2026-09-18", lotCode: "LOTE-01",
  manufacturedOn: "2026-09-01", expiresOn: "2026-10-01", reason: "Entrega conferida",
};

describe("purchase receipt contract", () => {
  it("accepts a physical partial delivery without client totals", () => {
    expect(createPurchaseReceiptSchema.safeParse(valid).success).toBe(true);
    expect(createPurchaseReceiptSchema.safeParse({ ...valid, totalCostCents: 100 }).success).toBe(false);
  });
  it("rejects invalid quantities and expired lots", () => {
    expect(createPurchaseReceiptSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
    expect(createPurchaseReceiptSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false);
    expect(createPurchaseReceiptSchema.safeParse({ ...valid, expiresOn: "2026-09-18" }).success).toBe(false);
    expect(createPurchaseReceiptSchema.safeParse({ ...valid, manufacturedOn: "2026-09-19" }).success).toBe(false);
  });
  it("requires server identifiers for stock, lot and payable effects", () => {
    expect(purchaseReceiptCommandResponseSchema.safeParse({ data: {
      id: valid.orderId, orderId: valid.orderId, quantity: 2, baseCostCents: 100,
      allocatedExtraCents: 10, totalCostCents: 110, lotId: valid.orderId,
      movementId: valid.orderId, payableId: valid.orderId, correlationId: valid.orderId,
    }, request_id: "request" }).success).toBe(true);
  });
});
