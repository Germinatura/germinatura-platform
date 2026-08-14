import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testCheckout() {
    try {
        const user = await prisma.usuario.findFirst({ where: { perfil: 'CONSUMER' } });
        const rifa = await prisma.rifa.findFirst({ where: { status: 'ATIVA' } });

        if (!user || !rifa) {
            console.log("No consumer user or active rifa found for test.");
            const anyUser = await prisma.usuario.findFirst();
            const anyRifa = await prisma.rifa.findFirst();
            console.log("DEBUG Info: Any User?", anyUser?.id, "Any Rifa?", anyRifa?.id);
            return;
        }

        console.log(`Testing with User: ${user.id}, Rifa: ${rifa.id}`);
        
        // This is a simulation of the route logic
        const selectedNumbers = [1, 2];
        const valorTotal = rifa.precoPorNumero * selectedNumbers.length;
        
        console.log("Calculating total:", valorTotal);
        
        if (isNaN(valorTotal)) {
            console.error("valorTotal is NaN!");
        }

        // Try to create the pedido
        const pedido = await prisma.pedidoRifa.create({
            data: {
                usuarioId: user.id,
                valorTotal: valorTotal,
                status: "PENDENTE",
            }
        });
        
        console.log("Pedido created successfully:", pedido.id);
        
        // Try to update numbers
        const updateRes = await prisma.numeroRifa.updateMany({
            where: { rifaId: rifa.id, numero: { in: selectedNumbers } },
            data: { 
                status: "RESERVADO",
                usuarioId: user.id,
                pedidoRifaId: pedido.id
            }
        });
        
        console.log("Numbers updated successfully:", updateRes.count);

        // Cleanup
        await prisma.numeroRifa.updateMany({
            where: { pedidoRifaId: pedido.id },
            data: { status: "DISPONIVEL", pedidoRifaId: null, usuarioId: null }
        });
        await prisma.pedidoRifa.delete({ where: { id: pedido.id } });
        
        console.log("Test completed successfully.");

    } catch (err: any) {
        console.error("TEST FAILED:", err?.message || err);
    } finally {
        await prisma.$disconnect();
    }
}

testCheckout();
