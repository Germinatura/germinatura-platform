import { describe, expect, it, vi } from "vitest";
import { PaymentLinkProviderError, type PaymentLinkGateway } from "./payment-link";
import { isPaymentLinkSandbox, runPaymentLinkSandboxCheck } from "./payment-link-sandbox";

function sandboxGateway(overrides: Partial<PaymentLinkGateway> = {}): PaymentLinkGateway {
  let inactive = false;
  return {
    createCharge: vi.fn(() => Promise.resolve({ paymentLinkId: "diag0001link", checkoutUrl: "https://link.ppay.me/p/diag0001link", brcode: "000201", expiresAt: null, amountCents: 100 })),
    findCharge: vi.fn((id: string) => Promise.resolve(id === "diag0001link" ? { paymentLinkId: id, status: inactive ? "deleted" as const : "active" as const, amountCents: 100, totalSales: 0 } : null)),
    listTransactions: vi.fn((id: string) => id === "17496626166849bb9851578"
      ? Promise.reject(new PaymentLinkProviderError("HTTP_500", false, 500))
      : Promise.resolve({ transactions: id === "173887430167a51dbd8ee2d" ? [] : [{ id: "afd2901c-db02-3fda-bba4-30023baeb2a2", status: "PAYED", amountCents: 400 }], hasNextPage: false })),
    inactivateCharge: vi.fn(() => { inactive = true; return Promise.resolve(); }),
    refundTransaction: vi.fn((id: string) => id === "9f1c6b2a-3f4e-4b8d-a6c2-22e12f5a9d74"
      ? Promise.resolve({ transactionId: id, amountCents: 100, originalAmountCents: 450 })
      : Promise.reject(new PaymentLinkProviderError("PICPAY_B036", false, 400))),
    ...overrides,
  };
}

describe("Payment Link sandbox check", () => {
  it("recognizes only the documented sandbox hosts", () => {
    const sandbox = { tokenUrl: "https://api.ms.qa.limbo.work/oauth2/token", apiBaseUrl: "https://api.ms.qa.limbo.work/sandbox/v1", clientId: "c", clientSecret: "s", timeoutMs: 1000 };
    expect(isPaymentLinkSandbox(sandbox)).toBe(true);
    expect(isPaymentLinkSandbox({ ...sandbox, apiBaseUrl: "https://example.picpay.com/v1" })).toBe(false);
    expect(isPaymentLinkSandbox({ ...sandbox, tokenUrl: "https://ecommerce-api.svc.picpay.com/oauth2/token" })).toBe(false);
  });

  it("passes when every documented scenario behaves as described", async () => {
    const result = await runPaymentLinkSandboxCheck(sandboxGateway(), "2026-09-29");
    expect(result.steps.map((step) => `${step.step}:${step.ok}`)).toEqual([
      "oauth_and_missing_link:true", "transactions_empty:true", "transactions_failure:true", "create:true", "find_created:true",
      "transactions_created:true", "inactivate:true", "inactivate_again:true", "find_inactivated:true", "refund_success:true", "refund_rejected:true",
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails and names the step when the provider differs from the documentation", async () => {
    const result = await runPaymentLinkSandboxCheck(sandboxGateway({
      createCharge: vi.fn(() => Promise.reject(new PaymentLinkProviderError("AUTH_REJECTED", false, 401))),
      refundTransaction: vi.fn(() => Promise.reject(new PaymentLinkProviderError("PROVIDER_NO_RESPONSE", true))),
    }), "2026-09-29");
    expect(result.ok).toBe(false);
    const create = result.steps.find((step) => step.step === "create");
    expect(create?.ok).toBe(false);
    expect(create?.detail).toMatch(/^AUTH_REJECTED \(HTTP 401\) \(\d+ ms\)$/);
    expect(result.steps.some((step) => step.step === "find_created")).toBe(false);
    expect(result.steps.find((step) => step.step === "refund_rejected")?.ok).toBe(false);
  });

  it("does not accept a missing answer as the documented rejection", async () => {
    const unreachable = new PaymentLinkProviderError("AUTH_UNAVAILABLE", false, undefined, "TimeoutError: The operation was aborted due to timeout");
    const result = await runPaymentLinkSandboxCheck(sandboxGateway({
      findCharge: vi.fn(() => Promise.reject(unreachable)), listTransactions: vi.fn(() => Promise.reject(unreachable)),
      createCharge: vi.fn(() => Promise.reject(unreachable)), refundTransaction: vi.fn(() => Promise.reject(unreachable)),
    }), "2026-09-29");
    expect(result.steps.every((step) => !step.ok)).toBe(true);
    expect(result.steps[0].detail).toContain("[TimeoutError: The operation was aborted due to timeout]");
  });
});
