import { createApiError, userAccessUpdateSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface RouteContext { params: Promise<{ id: string }>; }

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("users.manage");
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json(createApiError("INVALID_USER", "Usuário inválido", requestId), { status: 422 });
    }
    const parsed = userAccessUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(createApiError("INVALID_ACCESS", "Papéis ou estado inválidos", requestId), { status: 422 });
    }
    const client = await createSupabaseServerClient();
    const { data, error } = await client.rpc("set_user_access", {
      p_user_id: id,
      p_roles: parsed.data.roles,
      p_active: parsed.data.active,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      const status = error.message.includes("LAST_ACTIVE_ADMIN") ? 409 : error.message.includes("USER_NOT_FOUND") ? 404 : 422;
      return NextResponse.json(createApiError("ACCESS_UPDATE_REJECTED", "Alteração de acesso rejeitada", requestId), { status });
    }
    return NextResponse.json({ data, request_id: requestId }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 500;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "ACCESS_UPDATE_FAILED", error instanceof AuthorizationError ? error.message : "Não foi possível alterar o acesso", requestId), {
      status,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
