// PicPay Payment Link adapter (ADR 0010). Shapes follow the official OpenAPI published with the sandbox
// documentation (paths /oauth2/token, /paymentlink/create, /paymentlink/{id}, /paymentlink/{id}/transactions,
// /paymentlink/{id}/inactive, /paymentlink/transaction/{id}/refund) and the webhook page. Nothing here has a
// default endpoint or credential: without full configuration there is no client (fail-closed).

export interface PaymentLinkConfig {
  tokenUrl: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}

export interface PaymentLinkEnv {
  PICPAY_PAYMENT_LINK_TOKEN_URL?: string;
  PICPAY_PAYMENT_LINK_API_BASE_URL?: string;
  PICPAY_PAYMENT_LINK_CLIENT_ID?: string;
  PICPAY_PAYMENT_LINK_CLIENT_SECRET?: string;
}

const httpsUrl = (value: string | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.search && !url.hash ? url.href.replace(/\/$/, "") : null;
  } catch { return null; }
};

/** Returns the configuration only when every value is present and both URLs are plain HTTPS. */
export function paymentLinkConfigFromEnv(env: PaymentLinkEnv, timeoutMs = 10_000): PaymentLinkConfig | null {
  const tokenUrl = httpsUrl(env.PICPAY_PAYMENT_LINK_TOKEN_URL);
  const apiBaseUrl = httpsUrl(env.PICPAY_PAYMENT_LINK_API_BASE_URL);
  const clientId = env.PICPAY_PAYMENT_LINK_CLIENT_ID?.trim();
  const clientSecret = env.PICPAY_PAYMENT_LINK_CLIENT_SECRET?.trim();
  if (!tokenUrl || !apiBaseUrl || !clientId || !clientSecret) return null;
  return { tokenUrl, apiBaseUrl, clientId, clientSecret, timeoutMs };
}

/**
 * `uncertain` means the provider may have acted without answering (timeout, network failure or 5xx on a
 * mutation). Such an operation must not be repeated automatically; it goes to recovery.
 */
export class PaymentLinkProviderError extends Error {
  constructor(readonly code: string, readonly uncertain: boolean, readonly status?: number) {
    super(`Payment Link provider error: ${code}`);
    this.name = "PaymentLinkProviderError";
  }
}

export interface CreatePaymentLinkInput {
  orderNumber: string;
  name: string;
  amountCents: number;
  /** Calendar date (YYYY-MM-DD); the provider takes a date, not a time. */
  expiresOn: string;
  redirectUrl?: string;
}

export interface CreatedPaymentLink {
  paymentLinkId: string;
  checkoutUrl: string;
  brcode: string | null;
  expiresAt: string | null;
  amountCents: number;
}

export interface PaymentLinkCharge {
  paymentLinkId: string;
  status: "active" | "expired" | "deleted";
  amountCents: number | null;
  totalSales: number;
}

export interface PaymentLinkTransaction { id: string; status: string; amountCents: number }
export interface PaymentLinkRefund { transactionId: string; amountCents: number; originalAmountCents: number }

export interface PaymentLinkGateway {
  createCharge(input: CreatePaymentLinkInput): Promise<CreatedPaymentLink>;
  findCharge(paymentLinkId: string): Promise<PaymentLinkCharge | null>;
  listTransactions(paymentLinkId: string, page?: number): Promise<{ transactions: PaymentLinkTransaction[]; hasNextPage: boolean }>;
  inactivateCharge(paymentLinkId: string): Promise<void>;
  refundTransaction(transactionId: string, amountCents: number): Promise<PaymentLinkRefund>;
}

const providerIdPattern = /^[A-Za-z0-9-]{8,64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const centsOf = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The link id is the last path segment of the returned link (sandbox "Cenários de Teste"). */
export function paymentLinkIdFromUrl(link: unknown): string | null {
  if (typeof link !== "string") return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    const id = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return providerIdPattern.test(id) ? id : null;
  } catch { return null; }
}

/** Request body for /paymentlink/create: Pix, PicPay wallet and card in one installment, no delivery fee. */
export function buildCreateChargeBody(input: CreatePaymentLinkInput) {
  if (!/^[A-Za-z0-9-]{1,15}$/.test(input.orderNumber)) throw new PaymentLinkProviderError("INVALID_ORDER_NUMBER", false);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 999_999_999) {
    throw new PaymentLinkProviderError("INVALID_AMOUNT", false);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn)) throw new PaymentLinkProviderError("INVALID_EXPIRY", false);
  return {
    charge: {
      name: input.name.slice(0, 120),
      order_number: input.orderNumber,
      ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      payment: { methods: ["BRCODE", "CREDIT_CARD"], brcode_arrangements: ["PICPAY", "PIX"] },
      amounts: { product: input.amountCents, delivery: 0 },
    },
    // Creating a Pix key on the merchant account is an account decision, not a side effect of a sale.
    options: { allow_create_pix_key: false, card_max_installment_number: 1, expired_at: input.expiresOn },
  };
}

async function providerCode(response: Response) {
  const body = await response.json().catch(() => null) as unknown;
  const error = isRecord(body) ? (isRecord(body.error) ? body.error : isRecord(body.errors) ? body.errors : null) : null;
  const code = error && typeof error.code === "string" && /^[A-Z0-9]{2,16}$/.test(error.code) ? error.code : null;
  return code ? `PICPAY_${code}` : `HTTP_${response.status}`;
}

export class PicPayPaymentLinkClient implements PaymentLinkGateway {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly config: PaymentLinkConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt > this.now()) return this.token.value;
    // Concurrent callers share one token request (the provider asks clients to avoid duplicate tokens).
    this.pendingToken ??= this.requestToken().finally(() => { this.pendingToken = null; });
    return this.pendingToken;
  }

  private async requestToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch { throw new PaymentLinkProviderError("AUTH_UNAVAILABLE", false); }
    if (!response.ok) throw new PaymentLinkProviderError(response.status >= 500 ? "AUTH_UNAVAILABLE" : "AUTH_REJECTED", false, response.status);
    const body = await response.json().catch(() => null) as unknown;
    if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token) {
      throw new PaymentLinkProviderError("AUTH_INVALID_RESPONSE", false);
    }
    const lifetimeSeconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
    // Renew 30 seconds early; tokens are documented to last five minutes.
    this.token = { value: body.access_token, expiresAt: this.now() + Math.max(0, lifetimeSeconds - 30) * 1000 };
    return this.token.value;
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, mutation: boolean): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt > 0);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch {
        throw new PaymentLinkProviderError(mutation ? "PROVIDER_NO_RESPONSE" : "PROVIDER_UNAVAILABLE", mutation);
      }
      // An expired token is rejected before anything happens, so one retry with a fresh token is safe.
      if (response.status === 401 && attempt === 0) { this.token = null; continue; }
      if (response.status >= 500) throw new PaymentLinkProviderError(await providerCode(response), mutation, response.status);
      return response;
    }
    throw new PaymentLinkProviderError("AUTH_REJECTED", false, 401);
  }

  async createCharge(input: CreatePaymentLinkInput): Promise<CreatedPaymentLink> {
    const response = await this.call("POST", "/paymentlink/create", buildCreateChargeBody(input), true);
    if (!response.ok) throw new PaymentLinkProviderError(await providerCode(response), false, response.status);
    const body = await response.json().catch(() => null) as unknown;
    const paymentLinkId = isRecord(body) ? paymentLinkIdFromUrl(body.link) : null;
    // Created but unidentifiable: the link may exist, so this is uncertain rather than failed.
    if (!isRecord(body) || !paymentLinkId || typeof body.link !== "string") throw new PaymentLinkProviderError("UNRECOGNIZED_RESPONSE", true, response.status);
    const amountCents = centsOf(body.amount);
    if (amountCents !== null && amountCents !== input.amountCents) throw new PaymentLinkProviderError("AMOUNT_ECHO_MISMATCH", true, response.status);
    return {
      paymentLinkId, checkoutUrl: body.link,
      brcode: typeof body.brcode === "string" ? body.brcode : null,
      expiresAt: typeof body.expirationDate === "string" ? body.expirationDate : null,
      amountCents: amountCents ?? input.amountCents,
    };
  }

  async findCharge(paymentLinkId: string): Promise<PaymentLinkCharge | null> {
    if (!providerIdPattern.test(paymentLinkId)) throw new PaymentLinkProviderError("INVALID_LINK_ID", false);
    const response = await this.call("GET", `/paymentlink/${paymentLinkId}`, null, false);
    if (response.status === 404) return null;
    if (!response.ok) throw new PaymentLinkProviderError(await providerCode(response), false, response.status);
    const body = await response.json().catch(() => null) as unknown;
    const charge = isRecord(body) && isRecord(body.details) && isRecord(body.details.charge) ? body.details.charge : null;
    if (!charge || (charge.status !== "active" && charge.status !== "expired" && charge.status !== "deleted")) {
      throw new PaymentLinkProviderError("UNRECOGNIZED_RESPONSE", false, response.status);
    }
    return {
      paymentLinkId, status: charge.status, amountCents: centsOf(charge.amount),
      totalSales: centsOf(charge.totalSales) ?? 0,
    };
  }

  async listTransactions(paymentLinkId: string, page = 1) {
    if (!providerIdPattern.test(paymentLinkId)) throw new PaymentLinkProviderError("INVALID_LINK_ID", false);
    const response = await this.call("GET", `/paymentlink/${paymentLinkId}/transactions?page=${Math.max(1, Math.trunc(page))}`, null, false);
    if (response.status === 404) return { transactions: [], hasNextPage: false };
    if (!response.ok) throw new PaymentLinkProviderError(await providerCode(response), false, response.status);
    const body = await response.json().catch(() => null) as unknown;
    if (!isRecord(body) || !Array.isArray(body.transactions)) throw new PaymentLinkProviderError("UNRECOGNIZED_RESPONSE", false, response.status);
    const transactions = body.transactions.flatMap((item): PaymentLinkTransaction[] => {
      if (!isRecord(item)) return [];
      // The reference shows both `id` and `transactionId` for the same field.
      const id = typeof item.id === "string" ? item.id : typeof item.transactionId === "string" ? item.transactionId : null;
      const amountCents = centsOf(item.amount);
      return id && providerIdPattern.test(id) && typeof item.status === "string" && amountCents !== null
        ? [{ id, status: item.status, amountCents }] : [];
    });
    return { transactions, hasNextPage: typeof body.nextPage === "string" && body.nextPage.length > 0 };
  }

  async inactivateCharge(paymentLinkId: string): Promise<void> {
    if (!providerIdPattern.test(paymentLinkId)) throw new PaymentLinkProviderError("INVALID_LINK_ID", false);
    const response = await this.call("POST", `/paymentlink/${paymentLinkId}/inactive`, null, true);
    if (response.ok) return;
    const code = await providerCode(response);
    // B038: the link was already inactive, which is the desired end state.
    if (code === "PICPAY_B038") return;
    throw new PaymentLinkProviderError(code, false, response.status);
  }

  async refundTransaction(transactionId: string, amountCents: number): Promise<PaymentLinkRefund> {
    if (!providerIdPattern.test(transactionId)) throw new PaymentLinkProviderError("INVALID_TRANSACTION_ID", false);
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents >= 999_999_999) throw new PaymentLinkProviderError("INVALID_AMOUNT", false);
    const response = await this.call("POST", `/paymentlink/transaction/${transactionId}/refund`, { amount: amountCents }, true);
    if (!response.ok) throw new PaymentLinkProviderError(await providerCode(response), false, response.status);
    const body = await response.json().catch(() => null) as unknown;
    const refunded = isRecord(body) ? centsOf(body.amount) : null;
    const original = isRecord(body) ? centsOf(body.originalAmount) : null;
    if (!isRecord(body) || typeof body.transactionId !== "string" || refunded === null || original === null) {
      throw new PaymentLinkProviderError("UNRECOGNIZED_RESPONSE", true, response.status);
    }
    return { transactionId: body.transactionId, amountCents: refunded, originalAmountCents: original };
  }
}

/** Compares the webhook `authorization` header with the configured API Key in constant time. */
export function isAuthorizedPaymentLinkWebhook(header: string | null, apiKey: string | undefined): boolean {
  if (!header || !apiKey) return false;
  const received = new TextEncoder().encode(header);
  const expected = new TextEncoder().encode(apiKey);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ (received[index] ?? 0);
  return difference === 0;
}

/** The webhook page names the header `event_type` in the text and `event-type` in the examples. */
export function paymentLinkWebhookEventType(headers: Headers): string | null {
  return headers.get("event_type") ?? headers.get("event-type");
}

/**
 * Turns an official transactions query into events with the webhook shape, so a missed notice is recovered
 * through the same exactly-once path (source STATUS_QUERY).
 */
export function transactionsToStatusEvents(paymentLinkId: string, transactions: PaymentLinkTransaction[]) {
  return transactions.flatMap((transaction) => {
    const type = transaction.status === "PAYED" ? "PAYMENT"
      : transaction.status === "REFUNDED" || transaction.status === "PARTREFUNDED" ? "REFUND" : null;
    return type ? [{
      type,
      data: {
        transaction: { id: transaction.id, status: transaction.status, amount: transaction.amountCents },
        charge: { paymentLinkId },
      },
    }] : [];
  });
}
