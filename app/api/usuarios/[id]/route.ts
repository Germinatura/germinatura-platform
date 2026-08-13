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

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    if (!(await isAdmin(request))) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const { nome, email, senha, perfil } = await request.json();

        const data: any = { nome, email, perfil };
        if (senha) {
            data.senha = await hashPassword(senha);
        }

        const usuario = await prisma.usuario.update({
            where: { id },
            data,
            select: {
                id: true,
                nome: true,
                email: true,
                perfil: true
            }
        });

        return NextResponse.json(usuario);
    } catch (error) {
        console.error("Erro ao atualizar usuário:", error);
        return NextResponse.json({ error: "Erro ao atualizar usuário" }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    if (!(await isAdmin(request))) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { id } = await params;

    try {
        // Evitar que um admin se delete (opcional, mas recomendado)
        // const sessionCookie = request.cookies.get("session")?.value;
        // const session = await decrypt(sessionCookie!);
        // if (session.user.id === id) return NextResponse.json({ error: "Não pode se auto-deletar" }, { status: 400 });

        await prisma.usuario.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Erro ao deletar usuário:", error);
        return NextResponse.json({ error: "Erro ao deletar usuário" }, { status: 500 });
    }
}
