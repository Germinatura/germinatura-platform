import { createApiError, institutionalEmailSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, loginLocalFixture } from "@/lib/auth";

const localLoginSchema = z.object({
  email: institutionalEmailSchema,
  password: z.string().min(1).max(128),
}).strict();

/** Local fixture compatibility only. Production always returns 404 and uses institutional OTP. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(createApiError("NOT_FOUND", "Rota não encontrada", requestId), { status: 404 });
  }
  const parsed = localLoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(createApiError("VALIDATION_ERROR", "Credenciais locais inválidas", requestId), { status: 422 });
  }
  try {
    const session = await loginLocalFixture(parsed.data);
    return NextResponse.json({ user: session.user, request_id: requestId }, {
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 500;
    return NextResponse.json(createApiError("LOCAL_LOGIN_REJECTED", "Credenciais locais inválidas", requestId), { status });
  }
}
