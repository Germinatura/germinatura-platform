import { createApiError, signupRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { resolveLoginIdentifier } from "@/lib/credential-auth";
import { consumeInstitutionalRateLimit } from "@/lib/institutional-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const acceptedMessage = "Código de cadastro solicitado. Verifique também Spam e Promoções.";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = signupRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INSTITUTIONAL_EMAIL_REQUIRED", "Use seu email @institutojef.org.br", requestId), { status: 422 });
  }
  try {
    const client = await createSupabaseServerClient();
    if (!await consumeInstitutionalRateLimit(client, "SIGNUP_REQUEST", parsed.data.email, request)) {
      return NextResponse.json(createApiError("RATE_LIMITED", "Aguarde antes de solicitar outro código", requestId), {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "900", "x-request-id": requestId },
      });
    }
    const existing = await resolveLoginIdentifier(parsed.data.email);
    if (existing?.onboarding_completed) {
      return NextResponse.json(createApiError(
        "ACCOUNT_ALREADY_EXISTS",
        "Já existe uma conta para este e-mail. Entre com sua senha ou use a recuperação.",
        requestId,
      ), {
        status: 409,
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
      });
    }
    const { error } = await client.auth.signInWithOtp({
      email: parsed.data.email,
      options: { shouldCreateUser: existing === null },
    });
    if (error) {
      return NextResponse.json(createApiError(
        "EMAIL_DELIVERY_FAILED",
        "Não foi possível solicitar o código agora. Aguarde e tente novamente.",
        requestId,
      ), {
        status: error.status === 429 ? 429 : 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60", "x-request-id": requestId },
      });
    }
    return NextResponse.json({ message: acceptedMessage, request_id: requestId }, {
      status: 202,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Cadastro temporariamente indisponível", requestId), { status: 503 });
  }
}
