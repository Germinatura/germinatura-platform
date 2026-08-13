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

        // Usando executeRaw como alternativa se o client estiver travado
        try {
            await prisma.produto.update({
                where: { id },
                data: { estoque: parseInt(String(estoque)) },
            });
            console.log("Estoque API: Update success via Prisma Client");
        } catch (clientError: any) {
            console.warn("Estoque API: Prisma Client update failed, trying raw SQL:", clientError.message);
            await prisma.$executeRawUnsafe(
                `UPDATE "Produto" SET estoque = $1 WHERE id = $2`,
                parseInt(String(estoque)),
                id
            );
            console.log("Estoque API: Update success via Raw SQL");
        }

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
