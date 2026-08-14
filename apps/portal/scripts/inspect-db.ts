import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function inspectDB() {
    try {
        console.log("Inspecting columns of 'PedidoRifa'...");
        const res: any = await prisma.$queryRawUnsafe(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'PedidoRifa'
            ORDER BY column_name;
        `);
        console.log("Columns found in 'PedidoRifa':", res.map((c: any) => c.column_name).join(", "));
        
        const count = await prisma.pedidoRifa.count();
        console.log("Current row count in PedidoRifa:", count);
    } catch (err: any) {
        console.error("INSPECTION FAILED:", err?.message || err);
    } finally {
        await prisma.$disconnect();
    }
}

inspectDB();
