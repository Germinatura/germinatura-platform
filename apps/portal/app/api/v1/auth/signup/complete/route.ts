import { createApiError, signupCompleteSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = signupCompleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_PROFILE", "Revise nome, username, senha e foto", requestId, parsed.error.issues), { status: 422 });
  try {
    const client = await createSupabaseServerClient();
    const { data: authData } = await client.auth.getUser();
    if (!authData.user?.email_confirmed_at) {
      return NextResponse.json(createApiError("EMAIL_NOT_VERIFIED", "Confirme o email antes de concluir", requestId), { status: 401 });
    }
    const { error: passwordError } = await client.auth.updateUser({ password: parsed.data.password });
    if (passwordError) return NextResponse.json(createApiError("PASSWORD_REJECTED", "A senha não pôde ser definida", requestId), { status: 422 });
    const { data, error } = await client.rpc("complete_my_profile", {
      p_display_name: parsed.data.displayName,
      p_username: parsed.data.username,
      p_avatar_path: parsed.data.avatarPath,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error?.message.includes("USERNAME_ALREADY_USED")) {
      return NextResponse.json(createApiError("USERNAME_ALREADY_USED", "Este username já está em uso", requestId), { status: 409 });
    }
    if (error) throw error;
    return NextResponse.json({ data, request_id: requestId }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch {
    return NextResponse.json(createApiError("AUTH_UNAVAILABLE", "Não foi possível concluir o cadastro", requestId), { status: 503 });
  }
}
