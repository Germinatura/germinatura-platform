import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth";


export async function GET() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get("session")?.value;
        if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        let session;
        try {
            session = await decrypt(token);
        } catch (authError) {
            console.error("Auth Failure (GET CONSUMER RIFAS):", authError);
            return NextResponse.json({ error: "Sessão expirada. Faça login novamente." }, { status: 401 });
        }

        const perfil = session?.user?.perfil;
        if (perfil !== "CONSUMER" && perfil !== "VENDEDOR" && perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado." }, { status: 401 });
        }

        const umaSemanaAtras = new Date();
        umaSemanaAtras.setDate(umaSemanaAtras.getDate() - 7);

        try {
            // Lazy Cancellation global de PIX Expirados
            const expiracao = new Date(Date.now() - 15 * 60 * 1000);
            const expiredPedidos = await prisma.pedidoRifa.findMany({
                where: { status: "PENDENTE", criadoEm: { lt: expiracao } }
            });

            if (expiredPedidos.length > 0) {
                console.log(`[LAZY CANCEL] Cancelling ${expiredPedidos.length} expired orders.`);
                const ids = expiredPedidos.map(p => p.id);
                await prisma.pedidoRifa.updateMany({
                    where: { id: { in: ids } },
                    data: { status: "CANCELADO" }
                });
                await prisma.numeroRifa.updateMany({
                    where: { pedidoRifaId: { in: ids } },
                    data: { status: "DISPONIVEL", pedidoRifaId: null, usuarioId: null }
                });
            }
        } catch (cancelError) {
            console.error("Lazy Cancellation Error:", cancelError);
            // We ignore cancelError to not break the main rifas flow
        }

        const rifas = await prisma.rifa.findMany({
            where: {
                OR: [
                    { status: "ATIVA" },
                    { 
                        status: "FINALIZADA",
                        atualizadoEm: { gte: umaSemanaAtras } 
                    }
                ]
            },
            orderBy: { criadoEm: 'desc' },
            include: {
                _count: { select: { numeros: true } }
            }
        });

        // Attach winner names for finished rifas
        const rifasComGanhador = await Promise.all(rifas.map(async (rifa) => {
            let ganhadorNome = null;
            // FIX: Robust check for number 0 (if(0) is false, but 0 is a valid number)
            if (rifa.status === "FINALIZADA" && rifa.numeroSorteado !== null) {
                const numeroVencedor = await prisma.numeroRifa.findFirst({
                    where: { rifaId: rifa.id, numero: rifa.numeroSorteado },
                    include: { usuario: { select: { nome: true } } }
                });
                if (numeroVencedor?.usuario) {
                    ganhadorNome = numeroVencedor.usuario.nome;
                }
            }
            return { ...rifa, ganhadorNome };
        }));

        return NextResponse.json(rifasComGanhador);
    } catch (error) {
        console.error("CRITICAL ERROR (api/consumer/rifas):", error);
        return NextResponse.json({ error: "Erro interno ao processar rifas" }, { status: 500 });
    }
}
