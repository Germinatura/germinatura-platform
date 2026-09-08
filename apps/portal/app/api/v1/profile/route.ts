import { createApiError, idempotencyKeySchema, updateProfileSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { readPrivateProfile } from "@/lib/private-profile";

async function handle(request: Request, mutate: boolean) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  try {
    const user = await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    if (mutate) {
      const parsed = updateProfileSchema.safeParse(await request.json().catch(() => null));
      const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
      if (!parsed.success || !key.success) return fail("INVALID_PROFILE", "Confira os dados do perfil.", 422);
      const value = parsed.data;
      const { error } = await client.rpc("update_my_profile", {
        p_expected_revision: value.expectedRevision, p_display_name: value.displayName,
        p_avatar_path: value.avatarPath, p_bio: value.bio, p_class_name: value.className,
        p_sweet_preferences: value.sweetPreferences, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
      });
      if (error) {
        if (error.code === "42501") return fail("FORBIDDEN", "Você não pode editar este perfil.", 403);
        if (["PROFILE_REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS"].includes(error.message))
          return fail(error.message, "O perfil foi alterado em outra sessão ou esta solicitação já está em processamento. Recarregue o perfil antes de editar novamente.", 409);
        if (error.code === "22023" || error.code === "23514") return fail("INVALID_PROFILE", "Confira os dados e a foto do perfil.", 422);
        return fail("PROFILE_UNAVAILABLE", "Não foi possível confirmar a alteração. Tente novamente.", 503);
      }
    }
    return NextResponse.json({ data: await readPrivateProfile(client, user.id), request_id: requestId }, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("PROFILE_UNAVAILABLE", "Não foi possível consultar o perfil. Tente novamente.", 503);
  }
}
export const GET = (request: Request) => handle(request, false);
export const PATCH = (request: Request) => handle(request, true);
