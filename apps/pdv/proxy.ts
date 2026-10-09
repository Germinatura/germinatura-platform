import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { accountUsable, operatesPdvIn, parsePdvCohort, PDV_COHORT_COOKIE, PDV_COHORT_PAGE, pdvCohortCookieOptions, sessionIn } from "@/lib/pdv-cohort";

export default async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // Only these session-free PWA assets bypass Auth. Operational pages still validate it.
  // Spec 6.1: the Portal handoff page opens its own session, replacing any other one in this browser.
  if (["/offline", "/offline/brand.svg", "/offline.js", "/offline.css", "/sw.js", "/manifest.webmanifest", "/acesso"].includes(path)) {
    return NextResponse.next();
  }
  const isLogin = path === "/login";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return NextResponse.redirect(new URL("/login", request.url));

  let response = NextResponse.next({ request });
  const client = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // ADR 0011: the PDV operates inside one concrete cohort (lib/pdv-cohort.ts). A malformed cookie counts as none.
  const rawCohort = request.cookies.get(PDV_COHORT_COOKIE)?.value;
  const selected = parsePdvCohort(rawCohort);
  const done = (result: NextResponse) => {
    if (rawCohort !== undefined && selected === null && !result.cookies.has(PDV_COHORT_COOKIE)) result.cookies.delete(PDV_COHORT_COOKIE);
    return result;
  };

  // Identity from the access token, verified locally against the project's signing keys (no Auth round trip with
  // asymmetric keys); `get_my_session` stays the authority for the rest. As with `getUser`, an ended session counts
  // as signed out: the function returns no row for it.
  const started = Date.now();
  const subject = await client.auth.getClaims()
    .then(({ data, error }) => (error ? null : data?.claims.sub), () => null);
  const verified = Date.now();
  const { session, failed } = typeof subject === "string"
    ? await sessionIn(client, selected)
    : { session: null, failed: false };
  recordTiming(subject, session, started, verified);
  if (typeof subject !== "string" || (!failed && session === null)) {
    return done(isLogin ? response : NextResponse.redirect(new URL("/login", request.url)));
  }

  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
  const toPortal = () => done(NextResponse.redirect(new URL("/", portalUrl)));
  if (isLogin) {
    if (accountUsable(session) && (session.adminMaster || session.roles.includes("ADMIN"))) return toPortal();
    if (accountUsable(session) && session.roles.includes("VENDEDOR")) return done(NextResponse.redirect(new URL("/", request.url)));
    return done(response);
  }
  if (!accountUsable(session)) return toPortal();
  // The selection page lists only cohorts the database confirms (/api/auth/cohort).
  if (path === PDV_COHORT_PAGE) return done(response);

  if (selected) {
    if (operatesPdvIn(session, selected)) return response;
    // No longer valid for this person (membership, role, archived cohort or a changed cookie): choose again.
    const choose = NextResponse.redirect(new URL(PDV_COHORT_PAGE, request.url));
    choose.cookies.delete(PDV_COHORT_COOKIE);
    return choose;
  }
  // Nothing selected: the only open cohort, resolved by the database, is taken as is; with more than one (or when the
  // database resolves none), the person chooses. "all" is never a PDV context.
  const open = session.cohorts.filter((cohort) => cohort.status !== "ARCHIVED");
  if (open.length === 1 && operatesPdvIn(session, open[0]!.id)) {
    response.cookies.set(PDV_COHORT_COOKIE, open[0]!.id, pdvCohortCookieOptions);
    return done(response);
  }
  if (open.length === 0 || (open.length === 1 && session.cohortMode === "COHORT")) return toPortal();
  return done(NextResponse.redirect(new URL(PDV_COHORT_PAGE, request.url)));
}

// Staging measurement only (AUTH_TIMING_LOG=1): durations and outcome, never tokens, cookies or who the person is.
function recordTiming(subject: unknown, session: unknown, started: number, verified: number) {
  if (process.env.AUTH_TIMING_LOG !== "1") return;
  const finished = Date.now();
  const outcome = typeof subject !== "string" ? "unauthenticated" : session ? "resolved" : "session_rejected";
  console.info(JSON.stringify({ level: "info", event: "auth.session_resolution", source: "pdv-proxy", outcome,
    verifyMs: verified - started, sessionMs: finished - verified, totalMs: finished - started }));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
