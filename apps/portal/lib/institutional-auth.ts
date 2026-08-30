import type { SupabaseClient } from "@supabase/supabase-js";

export type InstitutionalRateLimitScope = "OTP_REQUEST" | "OTP_VERIFY";

function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function consumeInstitutionalRateLimit(
  client: SupabaseClient,
  scope: InstitutionalRateLimitScope,
  email: string,
  request: Request,
): Promise<boolean> {
  const subjectHash = await sha256(`${scope}:${email}:${requestIp(request)}`);
  const { data, error } = await client.rpc("consume_institutional_auth_rate_limit", {
    p_scope: scope,
    p_subject_hash: subjectHash,
  });
  if (error || typeof data !== "boolean") throw new Error("AUTH_RATE_LIMIT_UNAVAILABLE");
  return data;
}
