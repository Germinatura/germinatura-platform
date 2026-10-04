import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

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
  // Identity from the access token, verified locally against the project's signing keys (no Auth round trip with
  // asymmetric keys); `get_my_session` stays the authority for the rest. As with `getUser`, an ended session counts
  // as signed out: the function returns no row for it.
  const started = Date.now();
  const subject = await client.auth.getClaims()
    .then(({ data, error }) => (error ? null : data?.claims.sub), () => null);
  const verified = Date.now();
  const { data: sessionData, error: sessionError } = typeof subject === "string"
    ? await client.rpc("get_my_session")
    : { data: null, error: null };
  recordTiming(subject, sessionData, started, verified);
  if (typeof subject !== "string" || (!sessionError && sessionData === null)) {
    return isLogin ? response : NextResponse.redirect(new URL("/login", request.url));
  }

  const roles = sessionData && typeof sessionData === "object" && "roles" in sessionData
    ? (sessionData.roles as unknown[])
    : [];
  const active = sessionData && typeof sessionData === "object" && "active" in sessionData
    ? sessionData.active === true
    : false;
  const onboardingCompleted = sessionData && typeof sessionData === "object" && "onboarding_completed" in sessionData
    ? sessionData.onboarding_completed === true
    : false;
  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
  if (isLogin) {
    if (roles.includes("ADMIN")) return NextResponse.redirect(new URL("/", portalUrl));
    if (roles.includes("VENDEDOR")) return NextResponse.redirect(new URL("/", request.url));
  }
  if (!active || !onboardingCompleted || (!roles.includes("ADMIN") && !roles.includes("VENDEDOR"))) {
    return NextResponse.redirect(new URL("/", portalUrl));
  }
  return response;
}

// Staging measurement only (AUTH_TIMING_LOG=1): durations and outcome, never tokens, cookies or who the person is.
function recordTiming(subject: unknown, sessionData: unknown, started: number, verified: number) {
  if (process.env.AUTH_TIMING_LOG !== "1") return;
  const finished = Date.now();
  const outcome = typeof subject !== "string" ? "unauthenticated" : sessionData ? "resolved" : "session_rejected";
  console.info(JSON.stringify({ level: "info", event: "auth.session_resolution", source: "pdv-proxy", outcome,
    verifyMs: verified - started, sessionMs: finished - verified, totalMs: finished - started }));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
