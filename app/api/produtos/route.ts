import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const adminView = searchParams.get("adminView") === "true";
        const now = new Date();

        // 1. Buscar produtos base ativos
        const produtosBase = await prisma.produto.findMany({
            where: {
                isPromocional: false,
            },
            include: {
                precos: {
                    orderBy: { criadoEm: "desc" },
                    take: 1
                }
            },
            orderBy: { criadoEm: "desc" },
        });

        // 2. Buscar estoques
        let estoqueMap: Record<string, number> = {};
        try {
            const rawEstoques: any[] = await prisma.$queryRawUnsafe(`SELECT id, estoque, ativo FROM "Produto"`);
            rawEstoques.forEach(item => {
                estoqueMap[item.id] = item.estoque;
            });
        } catch (rawErr) {
            console.warn("Produtos API: Failed to fetch raw stock:", rawErr);
        }

        // 3. Buscar TODAS as promoções ativas para mapeamento
        const promocoesAtivas = await prisma.promocao.findMany({
            where: {
                ativo: true,
                dataInicio: { lte: now },
                dataFim: { gte: now }
            }
        });

        const promoMap: Record<string, any> = {};
        promocoesAtivas.forEach(p => {
            // Se houver mais de uma, a última ganha (ou podemos definir prioridade)
            if ((p as any).produtoId) promoMap[(p as any).produtoId] = p;
        });

        // 4. Buscar produtos promocionais (Combos e COMBO_MIX)
        const combosRaw: any[] = await prisma.produto.findMany({
            where: {
                isPromocional: true,
            },
            include: {
                precos: {
                    orderBy: { criadoEm: "desc" },
                    take: 1
                },
                produtoPai: true,
                promocao: {
                    include: {
                        // as any trick applied via any[] cast above
                        itensCombo: true
                    } as any
                }
            }
        });

        // 5. Mapear e filtrar
        const produtosFormatados = produtosBase.map(p => {
            const precoBase = p.precos?.[0]?.valor || 0;
            let precoFinal = precoBase;
            let temDesconto = false;
            let percentualMaximo = 0;
            let promoVencedora = null;

            // Promoção direta no produto
            const promoProduto = promoMap[p.id];
            if (promoProduto && (promoProduto.tipo === "VALOR" || promoProduto.tipo === "GRUPO")) {
                percentualMaximo = promoProduto.valorDesconto || 0;
                promoVencedora = promoProduto;
            }

            // Promoção no grupo (produto pai)
            if (p.produtoPaiId) {
                const promoPai = promoMap[p.produtoPaiId];
                if (promoPai && (promoPai.tipo === "VALOR" || promoPai.tipo === "GRUPO")) {
                    const descPai = promoPai.valorDesconto || 0;
                    if (descPai > percentualMaximo) {
                        percentualMaximo = descPai;
                        promoVencedora = promoPai;
                    }
                }
            }

            // Aplicar desconto de valor (%) se houver promoção ativa
            if (percentualMaximo > 0) {
                precoFinal = Number((precoBase * (1 - percentualMaximo / 100)).toFixed(2));
                temDesconto = true;
            }

            return {
                ...p,
                precoOriginal: precoBase,
                preco: precoFinal,
                temDesconto,
                promocao: promoVencedora || null, // Para compatibilidade com o frontend
                estoque: estoqueMap[p.id] ?? 0
            };
        });

        const combosFiltrados = adminView ? [] : combosRaw
            .filter(c => {
                if (!c.promocaoId) return false;
                const promo = promocoesAtivas.find(p => p.id === c.promocaoId);
                if (!promo || !promo.ativo) return false;

                if ((promo as any).tipo === "COMBO_MIX") {
                    const itens = c.promocao?.itensCombo || [];
                    if (itens.length === 0) return false;
                    
                    // Checar se todos os itens possuem estoque
                    for (const item of itens) {
                        const estItem = estoqueMap[item.produtoId] ?? 0;
                        if (estItem < item.quantidade) return false;
                    }
                    return true;
                } else {
                    if (!c.produtoPai || !c.produtoPai.ativo) return false;
                    const estoquePai = estoqueMap[c.produtoPaiId!] ?? 0;
                    const reqMin = promo.quantidadeMinima ?? 0;
                    return estoquePai >= reqMin;
                }
            })
            .map(c => {
                const promo = promocoesAtivas.find(p => p.id === c.promocaoId);
                let estoqueCalculado = 0;

                if ((promo as any)?.tipo === "COMBO_MIX") {
                    const itens = c.promocao?.itensCombo || [];
                    let minEstoquePossivel = Infinity;
                    for (const item of itens) {
                        const limitItem = Math.floor((estoqueMap[item.produtoId] ?? 0) / (item.quantidade || 1));
                        if (limitItem < minEstoquePossivel) {
                            minEstoquePossivel = limitItem;
                        }
                    }
                    estoqueCalculado = minEstoquePossivel === Infinity ? 0 : minEstoquePossivel;
                } else {
                    estoqueCalculado = Math.floor((estoqueMap[c.produtoPaiId!] ?? 0) / (promo?.quantidadeMinima || 1));
                }

                return {
                    ...c,
                    // COMBO_MIX e QUANTIDADE priorizam a imagem deles mesmos se houver.
                    imagemUrl: c.imagemUrl || c.produtoPai?.imagemUrl,
                    precoOriginal: 0,
                    preco: c.precos?.[0]?.valor || 0,
                    promocao: promo,
                    estoque: estoqueCalculado
                };
            });

        return NextResponse.json([...produtosFormatados, ...combosFiltrados]);
    } catch (error) {
        console.error("Erro ao buscar produtos:", error);
        return NextResponse.json(
            { error: "Erro ao buscar produtos" },
            { status: 500 }
        );
    }
}



import { getSession } from "@/lib/auth";

export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado. Apenas administradores podem criar produtos." }, { status: 403 });
        }

        const formData = await request.formData();
        const nome = formData.get("nome") as string;
        const preco = formData.get("preco") as string;
        const ativo = formData.get("ativo") === "true";
        const file = formData.get("imagem") as File | null;
        
        const isGroup = formData.get("isGroup") === "true";
        const produtoPaiIdStr = formData.get("produtoPaiId") as string | null;
        const produtoPaiId = produtoPaiIdStr ? produtoPaiIdStr : null;

        let imagemUrl = formData.get("imagemUrl") as string | null;

        if (file && file.size > 0) {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            const base64String = buffer.toString("base64");
            imagemUrl = `data:${file.type};base64,${base64String}`;
        }

        const produto = await prisma.produto.create({
            data: {
                nome,
                ativo: ativo ?? true,
                imagemUrl,
                isGroup,
                produtoPaiId,
                precos: {
                    create: {
                        valor: isGroup ? 0 : parseFloat(preco || "0")
                    }
                }
            },
            include: {
                precos: true
            }
        });

        return NextResponse.json({
            ...produto,
            preco: produto.precos[0]?.valor || 0
        });
    } catch (error) {
        console.error("Erro ao criar produto:", error);
        return NextResponse.json(
            { error: `Erro ao criar produto: ${error instanceof Error ? error.message : "Erro desconhecido"}` },
            { status: 500 }
        );
    }
}
