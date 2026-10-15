import { createApiError, signupVerifySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { consumeInstitutionalRateLimit } from "@/lib/institutional-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = signupVerifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), { status: 422 });
  try {
    const client = await createSupabaseServerClient();
    if (!await consumeInstitutionalRateLimit(client, "SIGNUP_VERIFY", parsed.data.email, request)) {
      return NextResponse.json(createApiError("RATE_LIMITED", "Aguarde antes de tentar novamente", requestId), { status: 429 });
    }
    const { error } = await client.auth.verifyOtp({ email: parsed.data.email, token: parsed.data.token, type: "email" });
    if (error) return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), { status: 401 });
    const { data } = await client.auth.getUser();
    if (!data.user || data.user.email?.toLowerCase() !== parsed.data.email) {
      await client.auth.signOut();
      return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), { status: 401 });
    }
    // A1: only now, with the session a valid code produced, does the attempt become a user (profile, explicit membership
    // in the ACTIVE default cohort, CONSUMIDOR). Idempotent. The code is already spent, so any other failure here still
    // moves on: profile completion runs the same materialization before saving anything.
    const { error: identityError } = await client.rpc("materialize_my_signup_identity", { p_correlation_id: crypto.randomUUID() });
    if (identityError?.message === "DEFAULT_COHORT_REQUIRED") {
      return NextResponse.json(createApiError("DEFAULT_COHORT_REQUIRED", "O cadastro está temporariamente fechado. Tente novamente mais tarde.", requestId), { status: 503 });
    }
    return NextResponse.json({ message: "Email confirmado", next: "/cadastro/perfil", request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Cadastro temporariamente indisponível", requestId), { status: 503 });
  }
}
