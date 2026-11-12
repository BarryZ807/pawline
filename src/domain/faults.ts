import { db } from "../infra/db";
/** Test-only crash point: the external receipt is already committed. No browser can arm it. */
export async function afterReceipt(kind: string, reference: string) {
  if (process.env.ALLOW_TEST_FAULTS !== "1") return;
  const armed = await db.setting.findUnique({
    where: { key: "testCrashAfterReceipt" },
  });
  if (!armed || (armed.value as any).kind !== kind) return;
  const consumed = await db.setting.deleteMany({
    where: { key: armed.key, value: { equals: armed.value! } },
  });
  if (consumed.count) {
    await db.event.create({
      data: {
        eventId: "crash:" + reference,
        actor: "test-harness",
        kind: "test.process_crash",
        source: "test",
        data: { kind, reference },
      },
    });
    process.kill(process.pid, "SIGKILL");
  }
}
