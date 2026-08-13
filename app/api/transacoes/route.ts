import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth";

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const startDate = searchParams.get("startDate");
        const endDate = searchParams.get("endDate");
        const usuarioId = searchParams.get("usuarioId");
        const tipo = searchParams.get("tipo");
        const skip = parseInt(searchParams.get("skip") || "0");
        const limit = searchParams.get("limit");

        const where: any = {};

        if (startDate || endDate) {
            where.data = {};
            if (startDate) where.data.gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                where.data.lte = end;
            }
        }

        if (usuarioId) {
            where.usuarioId = usuarioId;
        }

        if (tipo) {
            where.tipo = tipo;
        }

        console.log("[API TRANSACOES] Buscando transações...");
        const [transacoes, aggregateEntrada, aggregateSaida] = await Promise.all([
            (prisma as any).transacaoFinanceira.findMany({
                where,
                include: {
                    usuario: {
                        select: {
                            nome: true
                        }
                    }
                },
                orderBy: { data: "desc" },
                take: limit === "none" ? undefined : 50,
                skip: limit === "none" ? 0 : skip
            }),
            (prisma as any).transacaoFinanceira.aggregate({
                where: { ...where, tipo: "ENTRADA" },
                _sum: { valor: true }
            }),
            (prisma as any).transacaoFinanceira.aggregate({
                where: { ...where, tipo: "SAIDA" },
                _sum: { valor: true }
            })
        ]);

        const totals = {
            entrada: aggregateEntrada._sum.valor || 0,
            saida: aggregateSaida._sum.valor || 0
        };

        console.log(`[API TRANSACOES] ${transacoes.length} transações encontradas.`);
        return NextResponse.json({
            transactions: transacoes,
            totals: totals
        });
    } catch (error) {
        console.error("ERRO CRÍTICO (GET /api/transacoes):", error);
        return NextResponse.json(
            { error: `Erro ao buscar transações: ${error instanceof Error ? error.message : "Erro desconhecido"}` },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    try {
        const session = await getSession();
        const body = await request.json();
        const { tipo, categoria, descricao, valor, data } = body;

        const transacao = await (prisma as any).transacaoFinanceira.create({
            data: {
                tipo,
                categoria,
                descricao,
                valor: parseFloat(valor),
                data: data ? new Date(data) : new Date(),
                usuarioId: session?.user?.id || null
            },
        });

        return NextResponse.json(transacao);
    } catch (error) {
        console.error("Erro ao criar transação:", error);
        return NextResponse.json(
            { error: "Erro ao criar transação" },
            { status: 500 }
        );
    }
}
