const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
    await prisma.usuario.updateMany({
        where: { perfil: 'ADMIN' },
        data: { nome: 'Admin' }
    });
    console.log("Admin user name updated to 'Admin'");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
