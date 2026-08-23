import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const session = await getSession();
  if (!session) {
    return NextResponse.json(createApiError("UNAUTHENTICATED", "Sessão ausente ou expirada", requestId), { status: 401 });
  }
  return NextResponse.json(
    { user: session.user, request_id: requestId },
    { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
  );
}
