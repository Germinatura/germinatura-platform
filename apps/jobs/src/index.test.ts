import { describe, expect, it, vi } from "vitest";
import { PaymentLinkProviderError, type PaymentLinkGateway } from "@germinatura/payments";
import worker, { createRequestedPaymentLinks, handlePaymentLinkWebhook, retryDelaySeconds, runCycle } from "./index";

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "service-secret" };
const requestUrl = (input: RequestInfo | URL) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

describe("jobs worker", () => {
  it("uses capped exponential retry delays", () => {
    expect([1, 2, 3, 20].map(retryDelaySeconds)).toEqual([5, 10, 20, 900]);
  });

  it("processes claims and retries a failed event without exposing payloads", async () => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const name = requestUrl(input).split("/").at(-1) ?? "";
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      calls.push({ name, body });
      if (name === "worker_expire_due_reservations") return Promise.resolve(Response.json({ commercial_reservations: 1 }));
      if (name === "worker_claim_outbox_events") return Promise.resolve(Response.json([{ id: "event-1", attempts: 2 }, { id: "event-2", attempts: 8 }]));
      if (name === "worker_process_outbox_event" && body.p_event_id === "event-2") return Promise.resolve(new Response("private upstream detail", { status: 500 }));
      if (name === "worker_retry_outbox_event") return Promise.resolve(Response.json({ status: "FAILED" }));
      if (name === "worker_outbox_metrics") return Promise.resolve(Response.json({ pending: 0, processing: 0, failed: 1, delayed: 0 }));
      return Promise.resolve(Response.json({ status: "PUBLISHED" }));
    });
    const result = await runCycle(env, fetchImpl);
    expect(result).toMatchObject({ claimed: 2, published: 1, retried: 0, failed: 1 });
    expect(calls.find((call) => call.name === "worker_retry_outbox_event")?.body).toMatchObject({
      p_error: "OUTBOX_PROCESSING_FAILED", p_backoff_seconds: 640, p_max_attempts: 8,
    });
    expect(JSON.stringify(calls)).not.toContain("private upstream detail");
  });

  it("keeps outbox processing available when expiration fails", async () => {
    const fetchImpl: typeof fetch = vi.fn((input: RequestInfo | URL) => {
      const name = requestUrl(input).split("/").at(-1);
      if (name === "worker_expire_due_reservations") return Promise.resolve(new Response(null, { status: 503 }));
      if (name === "worker_claim_outbox_events") return Promise.resolve(Response.json([]));
      return Promise.resolve(Response.json({ pending: 0 }));
    });
    await expect(runCycle(env, fetchImpl)).resolves.toMatchObject({ expired: { errors: 1 }, claimed: 0 });
  });

  it("exposes only a configuration health check", async () => {
    const response = await worker.fetch(new Request("https://jobs.example/health"), env);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: "jobs" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Payment Link webhook", () => {
  const webhookEnv = { ...env, PICPAY_PAYMENT_LINK_WEBHOOK_KEY: "a45c2dee-6435-key" };
  const payment = { type: "PAYMENT", data: { transaction: { id: "a105da56-a372-4e6e-976e-000000000001", status: "PAYED", amount: 300 }, charge: { paymentLinkId: "174708287368abcdef" } } };
  const delivery = (headers: Record<string, string>, body = JSON.stringify(payment)) =>
    new Request("https://jobs.example/webhooks/picpay/payment-link", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("stays closed until the API Key is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await handlePaymentLinkWebhook(delivery({ authorization: "anything" }), env, fetchImpl);
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects deliveries without the configured API Key", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await worker.fetch(delivery({ authorization: "wrong-key" }), webhookEnv);
    expect(response.status).toBe(401);
    expect((await handlePaymentLinkWebhook(delivery({}), webhookEnv, fetchImpl)).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores the authenticated event with its type and acknowledges it", async () => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ name: requestUrl(input).split("/").at(-1) ?? "", body: JSON.parse(init?.body as string) as Record<string, unknown> });
      return Promise.resolve(Response.json({ outcome: "APPLIED", duplicate: false }));
    }) as unknown as typeof fetch;
    const response = await handlePaymentLinkWebhook(delivery({ authorization: "a45c2dee-6435-key", "event-type": "TransactionPaymentMessage" }), webhookEnv, fetchImpl);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ name: "worker_record_payment_link_event", body: { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage", p_payload: payment } }]);
  });

  it("asks for a new delivery when the event could not be stored", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;
    const response = await handlePaymentLinkWebhook(delivery({ authorization: "a45c2dee-6435-key" }), webhookEnv, fetchImpl);
    expect(response.status).toBe(500);
  });

  it("refuses bodies that are not a JSON object or are too large", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await handlePaymentLinkWebhook(delivery({ authorization: "a45c2dee-6435-key" }, "[1]"), webhookEnv, fetchImpl)).status).toBe(400);
    expect((await handlePaymentLinkWebhook(delivery({ authorization: "a45c2dee-6435-key" }, "x".repeat(70_000)), webhookEnv, fetchImpl)).status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Payment Link creation", () => {
  const claim = { charge_id: "charge-1", order_number: "G0123456789ABCD", amount_cents: 2590, name: "Germinatura G0123456789ABCD", expires_on: "2026-09-29" };
  const database = () => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const name = requestUrl(input).split("/").at(-1) ?? "";
      calls.push({ name, body: JSON.parse(init?.body as string) as Record<string, unknown> });
      if (name === "worker_claim_payment_link_requests") return Promise.resolve(Response.json([claim]));
      return Promise.resolve(Response.json({ status: "ok" }));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const gateway = (createCharge: PaymentLinkGateway["createCharge"]): PaymentLinkGateway => ({
    createCharge, findCharge: vi.fn(), listTransactions: vi.fn(), inactivateCharge: vi.fn(), refundTransaction: vi.fn(),
  });

  it("claims nothing while the provider is not configured", async () => {
    const { calls, fetchImpl } = database();
    await expect(createRequestedPaymentLinks(env, "worker-1", fetchImpl)).resolves.toEqual({ configured: false, created: 0, failed: 0, uncertain: 0 });
    expect(calls).toEqual([]);
  });

  it("records the created link", async () => {
    const { calls, fetchImpl } = database();
    const provider = gateway(() => Promise.resolve({ paymentLinkId: "1688060808649dc38881cdc", checkoutUrl: "https://link.picpay.com/p/1688060808649dc38881cdc", brcode: "000201", expiresAt: null, amountCents: 2590 }));
    await expect(createRequestedPaymentLinks(env, "worker-1", fetchImpl, provider)).resolves.toMatchObject({ created: 1 });
    expect(calls.at(-1)).toEqual({ name: "worker_record_payment_link_created", body: {
      p_charge_id: "charge-1", p_worker_id: "worker-1", p_provider_link_id: "1688060808649dc38881cdc",
      p_checkout_url: "https://link.picpay.com/p/1688060808649dc38881cdc", p_brcode: "000201", p_expires_at: null,
    } });
  });

  it("marks timeouts as uncertain and rejections as failed", async () => {
    const timeout = database();
    await createRequestedPaymentLinks(env, "worker-1", timeout.fetchImpl, gateway(() => Promise.reject(new PaymentLinkProviderError("PROVIDER_NO_RESPONSE", true))));
    expect(timeout.calls.at(-1)?.body).toMatchObject({ p_uncertain: true, p_error_code: "PROVIDER_NO_RESPONSE" });
    const rejected = database();
    await createRequestedPaymentLinks(env, "worker-1", rejected.fetchImpl, gateway(() => Promise.reject(new PaymentLinkProviderError("PICPAY_B001", false, 422))));
    expect(rejected.calls.at(-1)?.body).toMatchObject({ p_uncertain: false, p_error_code: "PICPAY_B001" });
    const unexpected = database();
    await createRequestedPaymentLinks(env, "worker-1", unexpected.fetchImpl, gateway(() => Promise.reject(new Error("boom"))));
    expect(unexpected.calls.at(-1)?.body).toMatchObject({ p_uncertain: true, p_error_code: "UNEXPECTED_ERROR" });
  });
});
