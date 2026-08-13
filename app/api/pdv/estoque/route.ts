import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil === "CONSUMER") {
            return NextResponse.json(
                { error: "Acesso negado: Requer privilégios de vendedor ou admin." },
                { status: 403 }
            );
        }

        const body = await request.json();
        const { action, itens } = body;

        if (!action || !itens || !Array.isArray(itens) || itens.length === 0) {
            return NextResponse.json(
                { error: "Dados inválidos para manipulação de estoque" },
                { status: 400 }
            );
        }

        if (action !== "reservar" && action !== "liberar") {
            return NextResponse.json(
                { error: "Ação inválida. Use 'reservar' ou 'liberar'." },
                { status: 400 }
            );
        }

        // 1. OTIMIZAÇÃO: Busca todas as informações necessárias de uma só vez fora do loop
        const produtoIds = itens.map((item: any) => item.produtoId);
        const allInfo: any[] = await prisma.$queryRawUnsafe(`
            SELECT p.id, p."isPromocional", p."produtoPaiId", pr."quantidadeMinima", p.nome, pr."tipo" as "tipoPromo", pr.id as "promocaoId"
            FROM "Produto" p
            LEFT JOIN "Promocao" pr ON p."promocaoId" = pr.id
            WHERE p.id IN (${produtoIds.map((_, i) => `$${i + 1}`).join(",")})
        `, ...produtoIds);

        const infoMap = new Map(allInfo.map(i => [i.id, i]));

        const resultado = await prisma.$transaction(async (tx: any) => {
            for (const item of itens) {
                if (!item.produtoId || typeof item.quantidade !== 'number' || item.quantidade <= 0) {
                    throw new Error("Item inválido no array de itens.");
                }

                // Usar info do Map (Batch fetch)
                const info = infoMap.get(item.produtoId) || {};
                const isPromo = info.isPromocional === true || info.ispromocional === true || info.isPromocional === 1 || info.ispromocional === 1;
                const paiId = info.produtoPaiId || info.produtopaiid;
                const qtdMin = Number(info.quantidadeMinima || info.quantidademinima || 1);
                const tipoPromo = info.tipoPromo || info.tipopromo;
                const promocaoId = info.promocaoId || info.promocaoid;

                // Fluxo Especial para Combo Mix (Subitens independentes)
                if (isPromo && tipoPromo === 'COMBO_MIX' && promocaoId) {
                    const itensCombo = await tx.promocaoItem.findMany({ where: { promocaoId } });
                    for (const comboItem of itensCombo) {
                        const quantMixFluxo = item.quantidade * comboItem.quantidade;
                        const mixTargetId = comboItem.produtoId;
                        
                        if (action === "reservar") {
                            const result: any[] = await tx.$queryRawUnsafe(`
                                UPDATE "Produto"
                                SET estoque = estoque - $1, "atualizadoEm" = CURRENT_TIMESTAMP
                                WHERE id = $2 AND estoque >= $1
                                RETURNING id, nome, estoque
                            `, quantMixFluxo, mixTargetId);

                            if (result.length === 0) {
                                const prod: any[] = await tx.$queryRawUnsafe(`SELECT nome, estoque FROM "Produto" WHERE id = $1`, mixTargetId);
                                throw new Error(prod.length === 0 ? `Produto do combo não encontrado: ${mixTargetId}` : `Estoque insuficiente para compor o Combo. Item: ${prod[0].nome}. Disp: ${prod[0].estoque}, Req: ${quantMixFluxo}`);
                            }
                        } else if (action === "liberar") {
                            await tx.$executeRawUnsafe(
                                `UPDATE "Produto" SET estoque = estoque + $1 WHERE id = $2`,
                                quantMixFluxo,
                                mixTargetId
                            );
                        }
                    }
                    continue; // Skip o update principal
                }

                let targetId = item.produtoId;
                let quantFinal = item.quantidade;

                if (isPromo && paiId && tipoPromo !== 'COMBO_MIX') {
                    targetId = paiId;
                    quantFinal = item.quantidade * qtdMin;
                }

                // Se for reservar, verifica se tem estoque suficiente e desconta
                if (action === "reservar") {
                    // Update atômico com ACID
                    const result: any[] = await tx.$queryRawUnsafe(`
                        UPDATE "Produto"
                        SET estoque = estoque - $1, "atualizadoEm" = CURRENT_TIMESTAMP
                        WHERE id = $2 AND estoque >= $1
                        RETURNING id, nome, estoque
                    `, quantFinal, targetId);

                    if (result.length === 0) {
                        // Falhou o update - o produto não existe ou não tem estoque
                        const prod: any[] = await tx.$queryRawUnsafe(
                            `SELECT nome, estoque FROM "Produto" WHERE id = $1`,
                            targetId
                        );

                        if (prod.length === 0) {
                            throw new Error(`Produto não encontrado: ${targetId}`);
                        } else {
                            throw new Error(`Estoque insuficiente para ${info.nome || prod[0].nome}. Disponível: ${prod[0].estoque}, Solicitado: ${quantFinal}`);
                        }
                    }
                } else if (action === "liberar") {
                    // Efetua a liberação (incrementa)
                    await tx.$executeRawUnsafe(
                        `UPDATE "Produto" SET estoque = estoque + $1 WHERE id = $2`,
                        quantFinal,
                        targetId
                    );
                }
            }
            return { success: true, action };
        });

        return NextResponse.json(resultado);
    } catch (error: any) {
        console.error(`Erro ao ${error?.message?.includes('Ação') ? 'manipular' : 'processar'} estoque:`, error);

        const errorMessage = error instanceof Error ? error.message : "Erro interno do servidor";
        const isClientError = errorMessage.includes('Estoque insuficiente') ||
            errorMessage.includes('Produto não encontrado') ||
            errorMessage.includes('inválid');

        return NextResponse.json(
            { error: errorMessage },
            { status: isClientError ? 400 : 500 }
        );
    }
}
