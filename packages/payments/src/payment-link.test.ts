import { describe, expect, it, vi } from "vitest";
import {
  buildCreateChargeBody, isAuthorizedPaymentLinkWebhook, paymentLinkConfigFromEnv, paymentLinkIdFromUrl,
  PaymentLinkProviderError, paymentLinkWebhookEventType, PicPayPaymentLinkClient, transactionsToStatusEvents,
} from "./payment-link";

// Shapes copied from the official PicPay Payment Link examples (OpenAPI 1.0.0 and webhook page); ids are placeholders.
const fixtures = {
  token: { access_token: "header.payload.signature", expires_in: 300, token_type: "Bearer", scope: "p2b.paymentlink.transactional" },
  created: {
    brcode: "00020126730015COM.PICPAY.LINK0150https://example", name: "Germinatura", description: null, amount: 2590,
    link: "https://link.picpay.com/p/1688060808649dc38881cdc", deeplink: "https://cobranca.picpay.com/p/1688060808649dc38881cdc",
    pixKey: null, txid: null, paymentMethods: ["BRCODE", "CREDIT_CARD"], paymentBrcodeArrangements: ["PICPAY", "PIX"],
    status: "active", chargeName: "Germinatura", expirationDate: "2026-09-29T00:00:00.000000Z", ppMaxInstallmentNumber: null,
    cardMaxInstallmentNumber: 1, maxPaymentQuantity: null,
    details: { orderNumber: "G0123456789ABCD", productAmount: 2590, deliveryAmount: 0, redirectURL: null },
  },
  businessError: { error: { message: "Seller conta liquidação não é elegível para pix.", type: "pix", code: "B001" } },
  found: {
    uuid: "5f475570-d740-3165-be4f-096eede849cb", paymentLinkId: "1688060808649dc38881cdc", createdAt: "2026-09-29 12:00:00", deletedAt: null,
    details: { channel: "API", orderNumber: "G0123456789ABCD", captureSolution: "BIZ_A_FECHADO", termId: null,
      charge: { name: "Germinatura", status: "active", amount: 2590, deliveryAmount: 0, productAmount: 2590, totalSales: 1, expiration: null, qrcode: null,
        links: { checkout: "https://link.picpay.com/p/1688060808649dc38881cdc", share: "https://link.picpay.com/p/1688060808649dc38881cdc" } },
      payment: { methods: ["BRCODE", "CREDIT_CARD"], arrangements: ["PIX", "PICPAY"], cardMaxInstallments: 1, pixKey: null, pixTxid: null } },
  },
  transactions: {
    originId: "1688060808649dc38881cdc",
    transactions: [
      { id: "afd2901c-db02-3fda-bba4-30023baeb2a2", status: "PAYED", amount: 2590, createdAt: "2026-09-29 12:01:00", updatedAt: "2026-09-29 12:01:00" },
      { transactionId: "b00389d2-e532-3f0e-8935-f24bb855983f", status: "REFUNDED", amount: 2590, createdAt: "2026-09-29 12:05:00", updatedAt: "2026-09-29 12:05:00" },
    ],
    perPage: 10, currentPage: 1, nextPage: null,
  },
  refund: { transactionId: "684065d2-6803-40f3-a76c-1108d66d8db0", amount: 1000, originalAmount: 2590 },
  alreadyInactive: { error: { message: "Link de pagamento foi inativado anteriormente.", type: "validation", code: "B038" } },
};

const config = { tokenUrl: "https://auth.example.test/oauth2/token", apiBaseUrl: "https://api.example.test/v1", clientId: "client", clientSecret: "secret", timeoutMs: 1000 };
const urlOf = (input: RequestInfo | URL) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

function provider(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, init });
    if (url === config.tokenUrl) return Promise.resolve(Response.json(fixtures.token));
    const route = routes[`${init?.method ?? "GET"} ${url.replace(config.apiBaseUrl, "")}`];
    return route ? Promise.resolve(route()) : Promise.resolve(new Response(null, { status: 404 }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const input = { orderNumber: "G0123456789ABCD", name: "Germinatura G0123456789ABCD", amountCents: 2590, expiresOn: "2026-09-29" };

describe("Payment Link configuration", () => {
  it("stays unavailable until every value is configured over HTTPS", () => {
    const complete = {
      PICPAY_PAYMENT_LINK_TOKEN_URL: "https://auth.example.test/oauth2/token", PICPAY_PAYMENT_LINK_API_BASE_URL: "https://api.example.test/v1/",
      PICPAY_PAYMENT_LINK_CLIENT_ID: "client", PICPAY_PAYMENT_LINK_CLIENT_SECRET: "secret",
    };
    expect(paymentLinkConfigFromEnv(complete)?.apiBaseUrl).toBe("https://api.example.test/v1");
    expect(paymentLinkConfigFromEnv({ ...complete, PICPAY_PAYMENT_LINK_CLIENT_SECRET: "" })).toBeNull();
    expect(paymentLinkConfigFromEnv({ ...complete, PICPAY_PAYMENT_LINK_API_BASE_URL: "http://api.example.test" })).toBeNull();
    expect(paymentLinkConfigFromEnv({})).toBeNull();
  });
});

describe("Payment Link client", () => {
  it("creates a charge with the documented body and reads the link id from the returned link", async () => {
    const { calls, fetchImpl } = provider({ "POST /paymentlink/create": () => Response.json(fixtures.created, { status: 201 }) });
    const created = await new PicPayPaymentLinkClient(config, fetchImpl).createCharge(input);
    expect(created).toEqual({
      paymentLinkId: "1688060808649dc38881cdc", checkoutUrl: fixtures.created.link, brcode: fixtures.created.brcode,
      expiresAt: fixtures.created.expirationDate, amountCents: 2590,
    });
    const body = JSON.parse(calls[1].init?.body as string) as unknown;
    expect(body).toEqual(buildCreateChargeBody(input));
    expect(body).toMatchObject({
      charge: { order_number: "G0123456789ABCD", amounts: { product: 2590, delivery: 0 }, payment: { methods: ["BRCODE", "CREDIT_CARD"] } },
      options: { allow_create_pix_key: false, card_max_installment_number: 1, expired_at: "2026-09-29" },
    });
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer header.payload.signature");
    expect(JSON.stringify(calls[0].init?.body)).toContain("client_credentials");
  });

  it("shares one token between concurrent calls and renews it before expiry", async () => {
    let now = 0;
    const { calls, fetchImpl } = provider({ "GET /paymentlink/1688060808649dc38881cdc": () => Response.json(fixtures.found) });
    const client = new PicPayPaymentLinkClient(config, fetchImpl, () => now);
    await Promise.all([client.findCharge("1688060808649dc38881cdc"), client.findCharge("1688060808649dc38881cdc")]);
    expect(calls.filter((call) => call.url === config.tokenUrl)).toHaveLength(1);
    now = 271_000;
    await client.findCharge("1688060808649dc38881cdc");
    expect(calls.filter((call) => call.url === config.tokenUrl)).toHaveLength(2);
  });

  it("separates rejected creations from uncertain ones", async () => {
    const rejected = provider({ "POST /paymentlink/create": () => Response.json(fixtures.businessError, { status: 422 }) });
    await expect(new PicPayPaymentLinkClient(config, rejected.fetchImpl).createCharge(input))
      .rejects.toMatchObject({ code: "PICPAY_B001", uncertain: false, status: 422 });
    const unavailable = provider({ "POST /paymentlink/create": () => Response.json({ error: { code: "C001" } }, { status: 503 }) });
    await expect(new PicPayPaymentLinkClient(config, unavailable.fetchImpl).createCharge(input))
      .rejects.toMatchObject({ code: "PICPAY_C001", uncertain: true });
    const silent = provider({ "POST /paymentlink/create": () => { throw new TypeError("network"); } });
    await expect(new PicPayPaymentLinkClient(config, silent.fetchImpl).createCharge(input))
      .rejects.toMatchObject({ code: "PROVIDER_NO_RESPONSE", uncertain: true });
    const unreadable = provider({ "POST /paymentlink/create": () => Response.json({ link: "not a url" }, { status: 201 }) });
    await expect(new PicPayPaymentLinkClient(config, unreadable.fetchImpl).createCharge(input))
      .rejects.toMatchObject({ code: "UNRECOGNIZED_RESPONSE", uncertain: true });
  });

  it("retries once with a fresh token when the token was refused", async () => {
    let first = true;
    const { calls, fetchImpl } = provider({
      "POST /paymentlink/create": () => {
        if (first) { first = false; return new Response(null, { status: 401 }); }
        return Response.json(fixtures.created, { status: 201 });
      },
    });
    await expect(new PicPayPaymentLinkClient(config, fetchImpl).createCharge(input)).resolves.toMatchObject({ paymentLinkId: "1688060808649dc38881cdc" });
    expect(calls.filter((call) => call.url === config.tokenUrl)).toHaveLength(2);
  });

  it("reads charges, transactions, inactivation and refunds", async () => {
    const { fetchImpl } = provider({
      "GET /paymentlink/1688060808649dc38881cdc": () => Response.json(fixtures.found),
      "GET /paymentlink/1688060808649dc38881cdc/transactions?page=1": () => Response.json(fixtures.transactions),
      "POST /paymentlink/1688060808649dc38881cdc/inactive": () => Response.json(fixtures.alreadyInactive, { status: 422 }),
      "POST /paymentlink/transaction/afd2901c-db02-3fda-bba4-30023baeb2a2/refund": () => Response.json(fixtures.refund),
      "POST /paymentlink/transaction/e379b4d5-791c-48c8-bc19-3e908a6de9b7/refund": () => Response.json({ error: { code: "B036" } }, { status: 400 }),
      "POST /paymentlink/transaction/9f1c6b2a-3f4e-4b8d-a6c2-22e12f5a9d74/refund": () => Response.json({ error: { code: "B036" } }, { status: 500 }),
    });
    const client = new PicPayPaymentLinkClient(config, fetchImpl);
    await expect(client.findCharge("1688060808649dc38881cdc")).resolves.toEqual({ paymentLinkId: "1688060808649dc38881cdc", status: "active", amountCents: 2590, totalSales: 1 });
    await expect(client.findCharge("17496673826849ce36a1c29")).resolves.toBeNull();
    const listed = await client.listTransactions("1688060808649dc38881cdc");
    expect(listed).toEqual({ hasNextPage: false, transactions: [
      { id: "afd2901c-db02-3fda-bba4-30023baeb2a2", status: "PAYED", amountCents: 2590 },
      { id: "b00389d2-e532-3f0e-8935-f24bb855983f", status: "REFUNDED", amountCents: 2590 },
    ] });
    await expect(client.inactivateCharge("1688060808649dc38881cdc")).resolves.toBeUndefined();
    await expect(client.refundTransaction("afd2901c-db02-3fda-bba4-30023baeb2a2", 1000)).resolves.toEqual({
      transactionId: "684065d2-6803-40f3-a76c-1108d66d8db0", amountCents: 1000, originalAmountCents: 2590,
    });
    await expect(client.refundTransaction("e379b4d5-791c-48c8-bc19-3e908a6de9b7", 1000)).rejects.toMatchObject({ code: "PICPAY_B036", uncertain: false });
    await expect(client.refundTransaction("9f1c6b2a-3f4e-4b8d-a6c2-22e12f5a9d74", 1000)).rejects.toMatchObject({ uncertain: true });
  });

  it("validates identifiers and amounts before any request", () => {
    expect(() => buildCreateChargeBody({ ...input, orderNumber: "G0123456789ABCDEF" })).toThrow(PaymentLinkProviderError);
    expect(() => buildCreateChargeBody({ ...input, amountCents: 0 })).toThrow(PaymentLinkProviderError);
    expect(paymentLinkIdFromUrl("https://link.ppay.me/p/173887430167a51dbd8ee2x")).toBe("173887430167a51dbd8ee2x");
    expect(paymentLinkIdFromUrl("http://link.ppay.me/p/173887430167a51dbd8ee2x")).toBeNull();
  });
});

describe("Payment Link webhook", () => {
  it("accepts only the configured API Key, compared in constant time", () => {
    expect(isAuthorizedPaymentLinkWebhook("a45c2dee-6435-key", "a45c2dee-6435-key")).toBe(true);
    expect(isAuthorizedPaymentLinkWebhook("a45c2dee-6435-kez", "a45c2dee-6435-key")).toBe(false);
    expect(isAuthorizedPaymentLinkWebhook("Bearer a45c2dee-6435-key", "a45c2dee-6435-key")).toBe(false);
    expect(isAuthorizedPaymentLinkWebhook("anything", undefined)).toBe(false);
    expect(isAuthorizedPaymentLinkWebhook(null, "a45c2dee-6435-key")).toBe(false);
  });

  it("reads the event type under both documented header names", () => {
    expect(paymentLinkWebhookEventType(new Headers({ "event-type": "TransactionPaymentMessage" }))).toBe("TransactionPaymentMessage");
    expect(paymentLinkWebhookEventType(new Headers({ event_type: "TransactionPaymentMessage" }))).toBe("TransactionPaymentMessage");
    expect(paymentLinkWebhookEventType(new Headers())).toBeNull();
  });

  it("maps a status query to webhook-shaped events", () => {
    expect(transactionsToStatusEvents("1688060808649dc38881cdc", [
      { id: "afd2901c-db02-3fda-bba4-30023baeb2a2", status: "PAYED", amountCents: 2590 },
      { id: "b00389d2-e532-3f0e-8935-f24bb855983f", status: "PENDING", amountCents: 2590 },
    ])).toEqual([{ type: "PAYMENT", data: { transaction: { id: "afd2901c-db02-3fda-bba4-30023baeb2a2", status: "PAYED", amount: 2590 }, charge: { paymentLinkId: "1688060808649dc38881cdc" } } }]);
  });
});

describe("Payment Link network failures", () => {
  it("keeps the runtime error name for diagnostics without request data", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))) as unknown as typeof fetch;
    const error = await new PicPayPaymentLinkClient(config, fetchImpl).findCharge("1688060808649dc38881cdc").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "AUTH_UNAVAILABLE", reason: "TimeoutError: The operation was aborted due to timeout" });
    expect(String((error as PaymentLinkProviderError).reason)).not.toContain("secret");
  });
});
