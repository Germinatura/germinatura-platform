import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth";


export async function GET() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get("session")?.value;
        if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const session = await decrypt(token);
        const perfil = session?.user?.perfil;
        if (perfil !== "CONSUMER" && perfil !== "VENDEDOR" && perfil !== "ADMIN") {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userId = session.user.id;

        const numeros = await prisma.numeroRifa.findMany({
            where: { usuarioId: userId },
            include: {
                pedidoRifa: true,
                rifa: {
                    select: {
                        id: true,
                        titulo: true,
                        imagemUrl: true,
                        status: true,
                        dataSorteio: true,
                        numeroSorteado: true
                    }
                }
            },
            orderBy: { criadoEm: 'desc' }
        });

        return NextResponse.json(numeros);
    } catch (error) {
        console.error("GET CONSUMER MINHAS RIFAS:", error);
        return NextResponse.json({ error: "Erro ao buscar números do usuário" }, { status: 500 });
    }
}
