import { hasPermission } from "@germinatura/auth";
import type { Permission, SessionUser } from "@germinatura/contracts";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createSessionContext, forwardSessionContext, SESSION_CONTEXT_HEADER } from "@/lib/session-context";
import { resolveSession, resolveSupabaseSession, type SupabaseSession } from "@/lib/session-resolution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type { SupabaseSession };

export class AuthorizationError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export async function getSession(): Promise<SupabaseSession | null> {
  try {
    const requestHeaders = await headers();
    const authorization = requestHeaders.get("authorization");
    // Set by the proxy for this same request (and stripped from what the client sent); see lib/session-context.ts.
    const sessionContext = requestHeaders.get(SESSION_CONTEXT_HEADER);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (authorization?.startsWith("Bearer ") && url && publishableKey) {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(url, publishableKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: authorization } },
      });
      return await resolveSupabaseSession(client, accessToken, "route", sessionContext);
    }
    return await resolveSupabaseSession(await createSupabaseServerClient(), undefined, "route", sessionContext);
  } catch {
    return null;
  }
}

export async function logout() {
  const client = await createSupabaseServerClient();
  await client.auth.signOut();
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new AuthorizationError(401, "Autenticação obrigatória");
  if (!session.user.onboardingCompleted || !session.user.username) {
    throw new AuthorizationError(403, "Cadastro incompleto");
  }
  return {
    id: session.user.id,
    authId: session.user.authId,
    email: session.user.email,
    name: session.user.nome,
    username: session.user.username,
    avatarPath: session.user.avatarPath,
    role: session.user.perfil,
    roles: session.user.roles,
    active: true,
  };
}

export async function loginLocalFixture(credentials: { email: string; password: string }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (process.env.NODE_ENV === "production" || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) {
    throw new AuthorizationError(403, "Login local indisponível");
  }
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.signInWithPassword(credentials);
  if (error) throw new AuthorizationError(401, "Credenciais locais inválidas");
  const session = await resolveSupabaseSession(client, data.session?.access_token, "login");
  if (!session) throw new AuthorizationError(401, "Perfil local indisponível");
  return session;
}

export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireSession();
  if (!hasPermission(user, permission)) throw new AuthorizationError(403, "Permissão insuficiente");
  return user;
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return { response: withSessionContext(request, response, null), session: null, client: null };

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const accessToken = authorization.slice("Bearer ".length);
    const client = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const resolved = await resolveSession(client, accessToken, "proxy");
    return { response: withSessionContext(request, response, await contextFor(resolved)), session: resolved.session, client };
  }

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
  const resolved = await resolveSession(client, undefined, "proxy");
  return { response: withSessionContext(request, response, await contextFor(resolved)), session: resolved.session, client };
}

async function contextFor({ session, accessToken }: { session: SupabaseSession | null; accessToken: string | null }) {
  return session && accessToken ? createSessionContext(session, accessToken) : null;
}

// The route sees the request headers with the client's context header removed and, when a session was resolved,
// the proxy's own signed context. Cookies refreshed by Supabase stay on the response.
function withSessionContext(request: NextRequest, response: NextResponse, context: string | null) {
  const next = NextResponse.next({ request: { headers: forwardSessionContext(request.headers, context) } });
  for (const cookie of response.cookies.getAll()) next.cookies.set(cookie);
  return next;
}
