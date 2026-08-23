import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, login } from "@/lib/auth";

const loginSchema = z.object({
  email: z.email().max(254).transform((value) => value.toLowerCase().trim()),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    const parsed = loginSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        createApiError("VALIDATION_ERROR", "Email e senha são obrigatórios", requestId),
        { status: 422, headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
      );
    }
    const session = await login(parsed.data);
    return NextResponse.json(
      { message: "Login realizado com sucesso", user: session.user, request_id: requestId },
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
    );
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 500;
    const message = error instanceof AuthorizationError ? error.message : "Erro interno do servidor";
    return NextResponse.json(createApiError(status === 401 ? "INVALID_CREDENTIALS" : "INTERNAL_ERROR", message, requestId), {
      status,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
