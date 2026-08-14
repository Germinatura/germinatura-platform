import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export default async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login") return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.redirect(new URL("/login", request.url));

  let response = NextResponse.next({ request });
  const client = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await client.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", request.url));

  const { data: sessionData } = await client.rpc("get_my_session");
  const roles = sessionData && typeof sessionData === "object" && "roles" in sessionData
    ? (sessionData.roles as unknown[])
    : [];
  if (!roles.includes("ADMIN") && !roles.includes("VENDEDOR")) {
    const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
    return NextResponse.redirect(new URL("/reservas", portalUrl));
  }
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
