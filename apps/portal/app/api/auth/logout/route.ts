import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { logout, requireSession } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireSession();
  } catch {
    return NextResponse.json(createApiError("UNAUTHENTICATED", "Autenticação obrigatória", requestId), {
      status: 401,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
  await logout();
  return NextResponse.json(
    { message: "Logout realizado com sucesso", request_id: requestId },
    { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
  );
}
