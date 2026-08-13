const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
    const email = process.argv[2];
    if (!email) {
        console.error("Uso: node reset-password.js <email>");
        process.exit(1);
    }

    const hashed = await bcrypt.hash("a12", 10);
    const user = await prisma.usuario.update({
        where: { email },
        data: { senha: hashed },
    });

    console.log(`✅ Senha de "${user.nome}" (${user.email}) resetada para: a12`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
