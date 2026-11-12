import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { db } from "../src/infra/db";
let files = 0,
  runs = 0;
const assets = await db.asset.findMany({ where: { state: "ready" } });
for (const a of assets) {
  const bytes = await fs.readFile(
    path.join(process.env.MEDIA_DIR || "/media", a.key),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== a.sha)
    throw Error("Restored asset checksum mismatch: " + a.id);
  files++;
}
for (const run of await db.productionRun.findMany()) {
  const receipt = await db.simReceipt.findUnique({
    where: { reference: run.externalRef },
  });
  if (
    ["accepted", "in_production", "completed"].includes(run.state) &&
    (!receipt || (receipt.payload as any).manifestHash !== run.manifestHash)
  )
    throw Error("Factory reconciliation failed: " + run.id);
  runs++;
}
for (const o of await db.order.findMany()) {
  const at = await db.attempt.findUniqueOrThrow({ where: { id: o.attemptId } });
  const r = await db.simReceipt.findUnique({
    where: { reference: at.providerRef },
  });
  if (r?.amount !== o.total || r?.state !== "succeeded")
    throw Error("Capture mismatch: " + o.ref);
}
console.log(
  JSON.stringify(
    {
      status: "PASS",
      assetsVerified: files,
      productionReferencesVerified: runs,
      orders: await db.order.count(),
      captures: await db.simReceipt.count({
        where: { type: "capture", state: "succeeded" },
      }),
      refunds: await db.refund.count({ where: { status: "succeeded" } }),
      productionEffects: await db.simReceipt.count({
        where: { type: "factory" },
      }),
    },
    null,
    2,
  ),
);
await db.$disconnect();
