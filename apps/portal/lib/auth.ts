import { hasPermission, primaryRole } from "@germinatura/auth";
import type { AppRole, Permission, SessionUser } from "@germinatura/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const sessionRpcSchema = z.object({
  auth_id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  legacy_user_id: z.string().nullable(),
  roles: z.array(z.enum(["ADMIN", "VENDEDOR", "CONSUMER"])),
});

export interface LegacyCompatibleSession {
  user: {
    id: string;
    authId: string;
    email: string;
    perfil: AppRole;
    nome: string;
    roles: AppRole[];
    legacyUserId: string | null;
    needsPasswordReset: false;
  };
}

export class AuthorizationError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

async function resolveSession(client: SupabaseClient, accessToken?: string): Promise<LegacyCompatibleSession | null> {
  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  if (userError || !userData.user?.email) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const rpcClient = accessToken && url && anonKey
    ? createClient(url, anonKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      })
    : client;
  const { data, error } = await rpcClient.rpc("get_my_session");
  if (error || !data) return null;
  const parsed = sessionRpcSchema.safeParse(data);
  if (!parsed.success) return null;

  const roles = parsed.data.roles.length > 0 ? parsed.data.roles : ["CONSUMER" as const];
  const perfil = primaryRole(roles);
  return {
    user: {
      id: parsed.data.legacy_user_id ?? parsed.data.auth_id,
      authId: parsed.data.auth_id,
      email: parsed.data.email,
      perfil,
      nome: parsed.data.display_name ?? parsed.data.email,
      roles,
      legacyUserId: parsed.data.legacy_user_id,
      needsPasswordReset: false,
    },
  };
}

export async function getSession(): Promise<LegacyCompatibleSession | null> {
  try {
    const authorization = (await headers()).get("authorization");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (authorization?.startsWith("Bearer ") && url && anonKey) {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: authorization } },
      });
      return await resolveSession(client, accessToken);
    }
    return await resolveSession(await createSupabaseServerClient());
  } catch {
    return null;
  }
}

export async function login(credentials: { email: string; password: string }) {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.signInWithPassword(credentials);
  if (error) throw new AuthorizationError(401, "Credenciais inválidas");
  const session = await resolveSession(client, data.session?.access_token);
  if (!session) throw new AuthorizationError(401, "Perfil de acesso não configurado");
  return session;
}

export async function logout() {
  const client = await createSupabaseServerClient();
  await client.auth.signOut();
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new AuthorizationError(401, "Autenticação obrigatória");
  return {
    id: session.user.id,
    authId: session.user.authId,
    email: session.user.email,
    name: session.user.nome,
    role: session.user.perfil,
    roles: session.user.roles,
    legacyUserId: session.user.legacyUserId,
  };
}

export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireSession();
  if (!hasPermission(user, permission)) throw new AuthorizationError(403, "Permissão insuficiente");
  return user;
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { response, session: null };

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const accessToken = authorization.slice("Bearer ".length);
    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    return { response, session: await resolveSession(client, accessToken) };
  }

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
  return { response, session: await resolveSession(client) };
}
