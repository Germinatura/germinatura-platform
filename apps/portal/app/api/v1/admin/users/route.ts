import { adminProvisionUserSchema, adminUsersQuerySchema, adminUsersResponseSchema, appRoleSchema, createApiError } from "@germinatura/contracts";
import { z } from "zod";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const listedUserSchema = z.object({
  id: z.uuid(), email: z.string(), display_name: z.string().nullable(), username: z.string().nullable(), active: z.boolean(),
  onboarding_completed: z.boolean(), roles: z.array(appRoleSchema),
  locks: z.object({ password_recovery: z.boolean(), signup_code: z.boolean() }),
  cohorts: z.array(z.object({ id: z.uuid(), name: z.string(), active: z.boolean(), roles: z.array(appRoleSchema) })).nullable(),
  admin_master: z.boolean().nullable(),
});
const listedPageSchema = z.object({
  items: z.array(listedUserSchema), total: z.number().int(), matched: z.number().int(), offset: z.number().int(), limit: z.number().int(),
});

/**
 * ADR 0011 (PR 3): people of the request cohort, filtered and paginated by the database (list_cohort_users) with the
 * caller's own session. The service role never lists people: nobody outside the cohort is listed, counted or found.
 */
export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const responseHeaders = { "Cache-Control": "no-store", "x-request-id": requestId };
  const query = adminUsersQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return NextResponse.json(createApiError("INVALID_USER_FILTER", "Filtros de usuários inválidos.", requestId, query.error.issues), { status: 422, headers: responseHeaders });
  }
  try {
    await requirePermission("users.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_cohort_users", {
      p_query: query.data.q ?? null, p_status: query.data.status, p_onboarding: query.data.onboarding,
      p_roles: query.data.roles.length > 0 ? query.data.roles : null, p_role_match: query.data.roleMatch,
      p_cohort_id: query.data.cohort ?? null, p_offset: query.data.offset, p_limit: query.data.limit,
    });
    if (error) {
      if (error.code === "42501") return NextResponse.json(createApiError("FORBIDDEN", "Permissão insuficiente", requestId), { status: 403, headers: responseHeaders });
      if (error.message === "COHORT_REQUIRED") return NextResponse.json(createApiError("COHORT_REQUIRED", "Selecione uma turma.", requestId), { status: 409, headers: responseHeaders });
      if (error.code === "22023") return NextResponse.json(createApiError("INVALID_USER_FILTER", "Filtros de usuários inválidos.", requestId), { status: 422, headers: responseHeaders });
      throw new Error("ADMIN_USERS_QUERY_FAILED");
    }
    const page = listedPageSchema.parse(data);
    const body = adminUsersResponseSchema.parse({
      data: page.items.map((user) => ({
        id: user.id, email: user.email, displayName: user.display_name, username: user.username, active: user.active,
        onboardingCompleted: user.onboarding_completed, roles: user.roles,
        locks: { passwordRecovery: user.locks.password_recovery, signupCode: user.locks.signup_code },
        ...(user.cohorts ? { cohorts: user.cohorts } : {}),
        ...(user.admin_master === null ? {} : { adminMaster: user.admin_master }),
      })),
      page: { total: page.total, matched: page.matched, offset: page.offset, limit: page.limit },
      request_id: requestId,
    });
    return NextResponse.json(body, { headers: responseHeaders });
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(
      status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "ADMIN_USERS_UNAVAILABLE",
      error instanceof AuthorizationError ? error.message : "Não foi possível consultar os usuários",
      requestId,
    ), { status, headers: responseHeaders });
  }
}

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
  // ADR 0011: the stamp proves to the database that this provisioning created the identity (only the service role
  // writes app metadata), so an existing person can never be re-provisioned into another cohort.
  const provisioning = crypto.randomUUID();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { name: parsed.data.displayName, username: parsed.data.username },
    app_metadata: { germinatura_provisioning: provisioning },
  });
  if (createError || !created.user) {
    return NextResponse.json(createApiError("USER_ALREADY_EXISTS", "E-mail ou username já cadastrado", requestId), { status: 409 });
  }

  try {
    // ADR 0011: the identity is global (created with the service role), but the actor's authority and the new
    // person's cohort are the request cohort, checked again in the database.
    const { error: profileError } = await admin.rpc("complete_admin_provisioned_profile", {
      p_actor_id: actor.authId,
      p_user_id: created.user.id,
      p_display_name: parsed.data.displayName,
      p_username: parsed.data.username,
      p_cohort_id: actor.cohort?.id ?? null,
      p_correlation_id: provisioning,
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
