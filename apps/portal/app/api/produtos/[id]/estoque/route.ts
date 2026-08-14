import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        console.log("Estoque API: Session profile:", session?.user?.perfil);

        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
        }

        const { id } = await params;
        const body = await req.json();
        const { estoque } = body;

        console.log(`Estoque API: Request to update ID ${id} to ${estoque}`);

        if (typeof estoque !== "number") {
            return NextResponse.json({ error: "Estoque inválido" }, { status: 400 });
        }

        await prisma.produto.update({
            where: { id },
            data: { estoque: parseInt(String(estoque)) },
        });

        const produto = await prisma.produto.findUnique({
            where: { id }
        });

        return NextResponse.json(produto);
    } catch (error: any) {
        console.error("Erro ao atualizar estoque:", error);
        return NextResponse.json({
            error: "Erro interno ao atualizar estoque",
            details: error.message
        }, { status: 500 });
    }
}
