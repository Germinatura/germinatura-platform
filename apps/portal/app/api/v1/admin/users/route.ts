import { adminProvisionUserSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = adminProvisionUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("INVALID_USER", "Revise os dados da conta operacional", requestId, parsed.error.issues), { status: 422 });
  }
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission("users.manage");
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", "Permissão insuficiente", requestId), { status });
  }

  const admin = createSupabaseAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { name: parsed.data.displayName, username: parsed.data.username },
  });
  if (createError || !created.user) {
    return NextResponse.json(createApiError("USER_ALREADY_EXISTS", "E-mail ou username já cadastrado", requestId), { status: 409 });
  }

  try {
    const { error: profileError } = await admin.rpc("complete_admin_provisioned_profile", {
      p_actor_id: actor.authId,
      p_user_id: created.user.id,
      p_display_name: parsed.data.displayName,
      p_username: parsed.data.username,
      p_correlation_id: crypto.randomUUID(),
    });
    if (profileError) throw profileError;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("set_user_access", {
      p_user_id: created.user.id,
      p_roles: Array.from(new Set(["CONSUMIDOR", ...parsed.data.roles])),
      p_active: parsed.data.active,
      p_correlation_id: crypto.randomUUID(),
    });
    if (error) throw error;
    return NextResponse.json({ data: { ...data, email: parsed.data.email, username: parsed.data.username }, request_id: requestId }, {
      status: 201,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json(createApiError("USER_PROVISIONING_FAILED", "A conta não pôde ser provisionada", requestId), { status: 503 });
  }
}
