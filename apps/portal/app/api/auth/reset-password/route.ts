import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const { novaSenha } = (await request.json()) as { novaSenha?: string };
  if (!novaSenha || novaSenha.length < 8) {
    return NextResponse.json(createApiError("VALIDATION_ERROR", "A nova senha deve ter no mínimo 8 caracteres", requestId), { status: 422 });
  }
  const client = await createSupabaseServerClient();
  const { error } = await client.auth.updateUser({ password: novaSenha });
  if (error) {
    return NextResponse.json(createApiError("PASSWORD_UPDATE_FAILED", "Não foi possível atualizar a senha", requestId), { status: 400 });
  }
  return NextResponse.json({ message: "Senha alterada com sucesso" });
}
