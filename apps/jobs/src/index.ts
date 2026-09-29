import {
  isAuthorizedPaymentLinkWebhook, paymentLinkConfigFromEnv, PaymentLinkProviderError, paymentLinkWebhookEventType,
  PicPayPaymentLinkClient, transactionsToStatusEvents, type PaymentLinkEnv, type PaymentLinkGateway,
} from "@germinatura/payments";

interface Env extends PaymentLinkEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  /** API Key shown by the PicPay panel when the notification URL is saved; sent in the `authorization` header. */
  PICPAY_PAYMENT_LINK_WEBHOOK_KEY?: string;
}

interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }
interface ScheduledControllerLike { scheduledTime: number }
interface ClaimedEvent { id: string; attempts: number }
interface ClaimedPaymentLink { charge_id: string; order_number: string; amount_cents: number; name: string; expires_on: string }

interface ClaimedLinkReference { charge_id: string; provider_link_id: string }
interface ClaimedRefund { refund_id: string; transaction_id: string; amount_cents: number }

export interface PaymentLinkMetrics { configured: boolean; created: number; failed: number; uncertain: number }
export interface PaymentLinkMaintenanceMetrics {
  configured: boolean;
  inactivated: number;
  inactivationErrors: number;
  polled: number;
  pollErrors: number;
  statusEvents: number;
  refundsAccepted: number;
  refundsFailed: number;
  refundsUncertain: number;
}

export interface CycleMetrics {
  expired: Record<string, number>;
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  outbox: Record<string, number>;
  paymentLinks: PaymentLinkMetrics | { errors: number };
  paymentLinkMaintenance: PaymentLinkMaintenanceMetrics | { errors: number };
}

const paymentLinkWebhookPath = "/webhooks/picpay/payment-link";
const maxWebhookBytes = 65_536;

function assertEnvironment(env: Env) {
  if (!env.SUPABASE_URL.startsWith("https://") && !env.SUPABASE_URL.startsWith("http://127.0.0.1")) throw new Error("INVALID_SUPABASE_URL");
  if (!env.SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY_MISSING");
}

async function rpc<T>(env: Env, name: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`RPC_${name.toUpperCase()}_${response.status}`);
  return response.json() as Promise<T>;
}

export function retryDelaySeconds(attempts: number) {
  return Math.min(900, 5 * 2 ** Math.max(0, attempts - 1));
}

export async function runCycle(env: Env, fetchImpl: typeof fetch = fetch): Promise<CycleMetrics> {
  assertEnvironment(env);
  const workerId = `jobs-${crypto.randomUUID()}`;
  let expired: Record<string, number> = {};
  try { expired = await rpc(env, "worker_expire_due_reservations", { p_limit: 100 }, fetchImpl); } catch { expired = { errors: 1 }; }
  const claimed = await rpc<ClaimedEvent[]>(env, "worker_claim_outbox_events", {
    p_worker_id: workerId, p_batch_size: 50, p_lease_seconds: 300,
  }, fetchImpl);
  let published = 0;
  let retried = 0;
  let failed = 0;
  for (const event of claimed) {
    try {
      await rpc(env, "worker_process_outbox_event", { p_event_id: event.id, p_worker_id: workerId }, fetchImpl);
      published += 1;
    } catch {
      const result = await rpc<{ status: "PENDING" | "FAILED" }>(env, "worker_retry_outbox_event", {
        p_event_id: event.id,
        p_worker_id: workerId,
        p_error: "OUTBOX_PROCESSING_FAILED",
        p_backoff_seconds: retryDelaySeconds(event.attempts),
        p_max_attempts: 8,
      }, fetchImpl);
      if (result.status === "FAILED") failed += 1;
      else retried += 1;
    }
  }
  const outbox = await rpc<Record<string, number>>(env, "worker_outbox_metrics", {}, fetchImpl);
  let paymentLinks: CycleMetrics["paymentLinks"];
  try { paymentLinks = await createRequestedPaymentLinks(env, workerId, fetchImpl); } catch { paymentLinks = { errors: 1 }; }
  let paymentLinkMaintenance: CycleMetrics["paymentLinkMaintenance"];
  try { paymentLinkMaintenance = await maintainPaymentLinks(env, workerId, fetchImpl); } catch { paymentLinkMaintenance = { errors: 1 }; }
  return { expired, claimed: claimed.length, published, retried, failed, outbox, paymentLinks, paymentLinkMaintenance };
}

const providerErrorCode = (error: unknown) => error instanceof PaymentLinkProviderError ? error.code : "UNEXPECTED_ERROR";

/**
 * Everything after creation, decided by the database: inactivate links of sales that stopped waiting for
 * payment, read transactions of open links (recovering lost webhooks through the same exactly-once path) and
 * submit refunds once. Refunds without an answer are uncertain and never resubmitted.
 */
export async function maintainPaymentLinks(
  env: Env, workerId: string, fetchImpl: typeof fetch = fetch, gateway?: PaymentLinkGateway,
): Promise<PaymentLinkMaintenanceMetrics> {
  const config = paymentLinkConfigFromEnv(env);
  const provider = gateway ?? (config ? new PicPayPaymentLinkClient(config, fetchImpl) : null);
  const metrics: PaymentLinkMaintenanceMetrics = {
    configured: Boolean(provider), inactivated: 0, inactivationErrors: 0, polled: 0, pollErrors: 0, statusEvents: 0,
    refundsAccepted: 0, refundsFailed: 0, refundsUncertain: 0,
  };
  if (!provider) return metrics;

  const inactivations = await rpc<ClaimedLinkReference[]>(env, "worker_claim_payment_link_inactivations", {
    p_worker_id: workerId, p_limit: 10, p_lease_seconds: 120,
  }, fetchImpl);
  for (const claim of inactivations) {
    let errorCode: string | null = null;
    try { await provider.inactivateCharge(claim.provider_link_id); } catch (error) { errorCode = providerErrorCode(error); }
    await rpc(env, "worker_record_payment_link_inactivation", {
      p_charge_id: claim.charge_id, p_worker_id: workerId, p_error_code: errorCode,
    }, fetchImpl);
    if (errorCode) metrics.inactivationErrors += 1;
    else metrics.inactivated += 1;
  }

  const checks = await rpc<ClaimedLinkReference[]>(env, "worker_claim_payment_link_status_checks", {
    p_worker_id: workerId, p_limit: 20,
  }, fetchImpl);
  for (const check of checks) {
    try {
      for (let page = 1; page <= 5; page += 1) {
        const { transactions, hasNextPage } = await provider.listTransactions(check.provider_link_id, page);
        for (const event of transactionsToStatusEvents(check.provider_link_id, transactions)) {
          await rpc(env, "worker_record_payment_link_event", { p_source: "STATUS_QUERY", p_event_type: null, p_payload: event }, fetchImpl);
          metrics.statusEvents += 1;
        }
        if (!hasNextPage) break;
      }
      metrics.polled += 1;
    } catch {
      // The next window polls again; reading is always safe to repeat.
      metrics.pollErrors += 1;
    }
  }

  const refunds = await rpc<ClaimedRefund[]>(env, "worker_claim_payment_link_refunds", {
    p_worker_id: workerId, p_limit: 10, p_lease_seconds: 120,
  }, fetchImpl);
  for (const refund of refunds) {
    try {
      const accepted = await provider.refundTransaction(refund.transaction_id, refund.amount_cents);
      await rpc(env, "worker_record_payment_link_refund", {
        p_refund_id: refund.refund_id, p_worker_id: workerId, p_outcome: "ACCEPTED",
        p_provider_refund_id: /^[A-Za-z0-9-]{8,64}$/.test(accepted.transactionId) ? accepted.transactionId : null,
        p_original_amount_cents: accepted.originalAmountCents, p_error_code: null,
      }, fetchImpl);
      metrics.refundsAccepted += 1;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("RPC_")) {
        // Submitted but not recorded: the lease expiry turns it into an uncertain refund.
        metrics.refundsUncertain += 1;
        continue;
      }
      const uncertain = !(error instanceof PaymentLinkProviderError) || error.uncertain;
      await rpc(env, "worker_record_payment_link_refund", {
        p_refund_id: refund.refund_id, p_worker_id: workerId, p_outcome: uncertain ? "UNCERTAIN" : "FAILED",
        p_provider_refund_id: null, p_original_amount_cents: null, p_error_code: providerErrorCode(error),
      }, fetchImpl);
      if (uncertain) metrics.refundsUncertain += 1;
      else metrics.refundsFailed += 1;
    }
  }
  return metrics;
}

/**
 * Creates the links sellers asked for. Without full provider configuration nothing is claimed, so requests wait
 * untouched (fail-closed). A creation the provider may have performed without answering is recorded as
 * uncertain and never retried automatically.
 */
export async function createRequestedPaymentLinks(
  env: Env, workerId: string, fetchImpl: typeof fetch = fetch, gateway?: PaymentLinkGateway,
): Promise<PaymentLinkMetrics> {
  const config = paymentLinkConfigFromEnv(env);
  const provider = gateway ?? (config ? new PicPayPaymentLinkClient(config, fetchImpl) : null);
  const metrics: PaymentLinkMetrics = { configured: Boolean(provider), created: 0, failed: 0, uncertain: 0 };
  if (!provider) return metrics;
  const claims = await rpc<ClaimedPaymentLink[]>(env, "worker_claim_payment_link_requests", {
    p_worker_id: workerId, p_limit: 10, p_lease_seconds: 120,
  }, fetchImpl);
  for (const claim of claims) {
    let created;
    try {
      created = await provider.createCharge({
        orderNumber: claim.order_number, name: claim.name, amountCents: claim.amount_cents, expiresOn: claim.expires_on,
      });
    } catch (error) {
      const uncertain = !(error instanceof PaymentLinkProviderError) || error.uncertain;
      await rpc(env, "worker_record_payment_link_failure", {
        p_charge_id: claim.charge_id, p_worker_id: workerId, p_uncertain: uncertain,
        p_error_code: error instanceof PaymentLinkProviderError ? error.code : "UNEXPECTED_ERROR",
      }, fetchImpl);
      if (uncertain) metrics.uncertain += 1;
      else metrics.failed += 1;
      continue;
    }
    try {
      await rpc(env, "worker_record_payment_link_created", {
        p_charge_id: claim.charge_id, p_worker_id: workerId, p_provider_link_id: created.paymentLinkId,
        p_checkout_url: created.checkoutUrl, p_brcode: created.brcode, p_expires_at: created.expiresAt,
      }, fetchImpl);
      metrics.created += 1;
    } catch {
      // The link exists but was not recorded; when the lease expires the request becomes uncertain.
      metrics.uncertain += 1;
    }
  }
  return metrics;
}

/** PicPay webhook: authenticated by the configured API Key, stored raw and applied once by the database. */
export async function handlePaymentLinkWebhook(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!env.PICPAY_PAYMENT_LINK_WEBHOOK_KEY) return Response.json({ status: "unavailable" }, { status: 503, headers });
  if (!isAuthorizedPaymentLinkWebhook(request.headers.get("authorization"), env.PICPAY_PAYMENT_LINK_WEBHOOK_KEY)) {
    return Response.json({ status: "unauthorized" }, { status: 401, headers });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxWebhookBytes) return Response.json({ status: "too_large" }, { status: 413, headers });
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return Response.json({ status: "invalid" }, { status: 400, headers }); }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return Response.json({ status: "invalid" }, { status: 400, headers });
  try {
    assertEnvironment(env);
    const result = await rpc<{ outcome: string; duplicate: boolean }>(env, "worker_record_payment_link_event", {
      p_source: "WEBHOOK", p_event_type: paymentLinkWebhookEventType(request.headers), p_payload: payload,
    }, fetchImpl);
    console.log(JSON.stringify({ event: "payment_link.webhook.received", outcome: result.outcome, duplicate: result.duplicate }));
    return Response.json({ status: "received" }, { headers });
  } catch {
    // Nothing was stored; a non-2xx answer lets the provider deliver again.
    console.error(JSON.stringify({ event: "payment_link.webhook.failed" }));
    return Response.json({ status: "retry" }, { status: 500, headers });
  }
}

export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === paymentLinkWebhookPath) return handlePaymentLinkWebhook(request, env);
    if (request.method !== "GET" || url.pathname !== "/health") return new Response("Not found", { status: 404 });
    try {
      assertEnvironment(env);
      return Response.json({ status: "ok", service: "jobs" }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ status: "unavailable", service: "jobs" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  },
  scheduled(_controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike) {
    context.waitUntil(runCycle(env).then((metrics) => {
      console.log(JSON.stringify({ event: "jobs.cycle.completed", ...metrics }));
    }).catch(() => {
      console.error(JSON.stringify({ event: "jobs.cycle.failed" }));
    }));
  },
};
