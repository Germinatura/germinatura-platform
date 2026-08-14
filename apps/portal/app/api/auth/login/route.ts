import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, login } from "@/lib/auth";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return NextResponse.json(
        createApiError("VALIDATION_ERROR", "Email e senha são obrigatórios", requestId),
        { status: 422 },
      );
    }
    const session = await login({ email: body.email, password: body.password });
    return NextResponse.json({ message: "Login realizado com sucesso", user: session.user });
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 500;
    const message = error instanceof AuthorizationError ? error.message : "Erro interno do servidor";
    return NextResponse.json(createApiError(status === 401 ? "INVALID_CREDENTIALS" : "INTERNAL_ERROR", message, requestId), { status });
  }
}
