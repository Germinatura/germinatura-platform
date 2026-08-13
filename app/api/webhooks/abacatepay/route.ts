import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";


export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        
        // Verifica assinatura/webhook se aplicável
        const { event, data } = body;

        // Considerando um padrão de webhook do AbacatePay 
        // Em que o payload contém o ID ou Status.
        if (event === "BILLING_PAID" || data?.status === "PAID" || data?.status === "PAGO") {
            const abacatePayId = data?.id || data?.metadata?.id;
            
            if (abacatePayId) {
                const pedido = await prisma.pedidoRifa.findUnique({
                    where: { abacatePayId }
                });

                if (pedido && pedido.status !== "PAGO") {
                    await prisma.pedidoRifa.update({
                        where: { id: pedido.id },
                        data: { status: "PAGO" }
                    });
                    
                    await prisma.numeroRifa.updateMany({
                        where: { pedidoRifaId: pedido.id },
                        data: { status: "VENDIDO" }
                    });
                }
            }
        }

        return NextResponse.json({ received: true });

    } catch (error) {
        console.error("Erro no Webhook AbacatePay:", error);
        // Mesmo falhando as lógicas, deve-se retornar 200 pra n prender o webhook
        return NextResponse.json({ error: "Erro processando webhook" }, { status: 200 }); 
    }
}
