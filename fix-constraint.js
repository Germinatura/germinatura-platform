const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        await prisma.$executeRawUnsafe(`ALTER TABLE "Produto" DROP CONSTRAINT IF EXISTS check_estoque_positivo;`);
        console.log("Constraint dropped.");
        await prisma.$executeRawUnsafe(`ALTER TABLE "Produto" ADD CONSTRAINT check_estoque_positivo CHECK (estoque >= 0);`);
        console.log("Constraint recreated with >= 0.");
    } catch (error) {
        console.error("Error updating constraint:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
