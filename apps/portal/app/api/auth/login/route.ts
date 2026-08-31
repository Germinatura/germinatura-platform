import { createApiError, credentialLoginRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveLoginIdentifier } from "@/lib/credential-auth";
import { consumeInstitutionalRateLimit } from "@/lib/institutional-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const genericMessage = "Usuário/e-mail ou senha inválidos";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = credentialLoginRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INVALID_CREDENTIALS", genericMessage, requestId), {
      status: 422,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  try {
    const resolved = await resolveLoginIdentifier(parsed.data.identifier);
    const client = await createSupabaseServerClient();
    const email = resolved?.email ?? `invalid.${crypto.randomUUID()}@institutojef.org.br`;
    const { error } = await client.auth.signInWithPassword({ email, password: parsed.data.password });
    if (error || !resolved?.active || !resolved.onboarding_completed) {
      await client.auth.signOut();
      const allowed = await consumeInstitutionalRateLimit(client, "LOGIN", parsed.data.identifier, request);
      if (!allowed) {
        return NextResponse.json(createApiError("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.", requestId), {
          status: 429,
          headers: { "Cache-Control": "no-store", "Retry-After": "900", "x-request-id": requestId },
        });
      }
      return NextResponse.json(createApiError("INVALID_CREDENTIALS", genericMessage, requestId), {
        status: 401,
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
      });
    }
    const session = await getSession();
    if (!session?.user.onboardingCompleted) {
      await client.auth.signOut();
      const allowed = await consumeInstitutionalRateLimit(client, "LOGIN", parsed.data.identifier, request);
      if (!allowed) {
        return NextResponse.json(createApiError("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.", requestId), {
          status: 429,
          headers: { "Cache-Control": "no-store", "Retry-After": "900", "x-request-id": requestId },
        });
      }
      return NextResponse.json(createApiError("INVALID_CREDENTIALS", genericMessage, requestId), {
        status: 401,
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
      });
    }
    return NextResponse.json({ user: session.user, request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Autenticação temporariamente indisponível", requestId), {
      status: 503,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
