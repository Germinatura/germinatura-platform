import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const vendaCount = await prisma.venda.count();
    const transacaoCount = await prisma.transacaoFinanceira.count();

    console.log(`Total Sales in DB: ${vendaCount}`);
    console.log(`Total Transactions in DB: ${transacaoCount}`);

    const salesResponse = await fetch("http://localhost:3000/api/vendas");
    if (salesResponse.ok) {
        const sales = await salesResponse.json();
        console.log(`Sales API returned: ${sales.length} records (expected <= 50)`);
    } else {
        console.log("Failed to fetch Sales API (might need server running)");
    }

    const transResponse = await fetch("http://localhost:3000/api/transacoes");
    if (transResponse.ok) {
        const trans = await transResponse.json();
        console.log(`Transactions API returned: ${trans.length} records (expected <= 50)`);
    } else {
        console.log("Failed to fetch Transactions API (might need server running)");
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
