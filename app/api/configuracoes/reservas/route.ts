import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
    try {
        let config = await prisma.configuracao.findUnique({
            where: { chave: "reservas_ativas" }
        });
        
        if (!config) {
            config = await prisma.configuracao.create({
                data: { chave: "reservas_ativas", valor: "true" }
            });
        }
        
        return NextResponse.json({ reservas_ativas: config.valor === "true" });
    } catch (e) {
        console.error("GET reservas config error:", e);
        return NextResponse.json({ error: "Erro ao buscar configuração" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const session = await getSession();
    if (!session || session.user.perfil !== "ADMIN") {
        return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }
    
    try {
        const { ativa } = await req.json();
        
        const config = await prisma.configuracao.upsert({
            where: { chave: "reservas_ativas" },
            update: { valor: ativa ? "true" : "false" },
            create: { chave: "reservas_ativas", valor: ativa ? "true" : "false" }
        });
        
        return NextResponse.json({ reservas_ativas: config.valor === "true" });
    } catch (e) {
        console.error("POST reservas config error:", e);
        return NextResponse.json({ error: "Erro ao salvar configuração" }, { status: 500 });
    }
}
