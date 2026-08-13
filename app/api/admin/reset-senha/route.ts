import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

export async function POST(req: NextRequest) {
    const session = await getSession();
    if (!session || session.user.perfil !== "ADMIN") {
        return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    const { email, novaSenha } = await req.json();
    if (!email || !novaSenha) {
        return NextResponse.json({ error: "email e novaSenha são obrigatórios." }, { status: 400 });
    }

    const hashed = await hashPassword(novaSenha);
    const user = await prisma.usuario.update({
        where: { email: email.toLowerCase().trim() },
        data: { senha: hashed },
        select: { id: true, nome: true, email: true },
    });

    return NextResponse.json({ success: true, usuario: user });
}
