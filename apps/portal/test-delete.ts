import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const venda = await prisma.venda.findFirst({
    include: {
      itens: true
    }
  })
  
  if (!venda) {
    console.log("No venda found to delete")
    return
  }
  
  console.log("Found venda:", venda.id)
  
  try {
    await prisma.$transaction(async (tx: any) => {
      // 1. Delete all items related to the sale
      await tx.itemVenda.deleteMany({
          where: { vendaId: venda.id }
      });

      // 2. Find if there's an associated transaction
      const v = await tx.venda.findUnique({
          where: { id: venda.id },
          select: { transacaoId: true }
      });

      // 3. Delete the sale
      await tx.venda.delete({
          where: { id: venda.id }
      });

      // 4. Delete the transaction if it exists
      if (v?.transacaoId) {
          await tx.transacaoFinanceira.delete({
              where: { id: v.transacaoId }
          });
      }
    });
    console.log("Deleted successfully.")
  } catch (error) {
    console.error("Error deleting:", error)
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
