import { createApiError, passwordRecoveryVerifySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { resolveLoginIdentifier } from "@/lib/credential-auth";
import { consumeInstitutionalRateLimit } from "@/lib/institutional-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = passwordRecoveryVerifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), { status: 422 });
  try {
    const resolved = await resolveLoginIdentifier(parsed.data.identifier);
    const client = await createSupabaseServerClient();
    if (!await consumeInstitutionalRateLimit(client, "RECOVERY_VERIFY", parsed.data.identifier, request)) {
      return NextResponse.json(createApiError("RATE_LIMITED", "Aguarde antes de tentar novamente", requestId), { status: 429 });
    }
    if (!resolved) return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), { status: 401 });
    const { error } = await client.auth.verifyOtp({ email: resolved.email, token: parsed.data.token, type: "email" });
    if (error) return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), { status: 401 });
    return NextResponse.json({ message: "Código confirmado", next: "/recuperar-senha", request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Recuperação temporariamente indisponível", requestId), { status: 503 });
  }
}
