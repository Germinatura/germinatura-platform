import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    console.log('Cleaning up database...');
    await prisma.itemVenda.deleteMany();
    await prisma.venda.deleteMany();
    await prisma.transacaoFinanceira.deleteMany();
    await prisma.usuario.deleteMany();
    await prisma.produto.deleteMany();

    console.log('Seeding users...');

    // Admin user
    const adminHash = await bcrypt.hash('admin', 10);
    await prisma.usuario.create({
        data: {
            nome: 'Admin',
            email: 'admin@admin.com',
            senha: adminHash,
            perfil: 'ADMIN',
        },
    });

    // Vendedor user
    const vendedorHash = await bcrypt.hash('vendedor', 10);
    await prisma.usuario.create({
        data: {
            nome: 'Vendedor',
            email: 'vendedor@vendedor.com',
            senha: vendedorHash,
            perfil: 'VENDEDOR',
        },
    });

    console.log('Seeding products...');
    await prisma.produto.deleteMany();

    const produtos = [
        { nome: 'Cachorro Quente', preco: 12.00 },
        { nome: 'Refrigerante LATA', preco: 6.00 },
        { nome: 'Suco Natural', preco: 8.00 },
        { nome: 'Água Mineral', preco: 4.00 },
        { nome: 'Pipoca Grande', preco: 10.00 },
    ];

    for (const p of produtos) {
        await prisma.produto.create({
            data: {
                nome: p.nome,
                precos: {
                    create: {
                        valor: p.preco
                    }
                }
            }
        });
    }

    console.log('Seeding finished.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
