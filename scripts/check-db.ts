import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("--- PRODUTOS (RAW SQL) ---");
    const rawProds: any[] = await prisma.$queryRawUnsafe(`SELECT id, nome, "isPromocional", "produtoPaiId", "promocaoId", estoque FROM "Produto"`);
    console.log(JSON.stringify(rawProds, null, 2));

    console.log("\n--- PROMOÇÕES (RAW SQL) ---");
    const rawPromos: any[] = await prisma.$queryRawUnsafe(`SELECT * FROM "Promocao"`);
    console.log(JSON.stringify(rawPromos, null, 2));
}

main()
    .catch((e: any) => console.error(e?.message || e))
    .finally(async () => await prisma.$disconnect());
