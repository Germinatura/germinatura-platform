import { describe, expect, it } from "vitest";
import { createPurchaseOrderSchema } from "./purchase-orders";

const order = {
  supplierId: "50000000-0000-4000-8000-000000000001", orderedOn: "2026-09-18", expectedOn: null,
  freightCents: 50, otherCostCents: 0, paymentMethod: "PIX após entrega", proofReference: null, notes: null,
  items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 2, unitCostCents: 625 }],
  reason: "Reposição de produtos",
};

describe("purchase order input", () => {
  it("accepts a server-priced commitment without a client-supplied total", () => {
    expect(createPurchaseOrderSchema.safeParse(order).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse({ ...order, totalCents: 1300 }).success).toBe(false);
  });
  it("rejects duplicate products and unsafe totals", () => {
    expect(createPurchaseOrderSchema.safeParse({ ...order, items: [order.items[0], order.items[0]] }).success).toBe(false);
    expect(createPurchaseOrderSchema.safeParse({ ...order, items: [{ ...order.items[0], quantity: Number.MAX_SAFE_INTEGER }] }).success).toBe(false);
  });
});
