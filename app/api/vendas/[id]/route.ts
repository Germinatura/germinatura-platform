import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        if (!session || (session.user.perfil !== "ADMIN" && session.user.perfil !== "VENDEDOR")) {
            return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
        }

        const { id } = await params;
        const venda = await prisma.venda.findUnique({
            where: { id },
            include: {
                itens: {
                    include: {
                        produto: true
                    }
                },
                transacao: true
            }
        });

        if (!venda) {
            return NextResponse.json(
                { error: "Venda não encontrada" },
                { status: 404 }
            );
        }

        return NextResponse.json(venda);
    } catch (error) {
        console.error("Erro ao buscar detalhes da venda:", error);
        return NextResponse.json(
            { error: "Erro ao buscar detalhes da venda" },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        if (!session || (session.user.perfil !== "ADMIN" && session.user.perfil !== "VENDEDOR")) {
            return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
        }

        const { id } = await params;

        const vendaFull = await prisma.venda.findUnique({
            where: { id },
            include: { itens: true }
        });

        if (!vendaFull) {
            return NextResponse.json({ error: "Venda não encontrada" }, { status: 404 });
        }

        // Perform deletion and stock restoration in a transaction to ensure atomicity
        await prisma.$transaction(async (tx: any) => {
            // 1. Restore stock for all items carefully accounting for promotions/combos
            for (const item of vendaFull.itens) {
                const query = `
                    SELECT p.id, p.nome, p."isPromocional", p."produtoPaiId", pr."quantidadeMinima"
                    FROM "Produto" p
                    LEFT JOIN "Promocao" pr ON p."promocaoId" = pr.id
                    WHERE p.id = '${item.produtoId}'
                `;

                const produtoInfoArr: any[] = await tx.$queryRawUnsafe(query);
                const produtoInfo = produtoInfoArr[0] || {};

                let targetId = item.produtoId;
                let quantARestaurar = item.quantidade;

                const isPromoField = produtoInfo.isPromocional ?? produtoInfo.ispromocional ?? false;
                const paiIdField = produtoInfo.produtoPaiId ?? produtoInfo.produtopaiid ?? null;
                const qtdMinField = Number(produtoInfo.quantidadeMinima ?? produtoInfo.quantidademinima ?? 1);

                const isPromo = isPromoField === true || isPromoField === 'true' || isPromoField === 1;

                if (isPromo && paiIdField) {
                    targetId = paiIdField;
                    quantARestaurar = item.quantidade * qtdMinField;
                }

                await tx.$queryRawUnsafe(`
                    UPDATE "Produto"
                    SET estoque = estoque + $1, "atualizadoEm" = CURRENT_TIMESTAMP
                    WHERE id = $2
                `, quantARestaurar, targetId);
            }

            // 2. Delete all items related to the sale
            await tx.itemVenda.deleteMany({
                where: { vendaId: id }
            });

            // 3. Delete the sale
            await tx.venda.delete({
                where: { id }
            });

            // 4. Delete the transaction if it exists
            if (vendaFull.transacaoId) {
                await tx.transacaoFinanceira.delete({
                    where: { id: vendaFull.transacaoId }
                });
            }
        });

        return NextResponse.json({ message: "Venda excluída e estoque restaurado com sucesso" });
    } catch (error) {
        console.error("Erro ao excluir venda:", error);
        return NextResponse.json(
            { error: "Erro ao excluir venda" },
            { status: 500 }
        );
    }
}
