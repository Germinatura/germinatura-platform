import { NextRequest, NextResponse } from "next/server";
import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { updateSession } from "@/lib/auth";

const publicRoutes = ["/login", "/cadastro"];
const publicApiRoutes = ["/api/auth/login", "/api/cadastro", "/api/v1/health", "/api/webhooks/abacatepay"];

export default async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublicRoute = publicRoutes.includes(path);
  const isApi = path.startsWith("/api/");
  const isPublicApi = publicApiRoutes.includes(path);
  const { response, session } = await updateSession(request);

  if (isApi) {
    const requestId = createRequestId(request.headers);
    if (!session && !isPublicApi) {
      return NextResponse.json(createApiError("UNAUTHENTICATED", "Autenticação obrigatória", requestId), { status: 401 });
    }
    const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const hasBearer = request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
    if (unsafeMethod && !hasBearer && path !== "/api/webhooks/abacatepay") {
      const origin = request.headers.get("origin");
      const allowed = new Set([
        process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000",
        process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001",
      ]);
      if (!origin || !allowed.has(origin)) {
        return NextResponse.json(createApiError("INVALID_ORIGIN", "Origem não autorizada", requestId), { status: 403 });
      }
    }
    if (session?.user.perfil !== "ADMIN" && (path.startsWith("/api/admin/") || path.startsWith("/api/usuarios") || path.startsWith("/api/configuracoes/"))) {
      return NextResponse.json(createApiError("FORBIDDEN", "Permissão administrativa obrigatória", requestId), { status: 403 });
    }
    if (session?.user.perfil === "CONSUMER" && (path.startsWith("/api/pdv/") || path.startsWith("/api/vendas"))) {
      return NextResponse.json(createApiError("FORBIDDEN", "Permissão de vendedor obrigatória", requestId), { status: 403 });
    }
    return response;
  }

  if (!session && !isPublicRoute) return NextResponse.redirect(new URL("/login", request.url));
  if (!session) return response;

  if (isPublicRoute) {
    const destination = session.user.perfil === "CONSUMER" ? "/reservas" : "/";
    return NextResponse.redirect(new URL(destination, request.url));
  }

  const isReservation = path.startsWith("/reservas");
  const isRaffle = path.startsWith("/rifas");
  if (session.user.perfil === "CONSUMER" && path !== "/" && !isReservation && !isRaffle) {
    return NextResponse.redirect(new URL("/reservas", request.url));
  }
  if (session.user.perfil === "VENDEDOR" && path !== "/" && !isReservation && !isRaffle && !path.startsWith("/pdv")) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads).*)"],
};
