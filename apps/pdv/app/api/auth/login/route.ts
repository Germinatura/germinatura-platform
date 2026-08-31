import { credentialLoginRequestSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { createPdvSupabaseAdminClient } from "@/lib/supabase-admin";
import { createPdvSupabaseServerClient } from "@/lib/supabase-server";

const genericMessage = "Usuário/e-mail ou senha inválidos";

function response(code: string, message: string, status: number) {
  return NextResponse.json({ code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

function trustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const configured = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
  try {
    return origin !== null && new URL(origin).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

async function loginSubjectHash(identifier: string, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const bytes = new TextEncoder().encode(`LOGIN:${identifier}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  if (!trustedOrigin(request)) return response("INVALID_ORIGIN", "Origem não autorizada", 403);
  const parsed = credentialLoginRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response("INVALID_CREDENTIALS", genericMessage, 422);

  try {
    const admin = createPdvSupabaseAdminClient();
    const { data: resolved, error: resolveError } = await admin.rpc("resolve_login_identifier", {
      p_identifier: parsed.data.identifier,
    });
    if (resolveError) throw new Error("IDENTIFIER_RESOLUTION_UNAVAILABLE");
    const resolvedRecord = resolved && typeof resolved === "object" ? resolved as Record<string, unknown> : null;
    const email = typeof resolvedRecord?.email === "string"
      ? resolvedRecord.email
      : `invalid.${crypto.randomUUID()}@institutojef.org.br`;

    const client = await createPdvSupabaseServerClient();
    const { error } = await client.auth.signInWithPassword({ email, password: parsed.data.password });
    if (error) {
      await client.auth.signOut();
      const { data: allowed, error: limitError } = await admin.rpc("consume_institutional_auth_rate_limit", {
        p_scope: "LOGIN",
        p_subject_hash: await loginSubjectHash(parsed.data.identifier, request),
      });
      if (limitError || typeof allowed !== "boolean") throw new Error("LOGIN_RATE_LIMIT_UNAVAILABLE");
      if (!allowed) return response("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.", 429);
      return response("INVALID_CREDENTIALS", genericMessage, 401);
    }
    const { data: sessionData, error: sessionError } = await client.rpc("get_my_session");
    const record = sessionData && typeof sessionData === "object" ? sessionData as Record<string, unknown> : null;
    const roles = Array.isArray(record?.roles) ? record.roles : [];
    if (
      sessionError
      || record?.active !== true
      || record?.onboarding_completed !== true
      || (!roles.includes("ADMIN") && !roles.includes("VENDEDOR"))
    ) {
      await client.auth.signOut();
      const { data: allowed, error: limitError } = await admin.rpc("consume_institutional_auth_rate_limit", {
        p_scope: "LOGIN",
        p_subject_hash: await loginSubjectHash(parsed.data.identifier, request),
      });
      if (limitError || typeof allowed !== "boolean") throw new Error("LOGIN_RATE_LIMIT_UNAVAILABLE");
      if (!allowed) return response("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.", 429);
      return response("INVALID_CREDENTIALS", genericMessage, 401);
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return response("AUTH_UNAVAILABLE", "Autenticação temporariamente indisponível", 503);
  }
}
