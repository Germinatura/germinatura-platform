import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth";


export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get("session")?.value;
        if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        let session;
        try {
            session = await decrypt(token);
        } catch (authError) {
            console.error("Auth Failure (GET CONSUMER RIFA ID):", authError);
            return NextResponse.json({ error: "Sessão expirada. Faça login novamente." }, { status: 401 });
        }

        const perfil = session?.user?.perfil;
        if (perfil !== "CONSUMER" && perfil !== "VENDEDOR" && perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado." }, { status: 401 });
        }

        const id = (await params).id;

        try {
            // Lazy Cancellation de PIX Expirados (> 15 min)
            const expiracao = new Date(Date.now() - 15 * 60 * 1000);
            const expiredPedidos = await prisma.pedidoRifa.findMany({
                where: { status: "PENDENTE", criadoEm: { lt: expiracao }, numerosRifa: { some: { rifaId: id } } }
            });

            if (expiredPedidos.length > 0) {
                console.log(`[LAZY CANCEL DETAIL] Cancelling ${expiredPedidos.length} expired orders for rifa ${id}.`);
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
            console.error("Lazy Cancellation Error (Detail):", cancelError);
            // Ignore cancelError to not break the detail view
        }

        const rifa = await prisma.rifa.findUnique({
            where: { id },
            include: {
                numeros: {
                    select: {
                        id: true,
                        numero: true,
                        status: true,
                        // Note: Consumer should NOT see the buyer's details.
                    },
                    orderBy: { numero: 'asc' }
                }
            }
        });

        if (!rifa) return NextResponse.json({ error: "Rifa não encontrada" }, { status: 404 });

        // Uma rifa em rascunho não deve poder ser acessada por ninguém exceto ADMINS
        if (rifa.status === "RASCUNHO" && perfil !== "ADMIN") {
            return NextResponse.json({ error: "Esta rifa ainda não está disponível." }, { status: 403 });
        }

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

        return NextResponse.json({ ...rifa, ganhadorNome });
    } catch (error) {
        console.error("GET CONSUMER RIFA ID:", error);
        return NextResponse.json({ error: "Erro ao buscar rifa" }, { status: 500 });
    }
}
