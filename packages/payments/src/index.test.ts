import { describe, expect, it } from "vitest";
import { assertPaymentTransition, canTransitionPayment, PaymentIntegrationUnavailableError, UnavailablePicPayCardPresentProvider } from "./index";

describe("payment state transitions", () => {
  it("supports a controlled manual card-present lifecycle", () => {
    expect(canTransitionPayment("CREATED", "AWAITING_EXTERNAL_CONFIRMATION")).toBe(true);
    expect(canTransitionPayment("AWAITING_EXTERNAL_CONFIRMATION", "APPROVED")).toBe(true);
    expect(canTransitionPayment("APPROVED", "RECONCILIATION_PENDING")).toBe(true);
    expect(canTransitionPayment("RECONCILIATION_PENDING", "RECONCILED")).toBe(true);
  });
  it("accepts idempotent repetition", () => expect(canTransitionPayment("APPROVED", "APPROVED")).toBe(true));
  it("rejects reopening terminal states", () => {
    expect(() => assertPaymentTransition("CANCELLED", "APPROVED")).toThrow("Invalid payment status transition");
    expect(canTransitionPayment("RECONCILED", "PENDING")).toBe(false);
  });
});

describe("unavailable PicPay card-present adapter", () => {
  it("never claims remote initiation support", () => expect(new UnavailablePicPayCardPresentProvider().supportsRemoteInitiation()).toBe(false));
  it("fails closed instead of simulating payment", async () => {
    const provider = new UnavailablePicPayCardPresentProvider();
    await expect(provider.createPaymentAttempt({ orderId: "order-1", amountInCents: 2500, idempotencyKey: "attempt-1", channel: "MAQUININHA", operatorId: "seller-1" })).rejects.toBeInstanceOf(PaymentIntegrationUnavailableError);
  });
});
