import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET() {
    try {
        let config: any = null;
        try {
            const results = await prisma.$queryRaw`SELECT * FROM "Configuracao" WHERE "chave" = 'META_ARRECADACAO' LIMIT 1`;
            if (Array.isArray(results) && results.length > 0) {
                config = results[0];
            }
        } catch (e) {
            console.warn("Raw SQL select failed:", e);
        }

        // Se não existir, retorna o valor padrão do env ou 60000
        const valor = config ? parseFloat(config.valor) : parseFloat(process.env.NEXT_PUBLIC_PIX_META_ARRECADACAO || "60000");

        return NextResponse.json({ valor });
    } catch (error) {
        console.error("Erro ao buscar meta:", error);
        return NextResponse.json(
            { error: "Erro ao buscar meta" },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    const session = await getSession();
    if (!session || session.user.perfil !== "ADMIN") {
        return NextResponse.json({ error: "Não autorizado. Apenas administradores podem alterar a meta." }, { status: 401 });
    }

    try {
        const { valor } = await request.json();

        if (typeof valor !== "number") {
            return NextResponse.json(
                { error: "Valor inválido" },
                { status: 400 }
            );
        }

        try {
            const now = new Date();
            // Upsert manual usando SQL
            await prisma.$executeRaw`
                INSERT INTO "Configuracao" ("id", "chave", "valor", "criadoEm", "atualizadoEm")
                VALUES (${Math.random().toString(36).substring(7)}, 'META_ARRECADACAO', ${valor.toString()}, ${now}, ${now})
                ON CONFLICT ("chave")
                DO UPDATE SET "valor" = EXCLUDED."valor", "atualizadoEm" = EXCLUDED."atualizadoEm"
            `;

            return NextResponse.json({ valor });
        } catch (e) {
            console.error("Raw SQL upsert failed:", e);
            throw e;
        }
    } catch (error) {
        console.error("Erro ao atualizar meta (POST /api/configuracoes/meta):", error);
        return NextResponse.json(
            { error: `Erro ao atualizar meta: ${error instanceof Error ? error.message : 'Erro desconhecido'}` },
            { status: 500 }
        );
    }
}
