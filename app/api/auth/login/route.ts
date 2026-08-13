import prisma from "@/lib/prisma";
import { login } from "@/lib/auth";
import { NextResponse } from "next/server";
import { comparePassword } from "@/lib/password";

export async function POST(request: Request) {
    try {
        const { email, password } = await request.json();

        const user = await prisma.usuario.findUnique({
            where: { email },
        });

        if (!user || !(await comparePassword(password, user.senha))) {
            return NextResponse.json(
                { message: "Credenciais inválidas" },
                { status: 401 }
            );
        }

        await login({
            id: user.id,
            email: user.email,
            perfil: user.perfil,
            nome: user.nome,
            needsPasswordReset: password === "a12",
        });

        return NextResponse.json({
            message: "Login realizado com sucesso",
            user: {
                id: user.id,
                email: user.email,
                nome: user.nome,
                perfil: user.perfil,
            },
        });
    } catch (error) {
        console.error("Erro no login:", error);
        return NextResponse.json(
            { message: "Erro interno do servidor" },
            { status: 500 }
        );
    }
}
