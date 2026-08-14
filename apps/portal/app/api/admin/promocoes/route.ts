import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TipoPromocao } from "@prisma/client";

export async function GET() {
    try {
        // Rotina para inativar promoções expiradas automaticamente
        const now = new Date();
        const expiradas = await prisma.promocao.findMany({
            where: {
                ativo: true,
                dataFim: { lt: now }
            },
            select: { id: true }
        });

        if (expiradas.length > 0) {
            const ids = expiradas.map(p => p.id);
            // 1. Inativa as promoções
            await prisma.promocao.updateMany({
                where: { id: { in: ids } },
                data: { ativo: false }
            });
            // 2. Inativa produtos associados (combos, qdt)
            await prisma.produto.updateMany({
                where: { promocaoId: { in: ids } },
                data: { ativo: false }
            });
        }

        const promocoes = await prisma.promocao.findMany({
            include: {
                produtos: {
                    take: 1
                }
            },
            orderBy: { criadoEm: "desc" }
        });
        return NextResponse.json(promocoes);
    } catch (error) {
        console.error("Erro ao buscar promoções:", error);
        return NextResponse.json({ error: "Erro ao buscar promoções" }, { status: 500 });
    }
}

import { getSession } from "@/lib/auth";

export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado. Apenas administradores." }, { status: 403 });
        }

        const body = await request.json();
        const {
            produtoId,
            tipo,
            valorDesconto,
            quantidadeMinima,
            dataInicio,
            dataFim,
            itensCombo, // Array de {produtoId, quantidade} para COMBO_MIX
            imagemUrl,  // Base64 para COMBO_MIX
            comboName   // Nome opcional para o combo
        } = body;

        if (tipo !== "COMBO_MIX") {
            // Validar produto pai
            const produtoPai = await prisma.produto.findUnique({
                where: { id: produtoId },
                include: { precos: { orderBy: { criadoEm: "desc" }, take: 1 } }
            });

            if (!produtoPai) {
                return NextResponse.json({ error: "Produto original não encontrado" }, { status: 404 });
            }

            if (tipo === "VALOR" || tipo === "GRUPO") {
                // Verificar se já existe promoção de valor ativa
                const existAtiva = await prisma.promocao.findFirst({
                    where: {
                        produtoId,
                        tipo: { in: ["VALOR", "GRUPO"] },
                        ativo: true,
                        dataFim: { gte: new Date() }
                    }
                });
                if (existAtiva) {
                    return NextResponse.json({ error: "Já existe uma promoção ativa para este produto/grupo" }, { status: 400 });
                }
            }
        }

        const promData: any = {
            tipo,
            valorDesconto: parseFloat(valorDesconto),
            dataInicio: new Date(dataInicio),
            dataFim: new Date(dataFim),
        };

        if (tipo === "QUANTIDADE" || tipo === "COMBO") {
            promData.quantidadeMinima = parseInt(quantidadeMinima);
        }

        if (produtoId) {
            promData.produtoId = produtoId;
        }

        const promocao = await prisma.promocao.create({
            data: promData
        });

        // Se for COMBO_MIX, criar Itens e o produto fake
        if (tipo === "COMBO_MIX") {
            if (itensCombo && itensCombo.length > 0) {
                await Promise.all(itensCombo.map(async (item: any) => {
                    await (prisma as any).promocaoItem.create({
                        data: {
                            promocaoId: promocao.id,
                            produtoId: item.produtoId,
                            quantidade: parseInt(item.quantidade)
                        }
                    });
                }));
            }

            const precoFixo = parseFloat(valorDesconto);
            await prisma.produto.create({
                data: {
                    nome: comboName || "Combo Especial",
                    ativo: true,
                    isPromocional: true,
                    promocaoId: promocao.id,
                    imagemUrl: imagemUrl || null,
                    precos: {
                        create: {
                            valor: precoFixo
                        }
                    }
                }
            });
        }
        // Se for QUANTIDADE ou COMBO, criar o produto temporário
        else if (tipo === "QUANTIDADE" || tipo === "COMBO") {
            const produtoPai = await prisma.produto.findUnique({ where: { id: produtoId } });
            const precoFixo = parseFloat(valorDesconto);
            await prisma.produto.create({
                data: {
                    nome: `${produtoPai?.nome} (Promoção ${quantidadeMinima} un.)`,
                    ativo: true,
                    isPromocional: true,
                    produtoPaiId: produtoId,
                    promocaoId: promocao.id,
                    precos: {
                        create: {
                            valor: precoFixo
                        }
                    }
                }
            });
        }

        return NextResponse.json(promocao);
    } catch (error) {
        console.error("Erro ao criar promoção:", error);
        return NextResponse.json({ error: "Erro ao criar promoção" }, { status: 500 });
    }
}
