import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
    const now = new Date();
    const promotionalProducts = await prisma.produto.findMany({
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
        select: {
            id: true,
            nome: true,
            isPromocional: true,
            promocao: {
                select: {
                    id: true,
                    ativo: true,
                    dataInicio: true,
                    dataFim: true
                }
            }
        }
    })

    const normalProducts = await prisma.produto.findMany({
        where: {
            isPromocional: false,
            promocaoId: null,
            ativo: true
        },
        take: 2,
        select: {
            id: true,
            nome: true
        }
    })

    console.log("Promotional/Combo Products:");
    console.log(JSON.stringify(promotionalProducts, null, 2));
    console.log("\nNormal Products:");
    console.log(JSON.stringify(normalProducts, null, 2));
}

main()
    .catch((e: any) => {
        console.error(e?.message || e)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
