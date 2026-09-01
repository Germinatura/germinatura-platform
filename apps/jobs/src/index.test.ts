import { describe, expect, it, vi } from "vitest";
import worker, { retryDelaySeconds, runCycle } from "./index";

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
    const response = worker.fetch(new Request("https://jobs.example/health"), env);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: "jobs" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
