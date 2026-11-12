import { PrismaClient, Prisma } from "@prisma/client";
const globalDb = globalThis as unknown as { db?: PrismaClient };
export const db = globalDb.db ?? new PrismaClient({ log: [] });
if (process.env.NODE_ENV !== "production") globalDb.db = db;
export type Tx = Prisma.TransactionClient;
export type Store = typeof db | Tx;
export const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function transaction<T>(fn: (tx: Tx) => Promise<T>) {
  return db.$transaction(fn, { timeout: 20000, maxWait: 10000 });
}
export async function lock(
  tx: Tx,
  table:
    | "Cart"
    | "Variant"
    | "OrderLine"
    | "Order"
    | "Proof"
    | "ProductionRun"
    | "Refund"
    | "Design"
    | "Attempt",
  id: string,
) {
  await tx.$queryRawUnsafe(
    `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
    id,
  );
}
