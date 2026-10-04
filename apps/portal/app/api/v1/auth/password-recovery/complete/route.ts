import { createApiError, passwordRecoveryCompleteSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = passwordRecoveryCompleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_PASSWORD", "A nova senha não atende aos requisitos", requestId), { status: 422 });
  try {
    const client = await createSupabaseServerClient();
    const { data: authData } = await client.auth.getUser();
    if (!authData.user) return NextResponse.json(createApiError("RECOVERY_SESSION_REQUIRED", "Confirme o código de recuperação", requestId), { status: 401 });
    const { error: passwordError } = await client.auth.updateUser({ password: parsed.data.password });
    if (passwordError) return NextResponse.json(createApiError("PASSWORD_REJECTED", "A senha não pôde ser alterada", requestId), { status: 422 });
    const { error } = await client.rpc("complete_password_recovery", { p_correlation_id: crypto.randomUUID() });
    if (error) throw error;
    return NextResponse.json({ message: "Senha alterada com sucesso", request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Recuperação temporariamente indisponível", requestId), { status: 503 });
  }
}
