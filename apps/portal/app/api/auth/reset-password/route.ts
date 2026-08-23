import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const passwordSchema = z.object({ novaSenha: z.string().min(8).max(128) });

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireSession();
  } catch {
    return NextResponse.json(createApiError("UNAUTHENTICATED", "Autenticação obrigatória", requestId), {
      status: 401,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  const parsed = passwordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("VALIDATION_ERROR", "A nova senha deve ter entre 8 e 128 caracteres", requestId), {
      status: 422,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  const client = await createSupabaseServerClient();
  const { error } = await client.auth.updateUser({ password: parsed.data.novaSenha });
  if (error) {
    return NextResponse.json(createApiError("PASSWORD_UPDATE_FAILED", "Não foi possível atualizar a senha", requestId), {
      status: 400,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  return NextResponse.json(
    { message: "Senha alterada com sucesso", request_id: requestId },
    { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
  );
}
