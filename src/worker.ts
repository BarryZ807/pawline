import { cleanOrphanFiles } from "./domain/media-cleanup";
import { randomUUID } from "node:crypto";
import { deliver } from "./domain/mail";
import { db } from "./infra/db";
import { capture } from "./domain/checkout";
import { setting } from "./domain/common";
import { submitFactory } from "./domain/fulfillment";
import { settleRefund } from "./domain/refunds";
const workerId = process.env.WORKER_ID || "worker";
let stopped = false;
async function runJob(job: any) {
  const p = job.payload as any;
  if (job.kind === "capture") {
    await capture(p.attemptId, p.attribution, p.source);
    const at = await db.attempt.findUniqueOrThrow({
      where: { id: p.attemptId },
    });
    if (["pending", "unknown"].includes(at.status))
      throw Error("PaymentResponseUnknown");
  } else if (job.kind === "factory") await submitFactory(p.runId);
  else if (job.kind === "refund") await settleRefund(p.refundId);
  else if (job.kind === "email") await deliver(p.notificationId);
  else throw Error("Unsupported job type");
}
async function tick() {
  if (
    (await setting("workerPaused", false)) ||
    (await setting("maintenance", false))
  )
    return;
  const leaseId = randomUUID();
  const jobs = await db.$queryRaw<
    any[]
  >`WITH candidate AS (SELECT id FROM "Job" WHERE ((state IN ('pending','retry') AND "nextRunAt" <= NOW()) OR (state='running' AND "leaseUntil" < NOW())) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "Job" SET state='running',"leaseId"=${leaseId},"leaseUntil"=NOW()+interval '30 seconds', attempts=attempts+1 FROM candidate WHERE "Job".id=candidate.id RETURNING "Job".*`;
  const job = jobs[0];
  if (!job) return;
  try {
    await runJob(job);
    await db.job.updateMany({
      where: { id: job.id, leaseId },
      data: { state: "done", leaseUntil: null, error: null },
    });
  } catch (e) {
    await db.job.updateMany({
      where: { id: job.id, leaseId },
      data: {
        state: job.attempts >= 8 ? "dead" : "retry",
        nextRunAt: new Date(
          Date.now() + Math.min(60000, 2 ** job.attempts * 1000),
        ),
        leaseUntil: null,
        error: e instanceof Error ? e.name : "JobError",
      },
    });
  }
}
async function heartbeat() {
  const paused = await setting("workerPaused", false);
  await db.heartbeat.upsert({
    where: { id: workerId },
    create: {
      id: workerId,
      state: paused ? "paused" : "running",
      at: new Date(),
    },
    update: { state: paused ? "paused" : "running", at: new Date() },
  });
}
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
console.log("Pawline worker started");
let lastBeat = 0,
  lastCleanup = 0;
while (!stopped) {
  try {
    if (Date.now() - lastBeat > 5000) {
      await heartbeat();
      lastBeat = Date.now();
    }
    await tick();
    if (
      Date.now() - lastCleanup > 3600000 &&
      !(await setting("maintenance", false))
    ) {
      await cleanOrphanFiles();
      lastCleanup = Date.now();
    }
  } catch {
    console.error("worker dependency unavailable");
  }
  await new Promise((r) => setTimeout(r, 500));
}
await db.$disconnect();
console.log("Pawline worker stopped");
