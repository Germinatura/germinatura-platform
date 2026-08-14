import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";


async function checkAdmin() {
    const session = await getSession();
    return session?.user?.perfil === "ADMIN";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await checkAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    const id = (await params).id;
    try {
        const rifa = await prisma.rifa.findUnique({
            where: { id },
            include: { 
                numeros: { 
                    orderBy: { numero: 'asc' },
                    select: {
                        id: true,
                        numero: true,
                        status: true,
                        usuario: { select: { id: true, nome: true, email: true } }
                    }
                } 
            }
        });
        if (!rifa) return NextResponse.json({ error: "Rifa não encontrada" }, { status: 404 });
        return NextResponse.json(rifa);
    } catch (error) {
        console.error("GET RIFA ID:", error);
        return NextResponse.json({ error: "Erro ao buscar rifa" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await checkAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    const id = (await params).id;
    try {
        const contentType = req.headers.get("content-type") || "";
        let titulo: string | null = null;
        let descricao: string | null = null;
        let imagemUrl: string | null = null;
        let status: string | null = null;
        let dataSorteio: string | null = null;
        let precoPorNumero: number | null = null;
        let file: File | null = null;

        if (contentType.includes("application/json")) {
            const body = await req.json();
            titulo = body.titulo;
            descricao = body.descricao;
            imagemUrl = body.imagemUrl;
            status = body.status;
            dataSorteio = body.dataSorteio;
            precoPorNumero = body.precoPorNumero;
        } else {
            const formData = await req.formData();
            titulo = formData.get("titulo") as string;
            descricao = formData.get("descricao") as string;
            imagemUrl = formData.get("imagemUrl") as string;
            status = formData.get("status") as string;
            dataSorteio = formData.get("dataSorteio") as string;
            precoPorNumero = Number(formData.get("precoPorNumero"));
            file = formData.get("imagem") as File | null;
        }

        if (file && file.size > 0) {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            const base64String = buffer.toString("base64");
            imagemUrl = `data:${file.type};base64,${base64String}`;
        }

        const data: any = {};
        if (titulo !== null) data.titulo = titulo;
        if (descricao !== null) data.descricao = descricao;
        if (imagemUrl !== null) data.imagemUrl = imagemUrl;
        if (status !== null) data.status = status;
        if (precoPorNumero !== null && !isNaN(precoPorNumero)) data.precoPorNumero = precoPorNumero;
        if (dataSorteio !== null) data.dataSorteio = dataSorteio ? new Date(dataSorteio) : null;
        
        const rifa = await prisma.rifa.update({
            where: { id },
            data
        });
        return NextResponse.json(rifa);
    } catch (error) {
        console.error("PUT RIFA ID:", error);
        return NextResponse.json({ error: "Erro ao atualizar rifa" }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await checkAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    const id = (await params).id;
    try {
        await prisma.rifa.delete({ where: { id } });
        return NextResponse.json({ message: "Rifa excluída" });
    } catch (error) {
        console.error("DELETE RIFA ID:", error);
        return NextResponse.json({ error: "Erro ao excluir rifa" }, { status: 500 });
    }
}
