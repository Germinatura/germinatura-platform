import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const session = await getSession();
    if (!session || !["ADMIN", "VENDEDOR"].includes(session.user.perfil)) {
        return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    const { id } = await params;

    try {
        const rifa = await prisma.rifa.findUnique({
            where: { id },
            include: {
                numeros: {
                    orderBy: { numero: "asc" },
                    select: {
                        id: true,
                        numero: true,
                        status: true,
                    },
                },
            },
        });

        if (!rifa) {
            return NextResponse.json({ error: "Rifa não encontrada." }, { status: 404 });
        }

        return NextResponse.json(rifa);
    } catch (error) {
        console.error("[PDV Rifas GET]:", error);
        return NextResponse.json({ error: "Erro ao buscar rifa." }, { status: 500 });
    }
}
