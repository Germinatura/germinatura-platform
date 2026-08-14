import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const { nome, email, senha } = (await request.json()) as { nome?: string; email?: string; senha?: string };
  if (!nome || !email || !senha || senha.length < 8) {
    return NextResponse.json(createApiError("VALIDATION_ERROR", "Nome, email e senha de ao menos 8 caracteres são obrigatórios", requestId), { status: 422 });
  }
  if (await prisma.usuario.findUnique({ where: { email } })) {
    return NextResponse.json(createApiError("EMAIL_ALREADY_EXISTS", "Este email já está cadastrado", requestId), { status: 409 });
  }

  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.signUp({ email, password: senha, options: { data: { name: nome } } });
  if (error || !data.user) {
    return NextResponse.json(createApiError("SIGNUP_FAILED", error?.message ?? "Não foi possível criar a identidade", requestId), { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  try {
    const legacyUser = await prisma.usuario.create({
      data: { nome, email, senha: await hashPassword(randomUUID()), perfil: "CONSUMER" },
      select: { id: true, nome: true, email: true, perfil: true, criadoEm: true },
    });
    const { error: profileError } = await admin.from("profiles").update({ legacy_user_id: legacyUser.id }).eq("id", data.user.id);
    if (profileError) throw profileError;
    return NextResponse.json({ message: "Cadastro realizado com sucesso", user: legacyUser }, { status: 201 });
  } catch (error) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json(createApiError("SIGNUP_ROLLBACK", "O cadastro não pôde ser concluído", requestId), { status: 500 });
  }
}
