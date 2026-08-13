import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const produto = await prisma.produto.findUnique({
            where: { id },
            include: {
                precos: {
                    orderBy: { criadoEm: "desc" },
                    take: 1
                }
            }
        });

        if (!produto) {
            return NextResponse.json(
                { error: "Produto não encontrado" },
                { status: 404 }
            );
        }

        return NextResponse.json({
            ...produto,
            preco: produto.precos[0]?.valor || 0
        });
    } catch (error) {
        console.error("Erro ao buscar produto:", error);
        return NextResponse.json(
            { error: "Erro ao buscar produto" },
            { status: 500 }
        );
    }
}



import { getSession } from "@/lib/auth";

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
        }

        const { id } = await params;
        const contentType = request.headers.get("content-type") || "";
        let nome: string | null = null;
        let preco: string | null = null;
        let ativo: boolean | null = null;
        let imagemUrl: string | null = null;
        let file: File | null = null;
        let isGroup: boolean | null = null;
        let produtoPaiIdStr: string | null = null;
        let produtoPaiId: string | null | undefined = undefined;

        if (contentType.includes("application/json")) {
            const body = await request.json();
            nome = body.nome ?? null;
            preco = body.preco ?? null;
            ativo = body.ativo ?? null;
            imagemUrl = body.imagemUrl ?? null;
            isGroup = body.isGroup ?? null;
            produtoPaiIdStr = body.produtoPaiId ?? null;
            if (body.produtoPaiId !== undefined) {
                 produtoPaiId = body.produtoPaiId === "" ? null : body.produtoPaiId;
            }
        } else {
            const formData = await request.formData();
            nome = formData.get("nome") as string | null;
            preco = formData.get("preco") as string | null;
            const ativoStr = formData.get("ativo") as string | null;
            ativo = ativoStr !== null ? ativoStr === "true" : null;
            
            const isGroupStr = formData.get("isGroup") as string | null;
            isGroup = isGroupStr !== null ? isGroupStr === "true" : null;
            
            produtoPaiIdStr = formData.get("produtoPaiId") as string | null;
            if (formData.has("produtoPaiId")) {
                produtoPaiId = produtoPaiIdStr === "" ? null : produtoPaiIdStr;
            }

            file = formData.get("imagem") as File | null;
            imagemUrl = formData.get("imagemUrl") as string | null;
        }

        // Buscar o produto para ter os valores atuais
        const currentProduct = await prisma.produto.findUnique({
            where: { id },
            include: {
                precos: {
                    orderBy: { criadoEm: "desc" },
                    take: 1
                }
            }
        });

        if (!currentProduct) {
            return NextResponse.json({ error: "Produto não encontrado" }, { status: 404 });
        }

        if (file && file.size > 0) {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            const base64String = buffer.toString("base64");
            imagemUrl = `data:${file.type};base64,${base64String}`;
        }

        const data: any = {};
        if (nome !== null) data.nome = nome;
        if (ativo !== null) data.ativo = ativo;
        if (imagemUrl !== null) data.imagemUrl = imagemUrl;
        if (isGroup !== null) data.isGroup = isGroup;
        if (produtoPaiId !== undefined) data.produtoPaiId = produtoPaiId;

        // Lógica de preço
        if (preco !== null) {
            const currentPrice = currentProduct.precos[0]?.valor;
            const newPrice = parseFloat(preco);

            if (currentPrice !== newPrice) {
                data.precos = {
                    create: {
                        valor: newPrice
                    }
                };
            }
        }

        const produto = await prisma.produto.update({
            where: { id },
            data,
            include: {
                precos: {
                    orderBy: { criadoEm: "desc" },
                    take: 1
                }
            }
        });

        // Sincroniza o status dos filhos (ativa ou inativa) com o grupo pai
        if (ativo !== null) {
            await prisma.produto.updateMany({
                where: { produtoPaiId: id },
                data: { ativo: ativo }
            });
        }

        return NextResponse.json({
            ...produto,
            preco: produto.precos[0]?.valor || 0
        });
    } catch (error) {
        console.error("Erro ao atualizar produto:", error);
        return NextResponse.json(
            { error: `Erro ao atualizar produto: ${error instanceof Error ? error.message : "Erro desconhecido"}` },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getSession();
        if (!session || session.user.perfil !== "ADMIN") {
            return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
        }

        const { id } = await params;

        // Soft delete ou Hard delete? Vou optar por Hard delete conforme solicitado
        // mas em sistemas reais geralmente usamos soft delete (campo ativo: false)
        await prisma.produto.delete({
            where: { id },
        });

        return NextResponse.json({ message: "Produto excluído com sucesso" });
    } catch (error) {
        console.error("Erro ao excluir produto:", error);
        return NextResponse.json(
            { error: "Erro ao excluir produto" },
            { status: 500 }
        );
    }
}
