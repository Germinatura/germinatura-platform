import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { decrypt } from "@/lib/auth";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const cookie = req.cookies.get("session")?.value;
        if (!cookie) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
        const session = await decrypt(cookie);
        if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

        const { id } = await params;
        const body = await req.json();
        const { status } = body;

        // Operações permitidas
        if (status !== "CANCELADA" && status !== "CONCLUIDA") {
            return NextResponse.json({ error: "Operação não permitida" }, { status: 400 });
        }

        // Apenas ADMINs podem concluir reservas
        if (status === "CONCLUIDA" && session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Apenas administradores podem concluir reservas" }, { status: 403 });
        }

        // Busca a reserva com todos os itens e preços de produto
        const reservaCompleta = await prisma.reserva.findUnique({
            where: { id },
            include: {
                itens: {
                    include: {
                        produto: {
                            include: {
                                precos: {
                                    orderBy: { criadoEm: "desc" },
                                    take: 1
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!reservaCompleta) {
            return NextResponse.json({ error: "Reserva não encontrada" }, { status: 404 });
        }

        // Verifica se a reserva pertence ao usuário logado (a menos que seja ADMIN)
        if (reservaCompleta.usuarioId !== session.user.id && session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
        }

        // Apenas reservas não finalizadas podem ser alteradas
        if (reservaCompleta.status === "CANCELADA" || reservaCompleta.status === "CONCLUIDA") {
            return NextResponse.json({ error: "Esta reserva já foi finalizada e não pode ser alterada" }, { status: 400 });
        }

        // === CANCELAMENTO: devolver estoque de forma sequencial (fora de transaction longa) ===
        if (status === "CANCELADA") {
            // Devolver estoque de cada item
            for (const item of reservaCompleta.itens) {
                try {
                    await prisma.produto.update({
                        where: { id: item.produtoId },
                        data: { estoque: { increment: item.quantidade } }
                    });
                } catch {
                    await prisma.$executeRawUnsafe(
                        `UPDATE "Produto" SET estoque = estoque + $1 WHERE id = $2`,
                        item.quantidade,
                        item.produtoId
                    );
                }
            }
            const reservaCancelada = await prisma.reserva.update({
                where: { id },
                data: { status: "CANCELADA" },
            });
            return NextResponse.json(reservaCancelada);
        }

        // === CONCLUSÃO: registrar venda + transação financeira ===
        if (status === "CONCLUIDA") {
            const totalVenda = reservaCompleta.itens.reduce((acc: number, item: any) => {
                const preco = item.produto.precos?.[0]?.valor || 0;
                return acc + preco * item.quantidade;
            }, 0);

            // 1. Cria a transação financeira
            const transacao = await prisma.transacaoFinanceira.create({
                data: {
                    tipo: "ENTRADA",
                    categoria: "Venda por Reserva",
                    descricao: `Reserva #${id.slice(-6).toUpperCase()} — ${reservaCompleta.itens.length} item(ns)`,
                    valor: totalVenda,
                    data: new Date(),
                    usuarioId: session.user.id,
                },
            });

            // 2. Cria a venda
            await prisma.venda.create({
                data: {
                    total: totalVenda,
                    transacaoId: transacao.id,
                    usuarioId: session.user.id, // o admin que aprovou a reserva
                    itens: {
                        create: reservaCompleta.itens.map((item: any) => ({
                            produtoId: item.produtoId,
                            quantidade: item.quantidade,
                            precoUnitario: item.produto.precos?.[0]?.valor || 0,
                        })),
                    },
                },
            });

            // 3. Atualiza o status da reserva
            const reservaConcluida = await prisma.reserva.update({
                where: { id },
                data: { status: "CONCLUIDA" },
            });

            return NextResponse.json(reservaConcluida);
        }

        return NextResponse.json({ error: "Operação inválida" }, { status: 400 });

    } catch (error: any) {
        console.error("Erro ao atualizar reserva:", error);
        return NextResponse.json({ error: error.message || "Erro interno ao atualizar reserva" }, { status: 500 });
    }
}
