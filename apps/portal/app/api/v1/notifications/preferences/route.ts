import { createApiError, notificationPreferencesResponseSchema, setNotificationPreferenceRequestSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headers(requestId) });
const databaseSchema = z.array(z.object({ category: z.string(), enabled: z.boolean() }));

async function preferences(request: Request, requestId: string) {
  const client = await createAuthenticatedSupabaseClient(request);
  const { data, error } = await client.rpc("get_my_notification_preferences");
  const rows = databaseSchema.safeParse(data);
  if (error || !rows.success) return fail("PREFERENCES_UNAVAILABLE", "Preferências temporariamente indisponíveis.", requestId, 503);
  return NextResponse.json(notificationPreferencesResponseSchema.parse({ data: rows.data, request_id: requestId }), { headers: headers(requestId) });
}

/** NOTIF-004: the caller's optional notification categories (all on until turned off). */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireSession();
    return await preferences(request, requestId);
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("PREFERENCES_UNAVAILABLE", "Preferências temporariamente indisponíveis.", requestId, 503);
  }
}

/** Turns one optional category on or off; the final state is the requested one, so retries are safe. */
export async function PUT(request: Request) {
  const requestId = createRequestId(request.headers);
  const parsed = setNotificationPreferenceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("INVALID_PREFERENCE", "Preferência inválida.", requestId, 422);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { error } = await client.rpc("set_notification_preference", { p_category: parsed.data.category, p_enabled: parsed.data.enabled });
    if (error) return fail("PREFERENCES_UNAVAILABLE", "Não foi possível salvar a preferência.", requestId, 503);
    return await preferences(request, requestId);
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("PREFERENCES_UNAVAILABLE", "Preferências temporariamente indisponíveis.", requestId, 503);
  }
}
