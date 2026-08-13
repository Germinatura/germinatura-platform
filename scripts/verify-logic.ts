import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function verifyLogic() {
    const now = new Date();

    // 1. Get a promo product
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

    if (promoProduct) {
        console.log(`Checking ${promoProduct.nome}...`);
        if (promoProduct.isPromocional) {
            console.log("RESULT: BLOCKED (isPromocional)");
        } else if (promoProduct.promocaoId) {
            const promo = await prisma.promocao.findUnique({ where: { id: promoProduct.promocaoId } });
            if (promo && promo.ativo && now >= promo.dataInicio && now <= promo.dataFim) {
                console.log("RESULT: BLOCKED (Active Promotion)");
            }
        }
    }

    // 2. Get a normal product
    const normalProduct = await prisma.produto.findFirst({
        where: {
            isPromocional: false,
            promocaoId: null,
            ativo: true
        },
        select: { id: true, nome: true }
    });

    if (normalProduct) {
        console.log(`Checking ${normalProduct.nome}...`);
        console.log("RESULT: ALLOWED");
    }
}

verifyLogic().finally(() => prisma.$disconnect());
