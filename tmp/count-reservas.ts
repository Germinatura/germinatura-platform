import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    const count = await prisma.reserva.count();
    console.log('Total Reservas:', count);
}
main().finally(() => prisma.$disconnect());
