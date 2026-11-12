import { randomUUID } from "node:crypto";
import { db } from "./db";
import { now } from "../domain/common";
/** Independent simulator commit. PostgreSQL arbitrates concurrent external references. */
export async function recordReceipt(input: {
  where?: unknown;
  create: {
    reference: string;
    type: string;
    amount?: number;
    state: string;
    payload: unknown;
  };
  update?: unknown;
}) {
  const r = input.create;
  await db.$executeRaw`INSERT INTO "SimReceipt" (id,reference,type,amount,state,payload,"createdAt") VALUES (${randomUUID()},${r.reference},${r.type},${r.amount || 0},${r.state},${JSON.stringify(r.payload)}::jsonb,${now()}) ON CONFLICT(reference) DO NOTHING`;
  return db.simReceipt.findUniqueOrThrow({ where: { reference: r.reference } });
}
