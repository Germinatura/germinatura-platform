import type { AppRole } from "@germinatura/contracts";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { findAuthIdByLegacyUser, linkLegacyIdentity } from "@/lib/supabase/user-admin";

async function requireAdmin() {
  const session = await getSession();
  return session?.user.perfil === "ADMIN" ? session : null;
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const { nome, email, senha, perfil } = (await request.json()) as { nome?: string; email?: string; senha?: string; perfil?: AppRole };
  if (!nome || !email || !perfil || !["ADMIN", "VENDEDOR", "CONSUMER"].includes(perfil)) return NextResponse.json({ error: "Dados inválidos" }, { status: 422 });
  const authId = await findAuthIdByLegacyUser(id);
  if (!authId) return NextResponse.json({ error: "Usuário legado ainda não migrado para o Supabase Auth" }, { status: 409 });

  const admin = createSupabaseAdminClient();
  const { error: authError } = await admin.auth.admin.updateUserById(authId, {
    email,
    password: senha || undefined,
    user_metadata: { name: nome },
  });
  if (authError) return NextResponse.json({ error: authError.message }, { status: 400 });
  const user = await prisma.usuario.update({
    where: { id },
    data: { nome, email, perfil, senha: senha ? await hashPassword(randomUUID()) : undefined },
    select: { id: true, nome: true, email: true, perfil: true },
  });
  await linkLegacyIdentity(authId, id, perfil);
  return NextResponse.json(user);
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  if (session.user.legacyUserId === id) return NextResponse.json({ error: "Não é possível remover o próprio usuário" }, { status: 409 });
  const authId = await findAuthIdByLegacyUser(id);
  if (authId) await createSupabaseAdminClient().auth.admin.deleteUser(authId);
  await prisma.usuario.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
