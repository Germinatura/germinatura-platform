import { createApiError, passwordRecoveryUnlockSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

interface RouteContext { params: Promise<{ id: string }>; }

export async function POST(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  const { id } = await context.params;
  const parsed = passwordRecoveryUnlockSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) {
    return NextResponse.json(createApiError("INVALID_RECOVERY_UNLOCK", "Usuário ou motivo inválido", requestId), { status: 422 });
  }
  try {
    await requirePermission("users.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("unlock_password_recovery", {
      p_user_id: id,
      p_reason: parsed.data.reason,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error?.message.includes("USER_NOT_FOUND")) {
      return NextResponse.json(createApiError("USER_NOT_FOUND", "Usuário não encontrado", requestId), { status: 404 });
    }
    if (error) throw error;
    return NextResponse.json({ data, request_id: requestId }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(createApiError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId), { status: error.status });
    }
    return NextResponse.json(createApiError("RECOVERY_UNLOCK_FAILED", "Não foi possível desbloquear a recuperação", requestId), { status: 503 });
  }
}
