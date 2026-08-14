import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testFetch() {
    console.time('query');
    const reservas = await prisma.reserva.findMany({
        include: {
            usuario: { select: { nome: true, email: true } },
            itens: {
                include: {
                    produto: {
                        include: {
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
    });
    console.timeEnd('query');
    
    const size = JSON.stringify(reservas).length;
    console.log('Response Size (bytes):', size);
    console.log('Count:', reservas.length);
    
    // Check for deep nesting objects
    console.log('Sample Item:', JSON.stringify(reservas[0]?.itens[0]?.produto?.nome));
}

testFetch().finally(() => prisma.$disconnect());
