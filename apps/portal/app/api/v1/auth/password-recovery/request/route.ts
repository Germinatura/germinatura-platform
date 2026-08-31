import { createApiError, passwordRecoveryRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { resolveLoginIdentifier } from "@/lib/credential-auth";
import { anonymousSubjectHash } from "@/lib/institutional-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const acceptedMessage = "Se a conta for elegível, um código de recuperação será enviado.";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = passwordRecoveryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_IDENTIFIER", "Informe usuário ou e-mail válido", requestId), { status: 422 });
  try {
    const resolved = await resolveLoginIdentifier(parsed.data.identifier);
    const admin = createSupabaseAdminClient();
    const { data: limit, error: limitError } = await admin.rpc("consume_password_recovery_request", {
      p_subject_hash: await anonymousSubjectHash("PASSWORD_RECOVERY", parsed.data.identifier, request),
      p_user_id: resolved?.user_id ?? null,
    });
    if (limitError || !limit || typeof limit !== "object") throw new Error("RECOVERY_LIMIT_UNAVAILABLE");
    const record = limit as Record<string, unknown>;
    if (record.admin_reset_required === true) {
      return NextResponse.json(createApiError("ADMIN_RESET_REQUIRED", "Limite atingido. Solicite a um administrador o desbloqueio da recuperação.", requestId), { status: 429 });
    }
    if (resolved?.active && resolved.onboarding_completed) {
      const client = await createSupabaseServerClient();
      await client.auth.signInWithOtp({
        email: resolved.email,
        options: { shouldCreateUser: false },
      });
    }
    return NextResponse.json({ message: acceptedMessage, request_id: requestId }, {
      status: 202,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Recuperação temporariamente indisponível", requestId), { status: 503 });
  }
}
