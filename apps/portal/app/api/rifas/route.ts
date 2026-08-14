import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";


async function checkAdmin() {
    const session = await getSession();
    return session?.user?.perfil === "ADMIN";
}

export async function GET() {
    if (!(await checkAdmin())) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    try {
        const rifas = await prisma.rifa.findMany({ 
            orderBy: { criadoEm: 'desc' },
            include: {
                _count: {
                    select: { numeros: true }
                }
            }
        });
        return NextResponse.json(rifas);
    } catch (error) {
        console.error("GET RIFAS:", error);
        return NextResponse.json({ error: "Erro ao buscar rifas" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    if (!(await checkAdmin())) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    try {
        const formData = await req.formData();
        const titulo = formData.get("titulo") as string;
        const descricao = formData.get("descricao") as string;
        const precoPorNumero = Number(formData.get("precoPorNumero"));
        const quantidadeNumeros = Number(formData.get("quantidadeNumeros"));
        const status = (formData.get("status") as string) || 'RASCUNHO';
        const dataSorteio = formData.get("dataSorteio") as string;
        const file = formData.get("imagem") as File | null;

        let imagemUrl = formData.get("imagemUrl") as string | null;

        if (file && file.size > 0) {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            const base64String = buffer.toString("base64");
            imagemUrl = `data:${file.type};base64,${base64String}`;
        }

        if (quantidadeNumeros <= 0) {
            return NextResponse.json({ error: "Quantidade inválida" }, { status: 400 });
        }

        const novaRifa = await prisma.rifa.create({
            data: {
                titulo,
                descricao,
                imagemUrl: imagemUrl || null,
                precoPorNumero,
                quantidadeNumeros,
                status: status as any,
                dataSorteio: dataSorteio ? new Date(dataSorteio) : null,
            }
        });
        
        // Crie os números para a rifa nova
        const numeros = Array.from({ length: quantidadeNumeros }, (_, i) => ({
            rifaId: novaRifa.id,
            numero: i + 1,
            status: 'DISPONIVEL' as const
        }));
        
        await prisma.numeroRifa.createMany({ data: numeros });

        return NextResponse.json(novaRifa, { status: 201 });
    } catch (error) {
        console.error("POST RIFAS:", error);
        return NextResponse.json({ error: "Erro ao criar rifa" }, { status: 500 });
    }
}
