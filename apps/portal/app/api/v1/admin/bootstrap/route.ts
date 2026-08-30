import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireSession();
    const client = await createSupabaseServerClient();
    const { data, error } = await client.rpc("bootstrap_first_admin", { p_correlation_id: crypto.randomUUID() });
    if (error) {
      const forbidden = error.message.includes("BOOTSTRAP_");
      return NextResponse.json(createApiError(forbidden ? "BOOTSTRAP_UNAVAILABLE" : "BOOTSTRAP_FAILED", forbidden ? "Bootstrap indisponível" : "Não foi possível concluir o bootstrap", requestId), {
        status: forbidden ? 403 : 500,
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
      });
    }
    return NextResponse.json({ data, request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 500;
    const message = error instanceof AuthorizationError ? error.message : "Não foi possível concluir o bootstrap";
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : "BOOTSTRAP_FAILED", message, requestId), {
      status,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
