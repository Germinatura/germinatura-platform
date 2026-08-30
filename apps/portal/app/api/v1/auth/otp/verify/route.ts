import { createApiError, institutionalOtpVerifySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { consumeInstitutionalRateLimit } from "@/lib/institutional-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = institutionalOtpVerifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), {
      status: 422,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }

  try {
    const client = await createSupabaseServerClient();
    if (!await consumeInstitutionalRateLimit(client, "OTP_VERIFY", parsed.data.email, request)) {
      return NextResponse.json(createApiError("RATE_LIMITED", "Aguarde antes de tentar novamente", requestId), {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "900", "x-request-id": requestId },
      });
    }
    const { error } = await client.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.token,
      type: "email",
    });
    if (error) {
      return NextResponse.json(createApiError("INVALID_CODE", "Código inválido ou expirado", requestId), {
        status: 401,
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
      });
    }
    const session = await getSession();
    if (!session) {
      await client.auth.signOut();
      return NextResponse.json(createApiError("ACCESS_DISABLED", "Acesso institucional indisponível", requestId), {
        status: 403,
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
      });
    }
    return NextResponse.json({ message: "Código confirmado", user: session.user, request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Autenticação temporariamente indisponível", requestId), {
      status: 503,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
