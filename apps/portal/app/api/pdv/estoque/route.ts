import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

interface StockItem {
  produtoId: string;
  quantidade: number;
}

interface StockRow {
  id: string;
  nome: string;
  estoque: number;
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session || session.user.perfil === "CONSUMER") {
      return NextResponse.json({ error: "Acesso negado: requer vendedor ou administrador" }, { status: 403 });
    }

    const { action, itens } = (await request.json()) as { action?: "reservar" | "liberar"; itens?: StockItem[] };
    if (!action || !Array.isArray(itens) || itens.length === 0) {
      return NextResponse.json({ error: "Dados inválidos para manipulação de estoque" }, { status: 422 });
    }
    if (itens.some((item) => !item.produtoId || !Number.isInteger(item.quantidade) || item.quantidade <= 0)) {
      return NextResponse.json({ error: "Itens de estoque inválidos" }, { status: 422 });
    }

    const products = await prisma.produto.findMany({
      where: { id: { in: itens.map((item) => item.produtoId) } },
      select: {
        id: true,
        nome: true,
        isPromocional: true,
        produtoPaiId: true,
        promocao: {
          select: { id: true, tipo: true, quantidadeMinima: true, itensCombo: true },
        },
      },
    });
    const productMap = new Map(products.map((product) => [product.id, product]));

    await prisma.$transaction(async (transaction) => {
      async function changeStock(productId: string, quantity: number) {
        if (action === "liberar") {
          await transaction.produto.update({ where: { id: productId }, data: { estoque: { increment: quantity } } });
          return;
        }
        const rows = await transaction.$queryRaw<StockRow[]>`
          UPDATE "Produto"
          SET estoque = estoque - ${quantity}, "atualizadoEm" = CURRENT_TIMESTAMP
          WHERE id = ${productId} AND estoque >= ${quantity}
          RETURNING id, nome, estoque
        `;
        if (rows.length > 0) return;
        const product = await transaction.produto.findUnique({ where: { id: productId }, select: { nome: true, estoque: true } });
        if (!product) throw new Error(`Produto não encontrado: ${productId}`);
        throw new Error(`Estoque insuficiente para ${product.nome}. Disponível: ${product.estoque}, solicitado: ${quantity}`);
      }

      for (const item of itens) {
        const product = productMap.get(item.produtoId);
        if (!product) throw new Error(`Produto não encontrado: ${item.produtoId}`);
        if (product.isPromocional && product.promocao?.tipo === "COMBO_MIX") {
          for (const comboItem of product.promocao.itensCombo) {
            await changeStock(comboItem.produtoId, item.quantidade * comboItem.quantidade);
          }
          continue;
        }
        const targetId = product.isPromocional && product.produtoPaiId ? product.produtoPaiId : product.id;
        const multiplier = product.isPromocional ? (product.promocao?.quantidadeMinima ?? 1) : 1;
        await changeStock(targetId, item.quantidade * multiplier);
      }
    });

    return NextResponse.json({ success: true, action });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro interno do servidor";
    const conflict = message.includes("Estoque insuficiente") || message.includes("Produto não encontrado");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
