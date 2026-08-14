import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

interface ReservationItemInput {
  produtoId: string;
  quantidade: number;
}

interface StockRow {
  id: string;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    if (!session.user.legacyUserId) return NextResponse.json({ error: "Usuário ainda não vinculado à base operacional" }, { status: 409 });
    const legacyUserId = session.user.legacyUserId;

    const { itens } = (await request.json()) as { itens?: ReservationItemInput[] };
    if (!Array.isArray(itens) || itens.length === 0 || itens.some((item) => !item.produtoId || !Number.isInteger(item.quantidade) || item.quantidade <= 0)) {
      return NextResponse.json({ error: "Itens da reserva são inválidos" }, { status: 422 });
    }
    const config = await prisma.configuracao.findUnique({ where: { chave: "reservas_ativas" } });
    if (config?.valor === "false") return NextResponse.json({ error: "As reservas estão temporariamente desativadas" }, { status: 403 });

    const reservation = await prisma.$transaction(async (transaction) => {
      for (const item of itens) {
        const product = await transaction.produto.findUnique({
          where: { id: item.produtoId },
          select: { nome: true, isPromocional: true, promocao: true },
        });
        if (!product) throw new Error(`Produto não encontrado: ${item.produtoId}`);
        const now = new Date();
        const activePromotion = product.promocao?.ativo && now >= product.promocao.dataInicio && now <= product.promocao.dataFim;
        if (product.isPromocional || activePromotion) throw new Error(`Produtos em promoção não podem ser reservados: ${product.nome}`);

        const rows = await transaction.$queryRaw<StockRow[]>`
          UPDATE "Produto"
          SET estoque = estoque - ${item.quantidade}, "atualizadoEm" = CURRENT_TIMESTAMP
          WHERE id = ${item.produtoId} AND estoque >= ${item.quantidade}
          RETURNING id
        `;
        if (rows.length === 0) throw new Error(`Estoque insuficiente para ${product.nome}`);
      }
      return transaction.reserva.create({
        data: {
          usuarioId: legacyUserId,
          status: "PENDENTE",
          itens: { create: itens.map((item) => ({ produtoId: item.produtoId, quantidade: item.quantidade })) },
        },
        include: { itens: true },
      });
    });
    return NextResponse.json(reservation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro interno ao criar reserva";
    const conflict = message.includes("Estoque insuficiente") || message.includes("Produto não encontrado") || message.includes("promoção");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  if (!session.user.legacyUserId) return NextResponse.json([], { status: 200 });

  const { searchParams } = new URL(request.url);
  const seeAll = searchParams.get("all") === "true" && session.user.perfil === "ADMIN";
  const skip = Math.max(0, Number.parseInt(searchParams.get("skip") ?? "0", 10) || 0);
  const take = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("take") ?? "50", 10) || 50));
  try {
    const reservations = await prisma.reserva.findMany({
      where: seeAll ? undefined : { usuarioId: session.user.legacyUserId },
      select: {
        id: true,
        status: true,
        criadoEm: true,
        usuarioId: true,
        usuario: { select: { nome: true, email: true } },
        itens: {
          select: {
            id: true,
            quantidade: true,
            produtoId: true,
            produto: {
              select: { id: true, nome: true, produtoPai: { select: { nome: true } }, precos: { orderBy: { criadoEm: "desc" }, take: 1 } },
            },
          },
        },
      },
      orderBy: { criadoEm: "desc" },
      take,
      skip,
    });
    return NextResponse.json(reservations);
  } catch {
    return NextResponse.json({ error: "Erro interno ao listar reservas" }, { status: 500 });
  }
}
