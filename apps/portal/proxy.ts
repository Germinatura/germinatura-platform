import { NextRequest, NextResponse } from "next/server";
import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { apiAccessRule, isTrustedMutation, rolesSatisfyAccess } from "@/lib/api-security";
import { updateSession } from "@/lib/auth";

const publicRoutes = new Set(["/login", "/cadastro", "/cadastro/perfil", "/esqueci-senha", "/recuperar-senha"]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function apiError(code: string, message: string, requestId: string, status: number, headers?: HeadersInit) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId, ...headers },
  });
}

export default async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  const { response, session } = await updateSession(request);

  if (isApi) {
    const requestId = createRequestId(request.headers);
    const rule = apiAccessRule(path);

    if (rule && !rule.methods.includes(request.method)) {
      return apiError("METHOD_NOT_ALLOWED", "Método não permitido", requestId, 405, { Allow: rule.methods.join(", ") });
    }
    if ((!rule || rule.access !== "public") && (!session || !session.user.onboardingCompleted)) {
      return apiError("UNAUTHENTICATED", "Autenticação obrigatória", requestId, 401);
    }
    if (rule && session && !rolesSatisfyAccess(session.user.roles, rule.access)) {
      return apiError("FORBIDDEN", "Permissão insuficiente", requestId, 403);
    }
    if (!safeMethods.has(request.method) && !isTrustedMutation(request)) {
      return apiError("INVALID_ORIGIN", "Origem não autorizada", requestId, 403);
    }

    response.headers.set("Cache-Control", "no-store");
    response.headers.set("x-request-id", requestId);
    return response;
  }

  const isPublicRoute = publicRoutes.has(path);
  if (!session && !isPublicRoute) return NextResponse.redirect(new URL("/login", request.url));
  if (session && !session.user.onboardingCompleted && path !== "/cadastro/perfil") {
    return NextResponse.redirect(new URL("/cadastro/perfil", request.url));
  }
  if (session?.user.onboardingCompleted && isPublicRoute && path !== "/recuperar-senha") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
