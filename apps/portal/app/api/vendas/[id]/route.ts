import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.user.perfil === "CONSUMER") return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  const { id } = await params;
  const venda = await prisma.venda.findUnique({ where: { id }, include: { itens: { include: { produto: true } }, transacao: true } });
  if (!venda) return NextResponse.json({ error: "Venda não encontrada" }, { status: 404 });
  if (session.user.perfil === "VENDEDOR" && venda.usuarioId !== session.user.legacyUserId) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  return NextResponse.json(venda);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session || session.user.perfil === "CONSUMER") return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    const { id } = await params;
    const venda = await prisma.venda.findUnique({ where: { id }, include: { itens: true } });
    if (!venda) return NextResponse.json({ error: "Venda não encontrada" }, { status: 404 });
    if (session.user.perfil === "VENDEDOR" && venda.usuarioId !== session.user.legacyUserId) {
      return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    }

    const products = await prisma.produto.findMany({
      where: { id: { in: venda.itens.map((item) => item.produtoId) } },
      select: {
        id: true,
        isPromocional: true,
        produtoPaiId: true,
        promocao: { select: { tipo: true, quantidadeMinima: true, itensCombo: true } },
      },
    });
    const productMap = new Map(products.map((product) => [product.id, product]));

    await prisma.$transaction(async (transaction) => {
      for (const item of venda.itens) {
        const product = productMap.get(item.produtoId);
        if (!product) continue;
        if (product.isPromocional && product.promocao?.tipo === "COMBO_MIX") {
          for (const comboItem of product.promocao.itensCombo) {
            await transaction.produto.update({ where: { id: comboItem.produtoId }, data: { estoque: { increment: item.quantidade * comboItem.quantidade } } });
          }
        } else {
          const targetId = product.isPromocional && product.produtoPaiId ? product.produtoPaiId : product.id;
          const multiplier = product.isPromocional ? (product.promocao?.quantidadeMinima ?? 1) : 1;
          await transaction.produto.update({ where: { id: targetId }, data: { estoque: { increment: item.quantidade * multiplier } } });
        }
      }
      await transaction.itemVenda.deleteMany({ where: { vendaId: id } });
      await transaction.venda.delete({ where: { id } });
      if (venda.transacaoId) await transaction.transacaoFinanceira.delete({ where: { id: venda.transacaoId } });
    });
    return NextResponse.json({ message: "Venda excluída e estoque restaurado" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro ao excluir venda" }, { status: 500 });
  }
}
