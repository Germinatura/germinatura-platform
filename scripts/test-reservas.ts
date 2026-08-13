import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function test() {
    const now = new Date();

    // 1. Find a promotional product (combo or with active discount)
    const promoProduct = await prisma.produto.findFirst({
        where: {
            OR: [
                { isPromocional: true },
                {
                    promocaoId: { not: null },
                    promocao: {
                        ativo: true,
                        dataInicio: { lte: now },
                        dataFim: { gte: now }
                    }
                }
            ]
        }
    });

    // 2. Find a normal product
    const normalProduct = await prisma.produto.findFirst({
        where: {
            isPromocional: false,
            promocaoId: null,
            ativo: true,
            estoque: { gt: 0 }
        }
    });

    console.log("Found Promo Product:", promoProduct?.nome, "(ID:", promoProduct?.id, ")");
    console.log("Found Normal Product:", normalProduct?.nome, "(ID:", normalProduct?.id, ")");

    if (!promoProduct || !normalProduct) {
        console.log("Could not find both types of products for testing.");
        return;
    }

    // Since I cannot easily call the API with session cookies from a script, 
    // I will simulate the logic or use a tool if possible.
    // Actually, I'll just check if the UI filters them out first.
}

test().finally(() => prisma.$disconnect());
