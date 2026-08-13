import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { getSession, login } from "@/lib/auth";

export async function POST(request: NextRequest) {
    try {
        const session = await getSession();
        if (!session) {
            return NextResponse.json({ error: "Sessão inválida ou expirada" }, { status: 401 });
        }

        const { novaSenha } = await request.json();

        if (!novaSenha || novaSenha.length < 6) {
            return NextResponse.json({ error: "A nova senha deve ter no mínimo 6 caracteres" }, { status: 400 });
        }

        if (novaSenha === "a12") {
            return NextResponse.json({ error: "A nova senha não pode ser igual à senha padrão" }, { status: 400 });
        }

        const hashedPassword = await hashPassword(novaSenha);

        const updatedUser = await prisma.usuario.update({
            where: { id: session.user.id },
            data: { senha: hashedPassword }
        });

        // Regenere a sessão limpando a flag needsPasswordReset
        await login({
            id: updatedUser.id,
            email: updatedUser.email,
            perfil: updatedUser.perfil,
            nome: updatedUser.nome,
            needsPasswordReset: false // Força a remoção da obrigatoriedade
        });

        return NextResponse.json({
            message: "Senha alterada com sucesso",
            perfil: updatedUser.perfil
        });

    } catch (error) {
        console.error("Erro ao alterar senha obrigatória:", error);
        return NextResponse.json({ error: "Erro interno no servidor ao alterar senha" }, { status: 500 });
    }
}
