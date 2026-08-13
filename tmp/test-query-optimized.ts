import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testFetch() {
    console.time('optimized-query');
    const reservas = await prisma.reserva.findMany({
        select: {
            id: true,
            status: true,
            criadoEm: true,
            usuarioId: true,
            usuario: { select: { nome: true, email: true } },
            itens: {
                select: {
                    id: true,
                    quantidade: true,
                    produtoId: true,
                    produto: {
                        select: {
                            id: true,
                            nome: true,
                            precos: {
                                orderBy: { criadoEm: "desc" },
                                take: 1
                            }
                        }
                    }
                }
            },
        },
        orderBy: { criadoEm: "desc" },
        take: 50,
        skip: 0
    });
    console.timeEnd('optimized-query');
    
    const size = JSON.stringify(reservas).length;
    console.log('Response Size (bytes):', size);
    console.log('Count:', reservas.length);
}

testFetch().finally(() => prisma.$disconnect());
