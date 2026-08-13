import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { decrypt } from "@/lib/auth";

export async function POST(req: NextRequest) {
    try {
        const cookie = req.cookies.get("session")?.value;
        if (!cookie) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
        const session = await decrypt(cookie);
        if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

        const body = await req.json();
        const { itens } = body; // [{ produtoId: string, quantidade: number }]

        if (!itens || !Array.isArray(itens) || itens.length === 0) {
            return NextResponse.json({ error: "Itens da reserva são obrigatórios" }, { status: 400 });
        }

        const config = await prisma.configuracao.findUnique({
            where: { chave: "reservas_ativas" }
        });
        
        if (config && config.valor === "false") {
            return NextResponse.json({ error: "As reservas estão temporariamente desativadas." }, { status: 403 });
        }

        // Inicia uma transação Prisma para garantir que a reserva e a validação de estoque sejam atômicas
        const reserva = await prisma.$transaction(async (tx: any) => {
            // 1. Validar estoque e status promocional
            for (const item of itens) {
                // Busca o produto de forma robusta, incluindo flags de promoção
                let produto: any;
                try {
                    produto = await tx.produto.findUnique({
                        where: { id: item.produtoId },
                        select: {
                            nome: true,
                            estoque: true,
                            isPromocional: true,
                            promocaoId: true
                        }
                    });

                    // Se tiver promocaoId, verificar se a promoção está ativa e na validade
                    if (produto?.promocaoId) {
                        const now = new Date();
                        const promocao = await tx.promocao.findUnique({
                            where: { id: produto.promocaoId }
                        });

                        if (promocao && promocao.ativo && now >= promocao.dataInicio && now <= promocao.dataFim) {
                            throw new Error(`Produtos em promoção não podem ser reservados: ${produto.nome}`);
                        }
                    }

                    if (produto?.isPromocional) {
                        throw new Error(`Combos não podem ser reservados: ${produto.nome}`);
                    }

                } catch (readError: any) {
                    if (readError.message.includes("não podem ser reservados")) throw readError;

                    console.warn(`Reservas API: Prisma select failed for ${item.produtoId}, using raw SQL:`, readError.message);
                    const query = `
                        SELECT p.nome, p.estoque, p."isPromocional", p."promocaoId", pr.ativo as "promoAtiva", pr."dataInicio", pr."dataFim"
                        FROM "Produto" p
                        LEFT JOIN "Promocao" pr ON p."promocaoId" = pr.id
                        WHERE p.id = $1
                    `;
                    const rawResult: any[] = await tx.$queryRawUnsafe(query, item.produtoId);
                    produto = rawResult[0];

                    if (produto) {
                        const now = new Date();
                        const isPromo = produto.isPromocional || produto.ispromocional;
                        const promoAtiva = produto.promoAtiva || produto.promoativa;
                        const dInicio = produto.dataInicio || produto.datainicio;
                        const dFim = produto.dataFim || produto.datafim;

                        if (isPromo) {
                            throw new Error(`Combos não podem ser reservados: ${produto.nome}`);
                        }

                        if (promoAtiva && now >= new Date(dInicio) && now <= new Date(dFim)) {
                            throw new Error(`Produtos em promoção não podem ser reservados: ${produto.nome}`);
                        }
                    }
                }

                if (!produto) {
                    throw new Error(`Produto não encontrado: ${item.produtoId}`);
                }

                if (produto.estoque < item.quantidade) {
                    throw new Error(`Estoque insuficiente para ${produto.nome}. Disponível: ${produto.estoque}, solicitado: ${item.quantidade}`);
                }

                try {
                    await tx.produto.update({
                        where: { id: item.produtoId },
                        data: { estoque: { decrement: item.quantidade } }
                    });
                } catch (updateError: any) {
                    console.warn(`Reservas API: Prisma update failed for ${item.produtoId}, using raw SQL:`, updateError.message);
                    await tx.$executeRawUnsafe(
                        `UPDATE "Produto" SET estoque = estoque - $1 WHERE id = $2`,
                        item.quantidade,
                        item.produtoId
                    );
                }
            }

            // 2. Criar a reserva
            return await tx.reserva.create({
                data: {
                    usuarioId: session.user.id,
                    status: "PENDENTE",
                    itens: {
                        create: itens.map((item: any) => ({
                            produtoId: item.produtoId,
                            quantidade: item.quantidade,
                        })),
                    },
                },
                include: {
                    itens: true,
                },
            });
        });

        return NextResponse.json(reserva);
    } catch (error: any) {
        console.error("Erro ao criar reserva:", error);
        if (error.message && (error.message.includes("Estoque insuficiente") || error.message.includes("Produto não encontrado"))) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: "Erro interno ao criar reserva" }, { status: 500 });
    }
}

export async function GET(req: NextRequest) {
    try {
        const cookie = req.cookies.get("session")?.value;
        if (!cookie) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
        const session = await decrypt(cookie);
        if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

        const { searchParams } = new URL(req.url);
        const seeAll = searchParams.get("all") === "true";
        const skip = parseInt(searchParams.get("skip") || "0");
        const take = parseInt(searchParams.get("take") || "50");

        const queryOptions: any = {
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
                            select: {
                                id: true,
                                nome: true,
                                produtoPai: {
                                    select: { nome: true }
                                },
                                precos: {
                                    orderBy: { criadoEm: "desc" },
                                    take: 1
                                }
                            }
                        }
                    }
                },
            },
            orderBy: { criadoEm: "desc" },
            take: take,
            skip: skip,
        };

        if (session.user.perfil === "ADMIN" && seeAll) {
            const reservas = await prisma.reserva.findMany(queryOptions);
            return NextResponse.json(reservas);
        } else {
            // Default: Only see own reservations (Admins, Sellers, Consumers)
            const reservas = await prisma.reserva.findMany({
                ...queryOptions,
                where: { usuarioId: session.user.id },
            });
            return NextResponse.json(reservas);
        }
    } catch (error) {
        console.error("Erro ao listar reservas:", error);
        return NextResponse.json({ error: "Erro interno ao listar reservas" }, { status: 500 });
    }
}
