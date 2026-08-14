import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { legacyPrisma?: PrismaClient };

export const legacyDb = globalForPrisma.legacyPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.legacyPrisma = legacyDb;

export default legacyDb;
