import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const session = await getSession();
  if (!session) {
    return NextResponse.json(createApiError("UNAUTHENTICATED", "Sessão ausente ou expirada", requestId), {
      status: 401,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  const photo = session.user.avatarPath
    ? await (await createAuthenticatedSupabaseClient(request)).storage.from("profile-photos").createSignedUrl(session.user.avatarPath, 900) : null;
  return NextResponse.json(
    { user: { ...session.user, avatarUrl: photo?.data?.signedUrl ?? null }, request_id: requestId },
    { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
  );
}
