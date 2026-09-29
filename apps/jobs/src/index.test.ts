import { describe, expect, it, vi } from "vitest";
import { PaymentLinkProviderError, type PaymentLinkGateway } from "@germinatura/payments";
import worker, { createRequestedPaymentLinks, handlePaymentLinkSandboxCheck, handlePaymentLinkWebhook, maintainPaymentLinks, retryDelaySeconds, runCycle } from "./index";

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

describe("Payment Link sandbox check endpoint", () => {
  const sandboxEnv = {
    ...env, PICPAY_PAYMENT_LINK_TOKEN_URL: "https://api.ms.qa.limbo.work/oauth2/token", PICPAY_PAYMENT_LINK_API_BASE_URL: "https://api.ms.qa.limbo.work/sandbox/v1",
    PICPAY_PAYMENT_LINK_CLIENT_ID: "client", PICPAY_PAYMENT_LINK_CLIENT_SECRET: "secret",
  };
  const check = (authorization?: string) => new Request("https://jobs.example/diagnostics/payment-link-sandbox", { method: "POST", headers: authorization ? { authorization } : {} });

  it("requires the worker secret", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await handlePaymentLinkSandboxCheck(check(), sandboxEnv, fetchImpl)).status).toBe(401);
    expect((await handlePaymentLinkSandboxCheck(check("Bearer wrong"), sandboxEnv, fetchImpl)).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports which settings are present without their values", async () => {
    const response = await handlePaymentLinkSandboxCheck(check("Bearer service-secret"), { ...env, PICPAY_PAYMENT_LINK_CLIENT_ID: "client" });
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body.settings).toEqual({
      PICPAY_PAYMENT_LINK_TOKEN_URL: false, PICPAY_PAYMENT_LINK_API_BASE_URL: false, PICPAY_PAYMENT_LINK_CLIENT_ID: true,
      PICPAY_PAYMENT_LINK_CLIENT_SECRET: false, PICPAY_PAYMENT_LINK_WEBHOOK_KEY: false,
    });
    expect(JSON.stringify(body)).not.toContain("client\"");
  });

  it("refuses to run outside the sandbox", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await handlePaymentLinkSandboxCheck(check("Bearer service-secret"), { ...sandboxEnv, PICPAY_PAYMENT_LINK_API_BASE_URL: "https://api.example.test/v1" }, fetchImpl);
    expect(response.status).toBe(409);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs the documented scenarios against the sandbox and never calls the database", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      urls.push(url);
      const route = `${init?.method ?? "GET"} ${url.replace("https://api.ms.qa.limbo.work", "")}`;
      if (route === "POST /oauth2/token") return Promise.resolve(Response.json({ access_token: "a.b.c", expires_in: 300 }));
      if (route === "GET /sandbox/v1/paymentlink/17496673826849ce36a1c29") return Promise.resolve(Response.json({}, { status: 404 }));
      if (route === "GET /sandbox/v1/paymentlink/173887430167a51dbd8ee2d/transactions?page=1") return Promise.resolve(Response.json({ transactions: [], nextPage: null }));
      if (route === "GET /sandbox/v1/paymentlink/17496626166849bb9851578/transactions?page=1") return Promise.resolve(Response.json({ error: { message: "Erro" } }, { status: 500 }));
      if (route === "POST /sandbox/v1/paymentlink/create") return Promise.resolve(Response.json({ link: "https://link.ppay.me/p/diag0001link", amount: 100, brcode: "000201" }, { status: 201 }));
      if (route === "GET /sandbox/v1/paymentlink/diag0001link") return Promise.resolve(Response.json({ paymentLinkId: "diag0001link", details: { charge: { status: urls.some((item) => item.endsWith("/inactive")) ? "deleted" : "active", amount: 100, totalSales: 0 } } }));
      if (route === "GET /sandbox/v1/paymentlink/diag0001link/transactions?page=1") return Promise.resolve(Response.json({ transactions: [{ id: "afd2901c-db02-3fda-bba4-30023baeb2a2", status: "PAYED", amount: 400 }], nextPage: null }));
      if (route === "POST /sandbox/v1/paymentlink/diag0001link/inactive") return Promise.resolve(urls.filter((item) => item.endsWith("/inactive")).length === 1 ? Response.json({ message: "ok" }) : Response.json({ error: { code: "B038" } }, { status: 422 }));
      if (route === "POST /sandbox/v1/paymentlink/transaction/9f1c6b2a-3f4e-4b8d-a6c2-22e12f5a9d74/refund") return Promise.resolve(Response.json({ transactionId: "9f1c6b2a-3f4e-4b8d-a6c2-22e12f5a9d74", amount: 100, originalAmount: 450 }));
      if (route === "POST /sandbox/v1/paymentlink/transaction/e379b4d5-791c-48c8-bc19-3e908a6de9b7/refund") return Promise.resolve(Response.json({ error: { code: "B036" } }, { status: 400 }));
      return Promise.resolve(new Response(null, { status: 599 }));
    }) as unknown as typeof fetch;
    const response = await handlePaymentLinkSandboxCheck(check("Bearer service-secret"), sandboxEnv, fetchImpl, () => new Date("2026-09-29T12:00:00Z"));
    const body = await response.json() as { status: string; ok: boolean; steps: Array<{ step: string; ok: boolean }> };
    expect(body.steps.filter((step) => !step.ok)).toEqual([]);
    expect(body.status).toBe("ok");
    expect(urls.some((url) => url.includes("supabase"))).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

describe("Payment Link maintenance", () => {
  const database = (claims: Record<string, unknown[]>) => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const name = requestUrl(input).split("/").at(-1) ?? "";
      calls.push({ name, body: JSON.parse(init?.body as string) as Record<string, unknown> });
      return Promise.resolve(Response.json(claims[name] ?? { status: "ok" }));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const gateway = (overrides: Partial<PaymentLinkGateway>): PaymentLinkGateway => ({
    createCharge: vi.fn(), findCharge: vi.fn(), inactivateCharge: vi.fn(() => Promise.resolve()),
    listTransactions: vi.fn(() => Promise.resolve({ transactions: [], hasNextPage: false })),
    refundTransaction: vi.fn(), ...overrides,
  });

  it("does nothing while the provider is not configured", async () => {
    const { calls, fetchImpl } = database({});
    await expect(maintainPaymentLinks(env, "worker-1", fetchImpl)).resolves.toMatchObject({ configured: false });
    expect(calls).toEqual([]);
  });

  it("inactivates links and records provider errors for a later retry", async () => {
    const { calls, fetchImpl } = database({
      worker_claim_payment_link_inactivations: [{ charge_id: "charge-1", provider_link_id: "link-0001" }, { charge_id: "charge-2", provider_link_id: "link-0002" }],
      worker_claim_payment_link_status_checks: [], worker_claim_payment_link_refunds: [],
    });
    const provider = gateway({ inactivateCharge: vi.fn((id: string) => id === "link-0002" ? Promise.reject(new PaymentLinkProviderError("PICPAY_C003", false, 500)) : Promise.resolve()) });
    await expect(maintainPaymentLinks(env, "worker-1", fetchImpl, provider)).resolves.toMatchObject({ inactivated: 1, inactivationErrors: 1 });
    expect(calls.filter((call) => call.name === "worker_record_payment_link_inactivation").map((call) => call.body)).toEqual([
      { p_charge_id: "charge-1", p_worker_id: "worker-1", p_error_code: null },
      { p_charge_id: "charge-2", p_worker_id: "worker-1", p_error_code: "PICPAY_C003" },
    ]);
  });

  it("feeds polled transactions to the same path as the webhook", async () => {
    const { calls, fetchImpl } = database({
      worker_claim_payment_link_inactivations: [], worker_claim_payment_link_refunds: [],
      worker_claim_payment_link_status_checks: [{ charge_id: "charge-1", provider_link_id: "link-0001" }],
    });
    const provider = gateway({ listTransactions: vi.fn((_id: string, page = 1) => Promise.resolve(page === 1
      ? { transactions: [{ id: "tx-00000001", status: "PAYED", amountCents: 2590 }, { id: "tx-00000002", status: "PENDING", amountCents: 2590 }], hasNextPage: true }
      : { transactions: [{ id: "tx-00000003", status: "REFUNDED", amountCents: 2590 }], hasNextPage: false })) });
    await expect(maintainPaymentLinks(env, "worker-1", fetchImpl, provider)).resolves.toMatchObject({ polled: 1, statusEvents: 2 });
    expect(calls.filter((call) => call.name === "worker_record_payment_link_event").map((call) => call.body)).toEqual([
      { p_source: "STATUS_QUERY", p_event_type: null, p_payload: { type: "PAYMENT", data: { transaction: { id: "tx-00000001", status: "PAYED", amount: 2590 }, charge: { paymentLinkId: "link-0001" } } } },
      { p_source: "STATUS_QUERY", p_event_type: null, p_payload: { type: "REFUND", data: { transaction: { id: "tx-00000003", status: "REFUNDED", amount: 2590 }, charge: { paymentLinkId: "link-0001" } } } },
    ]);
  });

  it("submits refunds once and marks timeouts as uncertain", async () => {
    const { calls, fetchImpl } = database({
      worker_claim_payment_link_inactivations: [], worker_claim_payment_link_status_checks: [],
      worker_claim_payment_link_refunds: [
        { refund_id: "refund-1", transaction_id: "tx-00000001", amount_cents: 2590 },
        { refund_id: "refund-2", transaction_id: "tx-00000002", amount_cents: 100 },
        { refund_id: "refund-3", transaction_id: "tx-00000003", amount_cents: 100 },
      ],
    });
    const provider = gateway({ refundTransaction: vi.fn((id: string) => id === "tx-00000001"
      ? Promise.resolve({ transactionId: "tx-refund-01", amountCents: 2590, originalAmountCents: 2590 })
      : id === "tx-00000002" ? Promise.reject(new PaymentLinkProviderError("PROVIDER_NO_RESPONSE", true))
      : Promise.reject(new PaymentLinkProviderError("PICPAY_B036", false, 400))) });
    await expect(maintainPaymentLinks(env, "worker-1", fetchImpl, provider)).resolves.toMatchObject({ refundsAccepted: 1, refundsUncertain: 1, refundsFailed: 1 });
    expect(calls.filter((call) => call.name === "worker_record_payment_link_refund").map((call) => call.body)).toEqual([
      { p_refund_id: "refund-1", p_worker_id: "worker-1", p_outcome: "ACCEPTED", p_provider_refund_id: "tx-refund-01", p_original_amount_cents: 2590, p_error_code: null },
      { p_refund_id: "refund-2", p_worker_id: "worker-1", p_outcome: "UNCERTAIN", p_provider_refund_id: null, p_original_amount_cents: null, p_error_code: "PROVIDER_NO_RESPONSE" },
      { p_refund_id: "refund-3", p_worker_id: "worker-1", p_outcome: "FAILED", p_provider_refund_id: null, p_original_amount_cents: null, p_error_code: "PICPAY_B036" },
    ]);
  });
});
