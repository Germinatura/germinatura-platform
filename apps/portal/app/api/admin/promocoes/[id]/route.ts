import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const promocao = await prisma.promocao.findUnique({
            where: { id },
            include: { produtos: true }
        });
        if (!promocao) {
            return NextResponse.json({ error: "Promoção não encontrada" }, { status: 404 });
        }
        return NextResponse.json(promocao);
    } catch (error) {
        console.error("Erro ao buscar promoção:", error);
        return NextResponse.json({ error: "Erro ao buscar promoção" }, { status: 500 });
    }
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado. Apenas administradores." }, { status: 403 });
        }

        const { id } = await params;
        const body = await request.json();
        const { ativo, dataInicio, dataFim } = body;

        const promocao = await prisma.promocao.update({
            where: { id },
            data: {
                ativo,
                dataInicio: dataInicio ? new Date(dataInicio) : undefined,
                dataFim: dataFim ? new Date(dataFim) : undefined,
            }
        });

        // Atualizar produtos associados para refletirem o status da promoção
        if (ativo !== undefined) {
            await prisma.produto.updateMany({
                where: { promocaoId: id },
                data: { ativo }
            });
        }

        return NextResponse.json(promocao);
    } catch (error) {
        console.error("Erro ao atualizar promoção:", error);
        return NextResponse.json({ error: "Erro ao atualizar promoção" }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado. Apenas administradores." }, { status: 403 });
        }

        const { id } = await params;

        // Primeiro deletar produtos temporários associados
        await prisma.produto.deleteMany({
            where: { promocaoId: id }
        });

        // Deletar a promoção
        await prisma.promocao.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Erro ao excluir promoção:", error);
        return NextResponse.json({ error: "Erro ao excluir promoção" }, { status: 500 });
    }
}
