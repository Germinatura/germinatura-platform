import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function test() {
    const now = new Date();

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
        },
        select: { id: true, nome: true, isPromocional: true, promocaoId: true }
    });

    const normalProduct = await prisma.produto.findFirst({
        where: {
            isPromocional: false,
            promocaoId: null,
            ativo: true,
            estoque: { gt: 0 }
        },
        select: { id: true, nome: true }
    });

    console.log("PROMO_ID=" + promoProduct?.id);
    console.log("PROMO_NAME=" + promoProduct?.nome);
    console.log("NORMAL_ID=" + normalProduct?.id);
    console.log("NORMAL_NAME=" + normalProduct?.nome);
}

test().finally(() => prisma.$disconnect());
