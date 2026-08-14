import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    if (!session.user.legacyUserId) return NextResponse.json({ error: "Usuário ainda não vinculado à base operacional" }, { status: 409 });

    const { id } = await params;
    const { status } = (await request.json()) as { status?: "CANCELADA" | "CONCLUIDA" };
    if (status !== "CANCELADA" && status !== "CONCLUIDA") return NextResponse.json({ error: "Operação não permitida" }, { status: 422 });
    if (status === "CONCLUIDA" && session.user.perfil !== "ADMIN") return NextResponse.json({ error: "Apenas administradores podem concluir reservas" }, { status: 403 });

    const reservation = await prisma.reserva.findUnique({
      where: { id },
      include: { itens: { include: { produto: { include: { precos: { orderBy: { criadoEm: "desc" }, take: 1 } } } } } },
    });
    if (!reservation) return NextResponse.json({ error: "Reserva não encontrada" }, { status: 404 });
    if (reservation.usuarioId !== session.user.legacyUserId && session.user.perfil !== "ADMIN") return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    if (reservation.status === "CANCELADA" || reservation.status === "CONCLUIDA") return NextResponse.json({ error: "Esta reserva já foi finalizada" }, { status: 409 });

    if (status === "CANCELADA") {
      const cancelled = await prisma.$transaction(async (transaction) => {
        for (const item of reservation.itens) {
          await transaction.produto.update({ where: { id: item.produtoId }, data: { estoque: { increment: item.quantidade } } });
        }
        return transaction.reserva.update({ where: { id }, data: { status: "CANCELADA" } });
      });
      return NextResponse.json(cancelled);
    }

    const total = reservation.itens.reduce((sum, item) => sum + (item.produto.precos[0]?.valor ?? 0) * item.quantidade, 0);
    const completed = await prisma.$transaction(async (transaction) => {
      const financial = await transaction.transacaoFinanceira.create({
        data: {
          tipo: "ENTRADA",
          categoria: "Venda por Reserva",
          descricao: `Reserva #${id.slice(-6).toUpperCase()} - ${reservation.itens.length} item(ns)`,
          valor: total,
          data: new Date(),
          usuarioId: session.user.legacyUserId,
        },
      });
      await transaction.venda.create({
        data: {
          total,
          transacaoId: financial.id,
          usuarioId: session.user.legacyUserId,
          itens: {
            create: reservation.itens.map((item) => ({
              produtoId: item.produtoId,
              quantidade: item.quantidade,
              precoUnitario: item.produto.precos[0]?.valor ?? 0,
            })),
          },
        },
      });
      return transaction.reserva.update({ where: { id }, data: { status: "CONCLUIDA" } });
    });
    return NextResponse.json(completed);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro interno ao atualizar reserva" }, { status: 500 });
  }
}
