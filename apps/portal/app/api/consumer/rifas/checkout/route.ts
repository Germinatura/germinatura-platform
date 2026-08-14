import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";


export async function POST(req: NextRequest) {
    const requestId = createRequestId(req.headers);
    try {
        const session = await getSession();
        if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        if (session?.user?.perfil !== "CONSUMER") {
            return NextResponse.json({ error: "Acesso negado." }, { status: 401 });
        }

        const apiKey = process.env.ABACATEPAY_API_KEY;
        if (process.env.PAYMENTS_ENABLED !== "true" || !apiKey) {
            return NextResponse.json(
                createApiError("PAYMENTS_DISABLED", "Integração de pagamentos desabilitada", requestId),
                { status: 503 },
            );
        }

        const usuarioId = session.user.id;
        const { rifaId, selectedNumbers, cpf, telefone } = await req.json();

        if (!rifaId || !selectedNumbers || !Array.isArray(selectedNumbers) || selectedNumbers.length === 0) {
            return NextResponse.json({ error: "Dados inválidos." }, { status: 400 });
        }

        console.log(`[CHECKOUT] Iniciando pedido para o usuário: ${usuarioId} (Rifa: ${rifaId})`);

        const dbUser = await prisma.usuario.findUnique({ where: { id: usuarioId } });
        if (!dbUser) return NextResponse.json({ error: "Usuário não encontrado." }, { status: 404 });

        let finalCpf = cpf || dbUser.cpf;
        let finalTelefone = telefone || dbUser.telefone;

        if (!finalCpf || !finalTelefone) {
            return NextResponse.json({ error: "MISSING_CUSTOMER_INFO" }, { status: 400 });
        }

        // Sanitização: Remover caracteres não numéricos para o AbacatePay
        const cleanCpf = finalCpf.replace(/\D/g, "");
        const cleanTelefone = finalTelefone.replace(/\D/g, "");

        if (cleanCpf.length < 11) {
            return NextResponse.json({ error: "CPF inválido." }, { status: 400 });
        }

        // Salvar os dados complementares no perfil para futuras compras
        if (!dbUser.cpf || !dbUser.telefone || (cpf && cpf !== dbUser.cpf) || (telefone && telefone !== dbUser.telefone)) {
            await prisma.usuario.update({
                where: { id: usuarioId },
                data: { cpf: finalCpf, telefone: finalTelefone }
            });
        }

        // Fetch rifa and numbers
        const rifa = await prisma.rifa.findUnique({
            where: { id: rifaId },
            include: { numeros: { where: { numero: { in: selectedNumbers } } } }
        });

        if (!rifa || rifa.status !== "ATIVA") {
            return NextResponse.json({ error: "Rifa indisponível." }, { status: 404 });
        }

        if (rifa.numeros.length !== selectedNumbers.length) {
            return NextResponse.json({ error: "Alguns números selecionados não existem." }, { status: 400 });
        }

        const unavailableList = rifa.numeros.filter(n => n.status !== "DISPONIVEL");
        if (unavailableList.length > 0) {
            return NextResponse.json({ error: "Um ou mais números já foram reservados ou vendidos." }, { status: 409 });
        }

        const valorBase = rifa.precoPorNumero * selectedNumbers.length;
        const taxaAbacate = 0.80; // Taxa fixa por transação AbacatePay
        const valorTotal = valorBase + taxaAbacate;
        const amountCents = Math.round(valorTotal * 100);

        // CREATE PEDIDO
        const pedido = await prisma.pedidoRifa.create({
            data: {
                usuarioId,
                valorTotal,
                status: "PENDENTE",
            }
        });

        console.log(`[CHECKOUT] Pedido criado: ${pedido.id}. Reservando ${selectedNumbers.length} números.`);

        // LOCK NUMBERS TO THIS ORDER
        await prisma.numeroRifa.updateMany({
            where: { rifaId, numero: { in: selectedNumbers } },
            data: { 
                status: "RESERVADO",
                usuarioId,
                pedidoRifaId: pedido.id
            }
        });

        // CALL ABACATEPAY
        // Garante que o email tenha um formato válido
        let customerEmail = dbUser.email;
        if (!customerEmail.includes("@")) {
            customerEmail = `${customerEmail.replace(/\s+/g, '')}@germinatura.com.br`;
        }

        const payload = {
            method: "PIX",
            data: {
                amount: amountCents,
                expiresIn: 900, // 15 minutos em segundos
                description: `Rifa ${rifa.titulo} - ${selectedNumbers.length} num`,
                customer: {
                    name: dbUser.nome,
                    cellphone: cleanTelefone,
                    email: customerEmail,
                    taxId: cleanCpf
                }
            }
        };

        console.log(`[CHECKOUT] Chamando AbacatePay V2 para o pedido ${pedido.id}...`);

        try {
            const abacateReq = await fetch("https://api.abacatepay.com/v2/transparents/create", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            const textResponse = await abacateReq.text();
            let abacateData;
            try {
                abacateData = JSON.parse(textResponse);
            } catch {
                console.error("Falha ao parsear reposta AbacatePay:", textResponse);
                return NextResponse.json({ error: "Erro crítico no provedor de pagamento (resposta inválida)." }, { status: 502 });
            }

            if (!abacateReq.ok) {
                console.error(`[ABACATE_ERROR] ID: ${pedido.id}:`, abacateData);
                // Revert numbers if API fails
                await prisma.numeroRifa.updateMany({
                    where: { pedidoRifaId: pedido.id },
                    data: { status: "DISPONIVEL", pedidoRifaId: null, usuarioId: null }
                });
                await prisma.pedidoRifa.delete({ where: { id: pedido.id } });
                
                const abacateMsg = abacateData?.message || abacateData?.error?.message || "Erro no processamento PIX.";
                return NextResponse.json({ error: `AbacatePay: ${abacateMsg}` }, { status: 502 });
            }

            // Sucesso V2
            const qrCodeBase64 = abacateData?.data?.brCodeBase64;
            const qrCodeUrl = (qrCodeBase64 && typeof qrCodeBase64 === 'string' && !qrCodeBase64.startsWith("data:image")) 
                ? `data:image/png;base64,${qrCodeBase64}` 
                : qrCodeBase64;
            
            const pixCopiaECola = abacateData?.data?.brCode;
            const payId = abacateData?.data?.id;

            if (!pixCopiaECola) {
                console.error("[ABACATE_DATA_MISMATCH] Response structure might have changed:", abacateData);
                return NextResponse.json({ error: "O provedor de pagamento não retornou a chave PIX." }, { status: 502 });
            }

            // Atualizar pedido com a chave PIX
            await prisma.pedidoRifa.update({
                where: { id: pedido.id },
                data: {
                    abacatePayId: payId?.toString() || null,
                    pixKey: pixCopiaECola,
                    pixQrCodeUrl: qrCodeUrl || null
                }
            });

            console.log(`[CHECKOUT] Sucesso! Pedido ${pedido.id} aguardando pagamento.`);

            return NextResponse.json({ 
                pedidoId: pedido.id,
                qrCode: pixCopiaECola,
                qrCodeUrl,
                payId
            });
        } catch (fetchError) {
            console.error("ERRO CONEXÃO ABACATEPAY:", fetchError);
            // Revert numbers if API fails
            try {
                await prisma.numeroRifa.updateMany({
                    where: { pedidoRifaId: pedido.id },
                    data: { status: "DISPONIVEL", pedidoRifaId: null, usuarioId: null }
                });
                await prisma.pedidoRifa.delete({ where: { id: pedido.id } });
            } catch (cleanupError) {
                console.error("Cleanup error after fetch fail:", cleanupError);
            }
            return NextResponse.json({ error: "Erro de conexão com o provedor de pagamentos." }, { status: 503 });
        }

    } catch (error: any) {
        console.error("CRITICAL ERROR (api/consumer/rifas/checkout):", error);
        return NextResponse.json({ 
            error: "Erro interno ao processar checkout",
            message: error.message || "Unknown error"
        }, { status: 500 });
    }
}
