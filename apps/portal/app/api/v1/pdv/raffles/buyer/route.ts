import { createApiError, raffleBuyerLookupResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const rowSchema = z.object({ profile_id: z.uuid(), display_name: z.string() }).nullable();

/** Spec 6.15 / 15.5: finds a registered buyer by exact email or username only. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const identifier = z.string().trim().min(3).max(254).safeParse(new URL(request.url).searchParams.get("identifier"));
  if (!identifier.success) return fail("INVALID_BUYER_IDENTIFIER", "Informe o e-mail ou o usuário completo", 422);
  try {
    await requirePermission("raffles.sell");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("find_raffle_buyer", { p_identifier: identifier.data });
    const row = rowSchema.safeParse(data);
    if (error || !row.success) return fail("RAFFLE_UNAVAILABLE", "Consulta temporariamente indisponível", 503);
    return NextResponse.json(raffleBuyerLookupResponseSchema.parse({
      data: row.data && { profileId: row.data.profile_id, displayName: row.data.display_name }, request_id: requestId,
    }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Consulta temporariamente indisponível", 503);
  }
}
