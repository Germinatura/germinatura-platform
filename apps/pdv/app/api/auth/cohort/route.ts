import { NextResponse, type NextRequest } from "next/server";
import { accountUsable, eligiblePdvCohorts, operatesPdvIn, parsePdvCohort, PDV_COHORT_COOKIE, sessionIn, withPdvCohort } from "@/lib/pdv-cohort";
import { createPdvSupabaseServerClient } from "@/lib/supabase-server";

const headers = { "Cache-Control": "no-store" };

function response(code: string, message: string, status: number) {
  return NextResponse.json({ code, message }, { status, headers });
}

function trustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const configured = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
  try {
    return origin !== null && new URL(origin).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

/** ADR 0011: cohorts in which this person may operate the PDV, each confirmed by the database inside that cohort. */
export async function GET(request: NextRequest) {
  try {
    const client = await createPdvSupabaseServerClient();
    const { session } = await sessionIn(client, null);
    if (!session) return response("UNAUTHENTICATED", "Sessão ausente ou expirada", 401);
    const cohorts = accountUsable(session) ? await eligiblePdvCohorts(client, session) : [];
    const current = parsePdvCohort(request.cookies.get(PDV_COHORT_COOKIE)?.value);
    return NextResponse.json({ cohort: cohorts.some((cohort) => cohort.id === current) ? current : null, cohorts }, { headers });
  } catch {
    return response("AUTH_UNAVAILABLE", "Autenticação temporariamente indisponível", 503);
  }
}

/** Selects the PDV cohort. Only a concrete cohort the database accepts for this person; never "all". */
export async function POST(request: Request) {
  if (!trustedOrigin(request)) return response("INVALID_ORIGIN", "Origem não autorizada", 403);
  const body = await request.json().catch(() => null) as { cohort?: unknown } | null;
  const cohort = parsePdvCohort(typeof body?.cohort === "string" ? body.cohort : null);
  if (!cohort || Object.keys(body ?? {}).length !== 1) return response("INVALID_COHORT_CONTEXT", "Turma inválida.", 422);
  try {
    const client = await createPdvSupabaseServerClient();
    const { session } = await sessionIn(client, cohort);
    if (!session) return response("UNAUTHENTICATED", "Sessão ausente ou expirada", 401);
    if (!operatesPdvIn(session, cohort)) return response("COHORT_FORBIDDEN", "Você não tem acesso ao PDV nesta turma.", 403);
    return withPdvCohort(NextResponse.json({ cohort }, { headers }), cohort);
  } catch {
    return response("AUTH_UNAVAILABLE", "Autenticação temporariamente indisponível", 503);
  }
}
