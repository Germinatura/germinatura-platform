import type { AppRole } from "@germinatura/contracts";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { linkLegacyIdentity } from "@/lib/supabase/user-admin";

const roles: readonly AppRole[] = ["ADMIN", "VENDEDOR", "CONSUMER"];

async function isAdmin() {
  return (await getSession())?.user.perfil === "ADMIN";
}

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const users = await prisma.usuario.findMany({
    select: { id: true, nome: true, email: true, perfil: true, criadoEm: true },
    orderBy: { criadoEm: "desc" },
  });
  return NextResponse.json(users);
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { nome, email, senha, perfil } = (await request.json()) as { nome?: string; email?: string; senha?: string; perfil?: AppRole };
  if (!nome || !email || !senha || senha.length < 8 || !perfil || !roles.includes(perfil)) {
    return NextResponse.json({ error: "Nome, email, senha segura e perfil válido são obrigatórios" }, { status: 422 });
  }
  if (await prisma.usuario.findUnique({ where: { email } })) return NextResponse.json({ error: "Email já cadastrado" }, { status: 409 });

  const admin = createSupabaseAdminClient();
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { name: nome },
  });
  if (authError || !authData.user) return NextResponse.json({ error: authError?.message ?? "Falha ao criar identidade" }, { status: 400 });

  try {
    const user = await prisma.usuario.create({
      data: { nome, email, senha: await hashPassword(randomUUID()), perfil },
      select: { id: true, nome: true, email: true, perfil: true, criadoEm: true },
    });
    await linkLegacyIdentity(authData.user.id, user.id, perfil);
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro ao criar usuário" }, { status: 500 });
  }
}
