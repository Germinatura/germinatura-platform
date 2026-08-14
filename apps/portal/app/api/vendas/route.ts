import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

interface SaleItemInput {
  produtoId: string;
  quantidade: number;
}

interface StockRow {
  id: string;
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session || session.user.perfil === "CONSUMER") {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const skip = Math.max(0, Number.parseInt(searchParams.get("skip") ?? "0", 10) || 0);
  const unlimited = searchParams.get("limit") === "none";
  try {
    const vendas = await prisma.venda.findMany({
      select: {
        id: true,
        total: true,
        criadoEm: true,
        usuario: { select: { nome: true, email: true } },
        itens: {
          select: {
            id: true,
            quantidade: true,
            precoUnitario: true,
            produto: { select: { nome: true, produtoPai: { select: { nome: true } } } },
          },
        },
        transacao: { select: { id: true } },
      },
      orderBy: { criadoEm: "desc" },
      take: unlimited ? undefined : 50,
      skip: unlimited ? 0 : skip,
    });
    return NextResponse.json({ transactions: vendas });
  } catch {
    return NextResponse.json({ error: "Erro ao buscar vendas" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session || session.user.perfil === "CONSUMER") {
      return NextResponse.json({ error: "Acesso negado: requer vendedor ou administrador" }, { status: 403 });
    }
    if (!session.user.legacyUserId) {
      return NextResponse.json({ error: "Usuário ainda não vinculado à base operacional" }, { status: 409 });
    }

    const body = (await request.json()) as { itens?: SaleItemInput[]; estoqueJaDescontado?: boolean };
    if (!Array.isArray(body.itens) || body.itens.length === 0 || body.itens.some((item) => !item.produtoId || !Number.isInteger(item.quantidade) || item.quantidade <= 0)) {
      return NextResponse.json({ error: "Itens inválidos" }, { status: 422 });
    }

    const products = await prisma.produto.findMany({
      where: { id: { in: body.itens.map((item) => item.produtoId) }, ativo: true },
      select: {
        id: true,
        isPromocional: true,
        produtoPaiId: true,
        precos: { orderBy: { criadoEm: "desc" }, take: 1 },
        promocao: { select: { tipo: true, quantidadeMinima: true, itensCombo: true } },
      },
    });
    const productMap = new Map(products.map((product) => [product.id, product]));
    if (productMap.size !== new Set(body.itens.map((item) => item.produtoId)).size) {
      return NextResponse.json({ error: "Produto inexistente ou inativo" }, { status: 422 });
    }

    const pricedItems = body.itens.map((item) => {
      const product = productMap.get(item.produtoId);
      if (!product) throw new Error(`Produto não encontrado: ${item.produtoId}`);
      return { ...item, precoUnitario: product.precos[0]?.valor ?? 0, product };
    });
    const total = pricedItems.reduce((sum, item) => sum + item.precoUnitario * item.quantidade, 0);

    const result = await prisma.$transaction(async (transaction) => {
      async function decrement(productId: string, quantity: number) {
        const rows = await transaction.$queryRaw<StockRow[]>`
          UPDATE "Produto"
          SET estoque = estoque - ${quantity}, "atualizadoEm" = CURRENT_TIMESTAMP
          WHERE id = ${productId} AND estoque >= ${quantity}
          RETURNING id
        `;
        if (rows.length === 0) throw new Error(`Estoque insuficiente para o produto ${productId}`);
      }

      if (!body.estoqueJaDescontado) {
        for (const item of pricedItems) {
          const { product } = item;
          if (product.isPromocional && product.promocao?.tipo === "COMBO_MIX") {
            for (const comboItem of product.promocao.itensCombo) {
              await decrement(comboItem.produtoId, item.quantidade * comboItem.quantidade);
            }
          } else {
            const targetId = product.isPromocional && product.produtoPaiId ? product.produtoPaiId : product.id;
            const multiplier = product.isPromocional ? (product.promocao?.quantidadeMinima ?? 1) : 1;
            await decrement(targetId, item.quantidade * multiplier);
          }
        }
      }

      const transacao = await transaction.transacaoFinanceira.create({
        data: {
          tipo: "ENTRADA",
          categoria: "Venda PDV",
          descricao: `Venda PDV - ${pricedItems.length} itens`,
          valor: total,
          data: new Date(),
          usuarioId: session.user.legacyUserId,
        },
      });
      const venda = await transaction.venda.create({
        data: {
          total,
          transacaoId: transacao.id,
          usuarioId: session.user.legacyUserId,
          itens: {
            create: pricedItems.map((item) => ({
              produtoId: item.produtoId,
              quantidade: item.quantidade,
              precoUnitario: item.precoUnitario,
            })),
          },
        },
        include: { itens: true },
      });
      return { venda, transacao };
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao registrar venda";
    return NextResponse.json({ error: message }, { status: message.includes("Estoque insuficiente") ? 409 : 500 });
  }
}
