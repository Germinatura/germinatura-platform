import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    console.log('Count Results:');
    console.log('Produtos:', await prisma.produto.count());
    console.log('Precos:', await prisma.precoProduto.count());
    console.log('Itens Reserva:', await prisma.itemReserva.count());
    console.log('Reservas:', await prisma.reserva.count());
}
main().finally(() => prisma.$disconnect());
