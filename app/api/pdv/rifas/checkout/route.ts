import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

export async function POST(req: NextRequest) {
    const session = await getSession();
    if (!session || !["ADMIN", "VENDEDOR"].includes(session.user.perfil)) {
        return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { rifaId, numeros, nome, email, telefone } = body;

        if (!rifaId || !numeros || !Array.isArray(numeros) || numeros.length === 0) {
            return NextResponse.json({ error: "Dados inválidos: rifaId e numeros são obrigatórios." }, { status: 400 });
        }

        if (!nome || !email || !telefone) {
            return NextResponse.json({ error: "Dados do comprador são obrigatórios (nome, email, telefone)." }, { status: 400 });
        }

        // Verify rifa exists and is active
        const rifa = await prisma.rifa.findUnique({
            where: { id: rifaId },
        });

        if (!rifa) {
            return NextResponse.json({ error: "Rifa não encontrada." }, { status: 404 });
        }

        if (rifa.status !== "ATIVA") {
            return NextResponse.json({ error: "Esta rifa não está ativa." }, { status: 400 });
        }

        // Verify numbers are available
        const numerosRifa = await prisma.numeroRifa.findMany({
            where: {
                rifaId,
                numero: { in: numeros },
            },
        });

        const unavailable = numerosRifa.filter(n => n.status !== "DISPONIVEL");
        if (unavailable.length > 0) {
            return NextResponse.json({
                error: `Números indisponíveis: ${unavailable.map(n => n.numero).join(", ")}`
            }, { status: 409 });
        }

        if (numerosRifa.length !== numeros.length) {
            return NextResponse.json({ error: "Alguns números não foram encontrados nessa rifa." }, { status: 400 });
        }

        // Find or create the consumer user
        let usuario = await prisma.usuario.findUnique({
            where: { email: email.toLowerCase().trim() },
        });

        if (!usuario) {
            // Create new consumer user with the default first-access password
            const hashedPassword = await hashPassword("a12");

            usuario = await prisma.usuario.create({
                data: {
                    nome: nome.trim(),
                    email: email.toLowerCase().trim(),
                    telefone: telefone.trim(),
                    senha: hashedPassword,
                    perfil: "CONSUMER",
                },
            });
        } else if (usuario.perfil !== "CONSUMER") {
            // If user exists but is not a consumer, still allow linking numbers but don't downgrade
        }

        // Update telefone if missing
        if (!usuario.telefone && telefone) {
            await prisma.usuario.update({
                where: { id: usuario.id },
                data: { telefone: telefone.trim() },
            });
        }

        // Calculate total
        const valorTotal = numeros.length * rifa.precoPorNumero;

        // Create a PedidoRifa for tracking
        const pedido = await prisma.pedidoRifa.create({
            data: {
                usuarioId: usuario.id,
                valorTotal,
                status: "PAGO", // Manual confirmation = already paid
            },
        });

        // Mark numbers as VENDIDO and link to user and pedido
        await prisma.numeroRifa.updateMany({
            where: {
                rifaId,
                numero: { in: numeros },
            },
            data: {
                status: "VENDIDO",
                usuarioId: usuario.id,
                pedidoRifaId: pedido.id,
            },
        });

        return NextResponse.json({
            success: true,
            pedidoId: pedido.id,
            usuarioId: usuario.id,
            nomeComprador: usuario.nome,
            numerosVendidos: numeros,
            valorTotal,
        });

    } catch (error) {
        console.error("[PDV Rifa Checkout] Erro:", error);
        return NextResponse.json({ error: "Erro interno ao processar a venda." }, { status: 500 });
    }
}
