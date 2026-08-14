import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { findAuthIdByLegacyUser } from "@/lib/supabase/user-admin";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.user.perfil !== "ADMIN") return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { email, novaSenha } = (await request.json()) as { email?: string; novaSenha?: string };
  if (!email || !novaSenha || novaSenha.length < 8) return NextResponse.json({ error: "Email e senha de ao menos 8 caracteres são obrigatórios" }, { status: 422 });
  const legacyUser = await prisma.usuario.findUnique({ where: { email: email.toLowerCase().trim() }, select: { id: true, nome: true, email: true } });
  if (!legacyUser) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });
  const authId = await findAuthIdByLegacyUser(legacyUser.id);
  if (!authId) return NextResponse.json({ error: "Usuário ainda não migrado para o Supabase Auth" }, { status: 409 });
  const { error } = await createSupabaseAdminClient().auth.admin.updateUserById(authId, { password: novaSenha });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true, usuario: legacyUser });
}
