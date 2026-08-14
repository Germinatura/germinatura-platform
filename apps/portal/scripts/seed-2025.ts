import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Inserindo vendas de teste para o início de 2025...");

  const adminUser = await prisma.usuario.findFirst({ where: { perfil: 'ADMIN' } });
  
  if (!adminUser) {
    console.error("Nenhum usuário ADMIN encontrado. Certifique-se de que o banco tem usuários de teste.");
    return;
  }

  const baseDate = new Date("2025-01-05T10:00:00Z");
  
  for (let i = 0; i < 50; i++) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + Math.floor(Math.random() * 3) + i);
    const isEntrada = Math.random() > 0.2;
    const valor = Math.floor(Math.random() * 500) + 50;

    await prisma.transacaoFinanceira.create({
      data: {
        tipo: isEntrada ? "ENTRADA" : "SAIDA",
        categoria: isEntrada ? "Venda" : "Despesa",
        descricao: isEntrada ? `Venda de Teste #${i}` : `Despesa de Teste #${i}`,
        valor: valor,
        data: date,
        usuarioId: adminUser.id,
      }
    });
  }

  console.log("Vendas de 2025 inseridas com sucesso.");
}

main()
  .catch((e: any) => console.error(e?.message || e))
  .finally(() => prisma.$disconnect());
