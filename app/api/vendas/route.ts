import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(request: Request) {
    try {
        const session = await getSession();
        if (!session || (session.user.perfil !== "ADMIN" && session.user.perfil !== "VENDEDOR")) {
            return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
        }
        
        const { searchParams } = new URL(request.url);
        const skip = parseInt(searchParams.get("skip") || "0");
        const limit = searchParams.get("limit");

        console.log("[API VENDAS] Buscando vendas...");
        const vendas = await prisma.venda.findMany({
            select: {
                id: true,
                total: true,
                criadoEm: true,
                usuario: {
                    select: {
                        nome: true,
                        email: true
                    }
                },
                itens: {
                    select: {
                        id: true,
                        quantidade: true,
                        precoUnitario: true,
                        produto: {
                            select: {
                                nome: true,
                                produtoPai: {
                                    select: {
                                        nome: true
                                    }
                                }
                            }
                        }
                    }
                },
                transacao: {
                    select: {
                        id: true
                    }
                }
            },
            orderBy: { criadoEm: "desc" },
            take: limit === "none" ? undefined : 50,
            skip: limit === "none" ? 0 : skip,
        });
        console.log(`[API VENDAS] ${vendas.length} vendas encontradas.`);
        return NextResponse.json({
            transactions: vendas
        });
    } catch (error) {
        console.error("Erro ao buscar vendas:", error);
        return NextResponse.json(
            { error: "Erro ao buscar vendas" },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { total, itens, estoqueJaDescontado } = body;

        const session = await getSession();
        const usuarioId = session?.user?.id;
        const perfil = session?.user?.perfil;

        if (!session || perfil === "CONSUMER") {
            return NextResponse.json(
                { error: "Acesso negado: Requer privilégios de vendedor ou admin." },
                { status: 403 }
            );
        }

        // Inicia uma transação Prisma para garantir que tudo seja criado ou nada
        const resultado = await prisma.$transaction(async (tx: any) => {
            // 1. Validar e descontar estoque (se não foi descontado previamente)
            if (!estoqueJaDescontado) {
                for (const item of itens) {
                    console.log(`[DEBUG PDV] Processando item: ${item.produtoId}, Qtd: ${item.quantidade}`);

                    // Buscar se o produto é promocional e tem pai ou combo mix
                    const query = `
                        SELECT p.id, p.nome, p."isPromocional", p."produtoPaiId", pr."quantidadeMinima", pr."tipo" as "tipoPromo", pr.id as "promocaoId"
                        FROM "Produto" p
                        LEFT JOIN "Promocao" pr ON p."promocaoId" = pr.id
                        WHERE p.id = '${item.produtoId}'
                    `;

                    const produtoInfoArr: any[] = await tx.$queryRawUnsafe(query);
                    const produtoInfo = produtoInfoArr[0] || {};
                    console.log(`[DEBUG PDV] Dados SQL:`, JSON.stringify(produtoInfo));

                    let targetId = item.produtoId;
                    let quantADescontar = item.quantidade;

                    // Tentar capturar campos em qualquer casing (Postgres pode ser chato com quotes)
                    const isPromoField = produtoInfo.isPromocional ?? produtoInfo.ispromocional ?? false;
                    const paiIdField = produtoInfo.produtoPaiId ?? produtoInfo.produtopaiid ?? null;
                    const qtdMinField = Number(produtoInfo.quantidadeMinima ?? produtoInfo.quantidademinima ?? 1);
                    const tipoPromo = produtoInfo.tipoPromo ?? produtoInfo.tipopromo ?? null;
                    const promocaoId = produtoInfo.promocaoId ?? produtoInfo.promocaoid ?? null;

                    const isPromo = isPromoField === true || isPromoField === 'true' || isPromoField === 1;
                    const paiId = paiIdField;

                    if (isPromo && tipoPromo === 'COMBO_MIX' && promocaoId) {
                        console.log(`[DEBUG PDV] COMBO_MIX DETECTADO! PromocaoId: ${promocaoId}`);
                        const itensCombo = await tx.promocaoItem.findMany({ where: { promocaoId } });
                        for (const comboItem of itensCombo) {
                            const quantMixDescontar = item.quantidade * comboItem.quantidade;
                            const mixTargetId = comboItem.produtoId;
                            
                            const result: any[] = await tx.$queryRawUnsafe(`
                                UPDATE "Produto"
                                SET estoque = estoque - $1, "atualizadoEm" = CURRENT_TIMESTAMP
                                WHERE id = $2 AND estoque >= $1
                                RETURNING id, nome, estoque
                            `, quantMixDescontar, mixTargetId);

                            if (result.length === 0) {
                                const prod: any[] = await tx.$queryRawUnsafe(`SELECT nome, estoque FROM "Produto" WHERE id = $1`, mixTargetId);
                                throw new Error(prod.length === 0 ? `Produto do combo não encontrado: ${mixTargetId}` : `Estoque insuficiente para compor o Combo. Item: ${prod[0].nome}. Disp: ${prod[0].estoque}, Req: ${quantMixDescontar}`);
                            }
                        }
                        continue; // Passa para o próximo item do carrinho (não precisa rodar o update final abaixo)
                    } else if (isPromo && paiId && tipoPromo !== 'COMBO_MIX') {
                        targetId = paiId;
                        quantADescontar = item.quantidade * qtdMinField;
                        console.log(`[DEBUG PDV] COMBO DETECTADO! Redirecionando: ${item.produtoId} -> ${targetId} (Qtd: ${quantADescontar})`);
                    } else {
                        console.log(`[DEBUG PDV] Produto Normal (isPromo:${isPromo}, paiId:${paiId})`);
                    }

                    // Update atômico com ACID
                    const result: any[] = await tx.$queryRawUnsafe(`
                        UPDATE "Produto"
                        SET estoque = estoque - $1, "atualizadoEm" = CURRENT_TIMESTAMP
                        WHERE id = $2 AND estoque >= $1
                        RETURNING id, nome, estoque
                    `, quantADescontar, targetId);

                    if (result.length === 0) {
                        const prod: any[] = await tx.$queryRawUnsafe(`SELECT nome, estoque FROM "Produto" WHERE id = $1`, targetId);
                        if (prod.length === 0) {
                            throw new Error(`Produto não encontrado: ${targetId}`);
                        } else {
                            throw new Error(`Estoque insuficiente para ${prod[0].nome}. Disponível: ${prod[0].estoque}, Solicitado: ${quantADescontar}`);
                        }
                    }
                }
            }

            // 2. Cria a Transação Financeira de Entrada
            const transacao = await tx.transacaoFinanceira.create({
                data: {
                    tipo: "ENTRADA",
                    categoria: "Venda PDV",
                    descricao: `Venda PDV - ${itens.length} itens`,
                    valor: parseFloat(total),
                    data: new Date(),
                    usuarioId: usuarioId || null,
                },
            });

            // 3. Cria a Venda vinculada à transação
            const venda = await tx.venda.create({
                data: {
                    total: parseFloat(total),
                    transacaoId: transacao.id,
                    usuarioId: usuarioId || null,
                    itens: {
                        create: itens.map((item: any) => ({
                            produtoId: item.produtoId,
                            quantidade: item.quantidade,
                            precoUnitario: parseFloat(item.precoUnitario),
                        })),
                    },
                },
                include: {
                    itens: true,
                },
            });

            return { venda, transacao };
        });

        return NextResponse.json(resultado);
    } catch (error) {
        console.error("Erro ao registrar venda:", error);
        return NextResponse.json(
            { error: "Erro ao registrar venda" },
            { status: 500 }
        );
    }
}
