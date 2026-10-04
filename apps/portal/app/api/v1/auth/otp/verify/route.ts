import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  return NextResponse.json(createApiError(
    "OTP_LOGIN_REMOVED",
    "Código por e-mail é usado somente no cadastro ou na recuperação de senha",
    requestId,
  ), { status: 410, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
