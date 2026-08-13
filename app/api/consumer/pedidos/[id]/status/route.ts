import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth";


export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const id = (await params).id;
        
        // Security checks (Optional but good practice to ensure caller is the owner)
        const cookieStore = await cookies();
        const token = cookieStore.get("session")?.value;
        const session = token ? await decrypt(token) : null;
        
        const pedido = await prisma.pedidoRifa.findUnique({
            where: { id },
            include: { numerosRifa: true }
        });

        if (!pedido) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
        
        // Protect so only the owner or an admin can poll the status
        if (session && session.user.perfil === "CONSUMER" && pedido.usuarioId !== session.user.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Se já atualizou no banco via Webhook ou polling anterior
        if (pedido.status === "PAGO") {
            return NextResponse.json({ status: "PAGO" });
        }

        if (!pedido.abacatePayId) {
            return NextResponse.json({ status: "PENDENTE" }); // Pagamento não tem txid ou falhou ao gerar
        }

        const apiKey = process.env.ABACATEPAY_API_KEY;
        if (!apiKey) return NextResponse.json({ error: "Configuração do AbacatePay ausente" }, { status: 500 });

        // Polling oficial na API v2 (transparents/check)
        const abacateReq = await fetch(`https://api.abacatepay.com/v2/transparents/check?id=${pedido.abacatePayId}`, {
            method: "GET",
            headers: { 
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            }
        });

        if (!abacateReq.ok) {
            console.error("Erro ao verificar status na AbacatePay V2:", await abacateReq.text());
            return NextResponse.json({ status: "PENDENTE" });
        }

        const data = await abacateReq.json();
        const gatewayStatus = data?.data?.status;

        if (gatewayStatus === "PAID" || gatewayStatus === "PAGO" || gatewayStatus === "COMPLETED") {
            // Confirmar Pix!
            await prisma.pedidoRifa.update({
                where: { id: pedido.id },
                data: { status: "PAGO" }
            });
            
            await prisma.numeroRifa.updateMany({
                where: { pedidoRifaId: pedido.id },
                data: { status: "VENDIDO" }
            });
            
            return NextResponse.json({ status: "PAGO" });
        }

        return NextResponse.json({ status: "PENDENTE" });

    } catch (error) {
        console.error("ERRO POLLING STATUS:", error);
        return NextResponse.json({ error: "Erro interno no servidor" }, { status: 500 });
    }
}
