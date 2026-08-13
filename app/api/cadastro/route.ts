import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

export async function POST(request: NextRequest) {
    try {
        const { nome, email, senha } = await request.json();

        // Validações básicas
        if (!nome || !email || !senha) {
            return NextResponse.json({ error: "Todos os campos são obrigatórios" }, { status: 400 });
        }

        if (senha.length < 6) {
            return NextResponse.json({ error: "A senha deve ter no mínimo 6 caracteres" }, { status: 400 });
        }

        // Verifica se o email já existe
        const usuarioExistente = await prisma.usuario.findUnique({
            where: { email }
        });

        if (usuarioExistente) {
            return NextResponse.json({ error: "Este email já está cadastrado" }, { status: 400 });
        }

        // Hash da senha e criação do CONSUMER
        const hashedPassword = await hashPassword(senha);

        const novoConsumer = await prisma.usuario.create({
            data: {
                nome,
                email,
                senha: hashedPassword,
                perfil: "CONSUMER" // Perfil fixo
            },
            select: {
                id: true,
                nome: true,
                email: true,
                perfil: true,
                criadoEm: true
            }
        });

        return NextResponse.json({
            message: "Cadastro realizado com sucesso",
            user: novoConsumer
        }, { status: 201 });

    } catch (error) {
        console.error("Erro no cadastro de consumer:", error);
        return NextResponse.json({ error: "Erro interno no servidor ao realizar cadastro" }, { status: 500 });
    }
}
