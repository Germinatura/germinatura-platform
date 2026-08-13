import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
    try {
        // 1. Calcula Saldo Atual, Total Arrecadado e Total Gasto
        const transacoes = await prisma.transacaoFinanceira.findMany();

        let configMeta: any = null;
        try {
            const results = await prisma.$queryRaw`SELECT * FROM "Configuracao" WHERE "chave" = 'META_ARRECADACAO' LIMIT 1`;
            if (Array.isArray(results) && results.length > 0) {
                configMeta = results[0];
            }
        } catch (e) {
            console.warn("Raw SQL select failed in dashboard:", e);
        }

        const meta = configMeta ? parseFloat(configMeta.valor) : parseFloat(process.env.NEXT_PUBLIC_PIX_META_ARRECADACAO || "60000");

        const totalArrecadado = transacoes
            .filter((t: any) => t.tipo === "ENTRADA")
            .reduce((acc: any, t: any) => acc + t.valor, 0);

        const totalGasto = transacoes
            .filter((t: any) => t.tipo === "SAIDA")
            .reduce((acc: any, t: any) => acc + t.valor, 0);

        const saldoAtual = totalArrecadado - totalGasto;

        // Calcula o lucro de cada semana, da primeira transação até a semana atual
        const dateNow = new Date();
        const diaSemana = dateNow.getDay(); // 0 a 6 (0 é domingo)
        // Ajusta para que segunda-feira seja o primeiro dia da semana (1)
        const diffParaSegunda = dateNow.getDate() - diaSemana + (diaSemana === 0 ? -6 : 1);
        
        const inicioSemanaAtual = new Date(dateNow);
        inicioSemanaAtual.setDate(diffParaSegunda);
        inicioSemanaAtual.setHours(0, 0, 0, 0);

        let inicioPrimeiraSemana = new Date(inicioSemanaAtual);
        if (transacoes.length > 0) {
            const minTime = Math.min(...transacoes.map((t: any) => new Date(t.data).getTime()));
            const dataMaisAntiga = new Date(minTime);
            
            const dsAntiga = dataMaisAntiga.getDay();
            const diffAntiga = dataMaisAntiga.getDate() - dsAntiga + (dsAntiga === 0 ? -6 : 1);
            inicioPrimeiraSemana = new Date(dataMaisAntiga);
            inicioPrimeiraSemana.setDate(diffAntiga);
            inicioPrimeiraSemana.setHours(0, 0, 0, 0);
        }

        let iterDate = new Date(inicioPrimeiraSemana);
        let count = 0;
        
        const lucrosNasSemanas = [];

        // Limite de 156 semanas (~3 anos) para evitar loops infinitos
        while (iterDate <= inicioSemanaAtual && count < 156) {
            const startOfWeek = new Date(iterDate);
            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(startOfWeek.getDate() + 6);
            endOfWeek.setHours(23, 59, 59, 999);

            const label = `${startOfWeek.getDate().toString().padStart(2, '0')}/${(startOfWeek.getMonth() + 1).toString().padStart(2, '0')}/${startOfWeek.getFullYear().toString().slice(-2)}`;

            const transacoesDaSemana = transacoes.filter((t: any) => {
                const dt = new Date(t.data);
                return dt >= startOfWeek && dt <= endOfWeek;
            });

            const entradas = transacoesDaSemana.filter((t: any) => t.tipo === "ENTRADA").reduce((sum: number, t: any) => sum + t.valor, 0);
            const saidas = transacoesDaSemana.filter((t: any) => t.tipo === "SAIDA").reduce((sum: number, t: any) => sum + t.valor, 0);

            lucrosNasSemanas.push({
                semana: label,
                lucro: entradas - saidas
            });

            iterDate.setDate(iterDate.getDate() + 7);
            count++;
        }
        
        if (lucrosNasSemanas.length === 0) {
            lucrosNasSemanas.push({
                semana: `${inicioSemanaAtual.getDate().toString().padStart(2, '0')}/${(inicioSemanaAtual.getMonth() + 1).toString().padStart(2, '0')}/${inicioSemanaAtual.getFullYear().toString().slice(-2)}`,
                lucro: 0
            });
        }

        // 2. Busca as últimas 3 transações
        const transacoesRecentes = await prisma.transacaoFinanceira.findMany({
            take: 3,
            orderBy: { data: "desc" },
        });

        // 3. Agrupamento simplificado por mês (últimos 6 meses)
        // Para simplificar, vamos retornar dados fixos ou uma lógica básica
        const hoje = new Date();
        const meses = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
            const label = d.toLocaleString("pt-BR", { month: "short" });

            const somaEntradas = transacoes
                .filter((t: any) => t.tipo === "ENTRADA" &&
                    new Date(t.data).getMonth() === d.getMonth() &&
                    new Date(t.data).getFullYear() === d.getFullYear())
                .reduce((acc: any, t: any) => acc + t.valor, 0);

            meses.push({ mes: label, valor: somaEntradas });
        }

        return NextResponse.json({
            saldoAtual,
            totalArrecadado,
            totalGasto,
            meta,
            lucrosNasSemanas,
            transacoesRecentes,
            entradasPorMes: meses,
        });
    } catch (error) {
        console.error("Erro ao carregar dashboard:", error);
        return NextResponse.json(
            { error: "Erro ao carregar dashboard" },
            { status: 500 }
        );
    }
}
