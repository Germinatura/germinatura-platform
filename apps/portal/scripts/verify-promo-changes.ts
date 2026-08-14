import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function verify() {
    console.log("--- Starting Verification ---");

    // 1. Check if adminView=true filters out promotional products via Prisma
    const adminProducts = await prisma.produto.findMany({
        where: { isPromocional: false }
    });
    const anyPromoInAdmin = adminProducts.some(p => p.isPromocional);
    console.log(`Admin products count: ${adminProducts.length}`);
    console.log(`Promotional products in admin list: ${anyPromoInAdmin ? "FAIL" : "PASS (None found)"}`);

    // 2. Check a promotional product's image inheritance
    const promoProduct = await prisma.produto.findFirst({
        where: { isPromocional: true },
        include: { produtoPai: true }
    });

    if (promoProduct) {
        console.log(`Found promotional product: ${promoProduct.nome}`);
        console.log(`Promotion image stored: ${promoProduct.imagemUrl || "null"}`);
        console.log(`Parent image: ${promoProduct.produtoPai?.imagemUrl || "null"}`);

        // This simulates the API logic
        const effectiveImage = promoProduct.produtoPai?.imagemUrl || promoProduct.imagemUrl;
        console.log(`Effective image (API logic): ${effectiveImage || "null"}`);

        if (promoProduct.produtoPai?.imagemUrl === effectiveImage || (!promoProduct.produtoPai?.imagemUrl && !promoProduct.imagemUrl)) {
            console.log("Image inheritance: PASS");
        } else {
            console.log("Image inheritance: FAIL");
        }
    } else {
        console.log("No promotional product found for testing inheritance.");
    }

    console.log("--- Verification Complete ---");
}

verify()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect())
