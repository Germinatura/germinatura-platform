import { createApiError, institutionalOtpRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { consumeInstitutionalRateLimit } from "@/lib/institutional-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const acceptedMessage = "Se o endereço for elegível, um código será enviado.";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = institutionalOtpRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INSTITUTIONAL_EMAIL_REQUIRED", "Use seu email @institutojef.org.br", requestId), {
      status: 422,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }

  try {
    const client = await createSupabaseServerClient();
    if (!await consumeInstitutionalRateLimit(client, "OTP_REQUEST", parsed.data.email, request)) {
      return NextResponse.json(createApiError("RATE_LIMITED", "Aguarde antes de solicitar outro código", requestId), {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "900", "x-request-id": requestId },
      });
    }
    await client.auth.signInWithOtp({
      email: parsed.data.email,
      options: { shouldCreateUser: true },
    });
    return NextResponse.json({ message: acceptedMessage, request_id: requestId }, {
      status: 202,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Autenticação temporariamente indisponível", requestId), {
      status: 503,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
