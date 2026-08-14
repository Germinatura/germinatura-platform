import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET() {
    const session = await getSession();
    if (!session || !["ADMIN", "VENDEDOR"].includes(session.user.perfil)) {
        return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    try {
        const rifas = await prisma.rifa.findMany({
            where: { status: "ATIVA" },
            orderBy: { criadoEm: "desc" },
            select: {
                id: true,
                titulo: true,
                descricao: true,
                imagemUrl: true,
                precoPorNumero: true,
                quantidadeNumeros: true,
                status: true,
                _count: {
                    select: { numeros: true },
                },
            },
        });

        return NextResponse.json(rifas);
    } catch (error) {
        console.error("[PDV Rifas LIST]:", error);
        return NextResponse.json({ error: "Erro ao buscar rifas." }, { status: 500 });
    }
}
