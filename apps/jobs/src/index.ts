import {
  isAuthorizedPaymentLinkWebhook, paymentLinkConfigFromEnv, PaymentLinkProviderError, paymentLinkWebhookEventType,
  PicPayPaymentLinkClient, type PaymentLinkEnv, type PaymentLinkGateway,
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

export interface PaymentLinkMetrics { configured: boolean; created: number; failed: number; uncertain: number }

export interface CycleMetrics {
  expired: Record<string, number>;
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  outbox: Record<string, number>;
  paymentLinks: PaymentLinkMetrics | { errors: number };
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
  return { expired, claimed: claimed.length, published, retried, failed, outbox, paymentLinks };
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
