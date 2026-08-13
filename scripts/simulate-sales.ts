import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    // 1. Ensure at least one product exists
    let produto = await prisma.produto.findFirst();
    if (!produto) {
        console.log("Creating dummy product...");
        produto = await prisma.produto.create({
            data: {
                nome: "Produto de Teste",
                estoque: 1000,
                precos: {
                    create: {
                        valor: 10.0
                    }
                }
            }
        });
    }

    console.log(`Starting simulation of 150 sales using product: ${produto.nome} (${produto.id})`);

    // 2. Create 150 sales
    for (let i = 1; i <= 150; i++) {
        await prisma.$transaction(async (tx) => {
            const total = 10.0;
            const transacao = await tx.transacaoFinanceira.create({
                data: {
                    tipo: "ENTRADA",
                    categoria: "Venda PDV (Simulada)",
                    descricao: `Simulação de Venda #${i}`,
                    valor: total,
                    data: new Date(),
                },
            });

            await tx.venda.create({
                data: {
                    total: total,
                    transacaoId: transacao.id,
                    itens: {
                        create: {
                            produtoId: produto!.id,
                            quantidade: 1,
                            precoUnitario: 10.0,
                        },
                    },
                },
            });
        });

        if (i % 50 === 0) {
            console.log(`Created ${i} sales...`);
        }
    }

    console.log("Simulation completed successfully!");
}

main()
    .catch((e: any) => {
        console.error(e?.message || e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
