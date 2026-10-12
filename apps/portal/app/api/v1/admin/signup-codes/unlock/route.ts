import { createApiError, signupCodeEmailUnlockSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

// A1: releases new sign-up codes for an e-mail whose attempt is blocked. The answer never says whether it was.
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const parsed = signupCodeEmailUnlockSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INVALID_SIGNUP_UNLOCK", "Informe um e-mail institucional e o motivo (4 a 500 caracteres)", requestId), { status: 422, headers });
  }
  try {
    await requirePermission("users.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("unlock_signup_code_by_email", {
      p_email: parsed.data.email, p_reason: parsed.data.reason, p_correlation_id: crypto.randomUUID(),
    });
    if (error?.message === "SIGNUP_UNLOCK_FORBIDDEN") {
      return NextResponse.json(createApiError("FORBIDDEN", "Somente a administração da turma padrão ou o ADMIN_MASTER libera códigos de cadastro", requestId), { status: 403, headers });
    }
    if (error) throw error;
    return NextResponse.json({ data, request_id: requestId }, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(createApiError(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId), { status: error.status, headers });
    }
    return NextResponse.json(createApiError("SIGNUP_UNLOCK_FAILED", "Não foi possível liberar novos códigos", requestId), { status: 503, headers });
  }
}
