import { NextRequest, NextResponse } from "next/server";
import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { apiAccessRule, isTrustedMutation, readAllowedInAll, rolesSatisfyAccess, writeNeedsCohort } from "@/lib/api-security";
import { updateSession } from "@/lib/auth";
import { COHORT_COOKIE, cohortCookieOptions, requestedCohort, selectionAccepted } from "@/lib/cohort-context";
import { personalScreens, screenAllowedInAll } from "@/lib/consolidated-screens";

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

  // ADR 0011: the cohort selection (header or cookie) is validated here, once, for every page and route
  // (lib/cohort-context.ts). A malformed selection is refused, never ignored.
  const requested = requestedCohort(request);
  if (requested.kind === "invalid") {
    if (isApi) {
      const invalid = apiError("INVALID_COHORT_CONTEXT", "Turma inválida.", createRequestId(request.headers), 400);
      if (requested.source === "cookie") invalid.cookies.delete(COHORT_COOKIE);
      return invalid;
    }
    const retry = NextResponse.redirect(request.nextUrl);
    retry.cookies.delete(COHORT_COOKIE);
    return retry;
  }
  const selection = requested.kind === "selected" ? requested.value : null;
  const { response, session, client } = await updateSession(request, selection);

  // A selection the database did not accept (unknown cohort, no active membership, "all" without ADMIN_MASTER).
  if (session && selection && !selectionAccepted(selection, session.user)) {
    if (isApi) {
      const forbidden = apiError("COHORT_FORBIDDEN", "Você não tem acesso a esta turma.", createRequestId(request.headers), 403);
      if (requested.kind === "selected" && requested.source === "cookie") forbidden.cookies.delete(COHORT_COOKIE);
      return forbidden;
    }
    const retry = NextResponse.redirect(request.nextUrl);
    retry.cookies.delete(COHORT_COOKIE);
    return retry;
  }

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
      // AUD-001: best effort; the denial stands whether or not it is recorded.
      await client?.rpc("record_authorization_denied", { p_app: "PORTAL", p_route: path, p_method: request.method, p_request_id: requestId })
        .then(() => undefined, () => undefined);
      return apiError("FORBIDDEN", "Permissão insuficiente", requestId, 403);
    }
    if (!safeMethods.has(request.method) && !isTrustedMutation(request)) {
      return apiError("INVALID_ORIGIN", "Origem não autorizada", requestId, 403);
    }
    // Writes into cohort data need one concrete cohort: never in "all", never without a determinable cohort.
    if (session && rule?.access !== "public" && writeNeedsCohort(rule, request.method) && session.user.cohortMode !== "COHORT") {
      return apiError("COHORT_REQUIRED", "Selecione uma turma antes de alterar dados.", requestId, 409);
    }
    // In "Todas as turmas" a write is always global or refused, public routes included; a read must be declared
    // consolidated (PR 4), so no route returns rows of several cohorts without saying which cohort each one is.
    if (session?.user.cohortMode === "ALL") {
      if (!safeMethods.has(request.method) && rule?.cohort !== "global") {
        return apiError("COHORT_REQUIRED", "Selecione uma turma antes de alterar dados.", requestId, 409);
      }
      if (safeMethods.has(request.method) && !readAllowedInAll(rule, request.method)) {
        return apiError("COHORT_REQUIRED", "Selecione uma turma para consultar estes dados.", requestId, 409);
      }
    }

    response.headers.set("Cache-Control", "no-store");
    response.headers.set("x-request-id", requestId);
    return response;
  }

  // GROW-001: tracked share links are public for everyone, signed in or not.
  if (/^\/d\/[a-z0-9]{8}$/.test(path)) return response;
  const isPublicRoute = publicRoutes.has(path);
  if (!session && !isPublicRoute) return NextResponse.redirect(new URL("/login", request.url));
  if (session && !session.user.onboardingCompleted && path !== "/cadastro/perfil") {
    return NextResponse.redirect(new URL("/cadastro/perfil", request.url));
  }
  if (session?.user.onboardingCompleted && isPublicRoute && path !== "/recuperar-senha") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  // ADR 0011 (PR 5): a share link or page may name a cohort by its public slug (?turma=). It selects that cohort only
  // for a person who belongs to it (resolved against the session, never trusted from the URL); otherwise it is dropped.
  const slug = request.nextUrl.searchParams.get("turma");
  if (session?.user.onboardingCompleted && slug !== null) {
    const target = session.user.cohorts.find((cohort) => cohort.slug === slug && cohort.status !== "ARCHIVED");
    const clean = new URL(request.nextUrl);
    clean.searchParams.delete("turma");
    const redirect = NextResponse.redirect(clean);
    if (target && !(session.user.cohortMode === "COHORT" && session.user.cohort?.id === target.id)) {
      redirect.cookies.set(COHORT_COOKIE, target.id, cohortCookieOptions);
    }
    return redirect;
  }
  // ADR 0011 (PR 4): in "Todas as turmas" only consolidated screens open; the others ask for a cohort first.
  if (session?.user.onboardingCompleted && session.user.cohortMode === "ALL" && !isPublicRoute && !screenAllowedInAll(path)) {
    const choose = new URL("/selecionar-turma", request.url);
    choose.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(choose);
  }
  // ADR 0011 (PR 5): without a determinable cohort (several cohorts, or ADMIN_MASTER without a selection) nothing comes
  // from a default cohort: the person chooses one explicitly. Personal screens read nothing of a cohort.
  if (session?.user.onboardingCompleted && session.user.cohortMode === "NONE" && !isPublicRoute && !personalScreens.has(path)) {
    const choose = new URL("/selecionar-turma", request.url);
    choose.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(choose);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
