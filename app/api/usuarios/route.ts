import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { decrypt } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

async function isAdmin(request: NextRequest) {
    const sessionCookie = request.cookies.get("session")?.value;
    if (!sessionCookie) return false;
    const session = await decrypt(sessionCookie);
    return session?.user?.perfil === "ADMIN";
}

export async function GET(request: NextRequest) {
    if (!(await isAdmin(request))) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    try {
        const usuarios = await prisma.usuario.findMany({
            select: {
                id: true,
                nome: true,
                email: true,
                perfil: true,
                criadoEm: true
            },
            orderBy: { criadoEm: "desc" }
        });
        return NextResponse.json(usuarios);
    } catch (error) {
        console.error("Erro ao buscar usuários:", error);
        return NextResponse.json({ error: "Erro ao buscar usuários" }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    if (!(await isAdmin(request))) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    try {
        const { nome, email, senha, perfil } = await request.json();

        if (!nome || !email || !senha || !perfil) {
            return NextResponse.json({ error: "Campos obrigatórios ausentes" }, { status: 400 });
        }

        const usuarioExistente = await prisma.usuario.findUnique({
            where: { email }
        });

        if (usuarioExistente) {
            return NextResponse.json({ error: "Email já cadastrado" }, { status: 400 });
        }

        const hashedPassword = await hashPassword(senha);

        const usuario = await prisma.usuario.create({
            data: { nome, email, senha: hashedPassword, perfil },
            select: {
                id: true,
                nome: true,
                email: true,
                perfil: true,
                criadoEm: true
            }
        });

        return NextResponse.json(usuario);
    } catch (error) {
        console.error("Erro ao criar usuário:", error);
        return NextResponse.json({ error: "Erro ao criar usuário" }, { status: 500 });
    }
}
