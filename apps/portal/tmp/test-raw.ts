import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testRaw() {
    console.time('raw-sql');
    // Simplified raw SQL to fetch reservations with their user and items
    // This doesn't catch all the nesting perfectly but shows the speed difference
    const res = await prisma.$queryRaw`
        SELECT 
            r.id, r.status, r."criadoEm",
            u.nome as "usuario_nome", u.email as "usuario_email"
        FROM "Reserva" r
        JOIN "Usuario" u ON r."usuarioId" = u.id
        ORDER BY r."criadoEm" DESC
        LIMIT 50
    `;
    console.timeEnd('raw-sql');
    console.log('Count:', (res as any[]).length);
}

testRaw().finally(() => prisma.$disconnect());
