import { NextResponse } from "next/server";
import { montarPayloadPix } from "@/lib/pix";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { valor, chave, nome, cidade } = body;

        if (!valor || !chave) {
            return NextResponse.json(
                { error: "Valor e chave são obrigatórios" },
                { status: 400 }
            );
        }

        const payload = montarPayloadPix({
            valor,
            chave: chave || process.env.NEXT_PUBLIC_PIX_CHAVE || "",
            nome: nome || process.env.NEXT_PUBLIC_PIX_NOME_RECEBEDOR || "Plataforma Web",
            cidade: cidade || process.env.NEXT_PUBLIC_PIX_CIDADE || "SAO PAULO"
        });

        return NextResponse.json({ payload });
    } catch (error) {
        console.error("Erro ao gerar payload PIX:", error);
        return NextResponse.json(
            { error: "Erro ao gerar payload PIX" },
            { status: 500 }
        );
    }
}
