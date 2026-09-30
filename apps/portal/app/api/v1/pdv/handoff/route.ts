import { createApiError, pdvHandoffResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Spec 6.1: "Abrir PDV" — issues a single-use, 60-second code; only its hash is stored. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    await requirePermission("sales.create");
    const client = await createAuthenticatedSupabaseClient(request);
    const code = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const { data, error } = await client.rpc("create_pdv_handoff", { p_code_hash: await sha256Hex(code) });
    if (error?.message.includes("PDV_HANDOFF_RATE_LIMITED")) return fail("RATE_LIMITED", "Muitas aberturas seguidas. Aguarde alguns minutos.", 429);
    if (error?.message.includes("PDV_ACCESS_REQUIRED")) return fail("FORBIDDEN", "Sua conta não tem acesso ao PDV.", 403);
    const expiresAt = (data as { expires_at?: unknown } | null)?.expires_at;
    if (error || typeof expiresAt !== "string") return fail("PDV_HANDOFF_UNAVAILABLE", "Não foi possível abrir o PDV agora.", 503);
    const pdvUrl = new URL(process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001").origin;
    return NextResponse.json(pdvHandoffResponseSchema.parse({ data: { url: `${pdvUrl}/acesso#handoff=${code}`, expiresAt }, request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("PDV_HANDOFF_UNAVAILABLE", "Não foi possível abrir o PDV agora.", 503);
  }
}
