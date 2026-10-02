import { hasPermission } from "@germinatura/auth";
import type { Permission, SessionUser } from "@germinatura/contracts";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { resolveSupabaseSession, type SupabaseSession } from "@/lib/session-resolution";
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
    const authorization = (await headers()).get("authorization");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (authorization?.startsWith("Bearer ") && url && publishableKey) {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(url, publishableKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: authorization } },
      });
      return await resolveSupabaseSession(client, accessToken, "route");
    }
    return await resolveSupabaseSession(await createSupabaseServerClient(), undefined, "route");
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
  if (!url || !publishableKey) return { response, session: null, client: null };

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const accessToken = authorization.slice("Bearer ".length);
    const client = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    return { response, session: await resolveSupabaseSession(client, accessToken, "proxy"), client };
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
  return { response, session: await resolveSupabaseSession(client, undefined, "proxy"), client };
}
