interface Env {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}

interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }
interface ScheduledControllerLike { scheduledTime: number }
interface ClaimedEvent { id: string; attempts: number }

export interface CycleMetrics {
  expired: Record<string, number>;
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  outbox: Record<string, number>;
}

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
  return { expired, claimed: claimed.length, published, retried, failed, outbox };
}

export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url);
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
