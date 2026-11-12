import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { db, json } from "../../src/infra/db";
import { type Auth } from "../../src/domain/auth";
import {
  sample,
  createDesign,
  saveDesign,
  initialData,
  readAsset,
  mediaRoot,
  upload,
  authorizedAsset,
} from "../../src/domain/media";
import {
  addCart,
  getCart,
  quote,
  attempt,
  capture,
} from "../../src/domain/checkout";
import {
  claim,
  saveWork,
  publishProof,
  decideProof,
} from "../../src/domain/proofs";
import { refund, settleRefund } from "../../src/domain/refunds";
import {
  release,
  submitFactory,
  factoryEvent,
  createShipment,
  scan,
} from "../../src/domain/fulfillment";
import { metrics } from "../../src/domain/monitor";
const addr = {
  name: "Synthetic Buyer",
  email: "fixture@example.test",
  street: "1 Demo Lane",
  city: "Irvine",
  state: "CA",
  zip: "92618",
  country: "US",
};
const fixture = () =>
  ({
    sessionId: "integration_" + randomUUID(),
    principal: "integration_" + randomUUID(),
    userId: null,
    role: "buyer",
    name: "",
    email: "",
    csrf: "test",
    analytics: false,
    source: "test",
    attribution: {},
  }) as Auth;
let owner: Auth;
const setup = async () => {
  const u = await db.user.findUniqueOrThrow({
    where: { email: "owner@pawline.demo" },
  });
  owner = { ...fixture(), principal: u.id, userId: u.id, role: "owner" };
  await db.setting.upsert({
    where: { key: "workerPaused" },
    create: { key: "workerPaused", value: true },
    update: { value: true },
  });
};
async function bag(quantity = 1, code = "", extra = {}) {
  const a = fixture();
  const v = await db.variant.findUniqueOrThrow({
    where: { id: "mug-porcelain" },
  });
  const pet = await sample(a, "coco", "front");
  const d = await createDesign(a, v.id);
  await saveDesign(a, d.id, d.version, {
    ...initialData,
    frontId: pet.id,
    name: "Coco",
    ...extra,
  });
  await addCart(a, d.id, quantity);
  const c = await getCart(a);
  const q = await quote(a, {
    address: addr,
    method: "standard",
    code,
    cartVersion: c.version,
  });
  return { a, c, q };
}
async function paid(quantity = 1, code = "") {
  const b = await bag(quantity, code);
  const at = await attempt(b.a, b.q.id, randomUUID(), b.c.version);
  const o = await db.order.findUniqueOrThrow({
    where: { ref: at.orderRef! },
    include: { lines: true },
  });
  return { ...b, o, line: o.lines[0] };
}
async function approved(b: Awaited<ReturnType<typeof paid>>) {
  await claim(owner, b.line.id);
  const p = await publishProof(owner, b.line.id, 0);
  await decideProof(b.a, p.id, "approve", "", 1);
  return p;
}
async function settle(r: any) {
  await settleRefund(r.id);
  return db.refund.findUniqueOrThrow({ where: { id: r.id } });
}
async function arm(kind: string) {
  await db.setting.upsert({
    where: { key: "testCrashAfterReceipt" },
    create: { key: "testCrashAfterReceipt", value: { kind } },
    update: { value: { kind } },
  });
}
async function crash(input: any) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fault-consumer.ts"],
    {
      env: { ...process.env, ALLOW_TEST_FAULTS: "1" },
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  child.stdin.end(JSON.stringify(input));
  const result = await new Promise<string | null>((resolve) =>
    child.on("exit", (_, signal) => resolve(signal)),
  );
  assert.equal(result, "SIGKILL");
}
async function waitFor(check: () => Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Timed out waiting for persisted recovery");
}
async function withTwoWorkers(work: () => Promise<void>) {
  await db.setting.update({
    where: { key: "workerPaused" },
    data: { value: false },
  });
  const workers = [1, 2].map((i) =>
    spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      env: { ...process.env, WORKER_ID: "recovery-" + i },
      stdio: "ignore",
    }),
  );
  try {
    await work();
  } finally {
    for (const w of workers) w.kill("SIGTERM");
    await Promise.all(workers.map((w) => new Promise((r) => w.on("exit", r))));
    await db.setting.update({
      where: { key: "workerPaused" },
      data: { value: true },
    });
  }
}
after(async () => {
  await db.setting.updateMany({
    where: { key: "workerPaused" },
    data: { value: false },
  });
  await db.$disconnect();
});

test("A19 distinct keys share one pending intent; payload reuse conflicts", async () => {
  await setup();
  const b = await bag();
  await db.setting.upsert({
    where: { key: "paymentScenario" },
    create: {
      key: "paymentScenario",
      value: { cartId: b.c.id, scenario: "lost_response" },
    },
    update: { value: { cartId: b.c.id, scenario: "lost_response" } },
  });
  const keys = [randomUUID(), randomUUID()];
  const [a, c] = await Promise.all(
    keys.map((k) => attempt(b.a, b.q.id, k, b.c.version)),
  );
  assert.equal(a.id, c.id);
  assert.equal(
    await db.simReceipt.count({
      where: {
        type: "capture",
        reference: (await db.attempt.findUniqueOrThrow({ where: { id: a.id } }))
          .providerRef,
      },
    }),
    1,
  );
  await assert.rejects(attempt(b.a, b.q.id, keys[0], b.c.version + 1));
  await capture(a.id, {}, "test");
  assert.equal(await db.order.count({ where: { attemptId: a.id } }), 1);
  const reservations = await db.reservation.findMany({
    where: { attemptId: a.id },
  });
  assert.equal(reservations[0].state, "allocated");
});
test("A20 capture receipt survives a real process kill and two worker recovery", async () => {
  const b = await bag();
  await arm("capture");
  await crash({
    action: "attempt",
    auth: b.a,
    quoteId: b.q.id,
    key: randomUUID(),
    version: b.c.version,
  });
  const at = await db.attempt.findFirstOrThrow({ where: { cartId: b.c.id } });
  assert.equal(
    await db.simReceipt.count({ where: { reference: at.providerRef } }),
    1,
  );
  assert.equal(at.status, "pending");
  assert.equal(
    (await db.reservation.findFirstOrThrow({ where: { attemptId: at.id } }))
      .state,
    "reserved",
  );
  await withTwoWorkers(async () => {
    await waitFor(
      async () => (await db.order.count({ where: { attemptId: at.id } })) === 1,
    );
  });
  assert.equal(
    await db.simReceipt.count({ where: { reference: at.providerRef } }),
    1,
  );
});
test("A20 refund and factory receipts survive killed consumers without duplicate effects", async () => {
  const b = await paid();
  const r = await refund(owner, b.o.id, {
    lineId: b.line.id,
    quantity: 1,
    reason: "Recovery test",
    key: randomUUID(),
  });
  await arm("refund");
  await crash({ action: "refund", id: r.id });
  assert.equal(
    (await db.orderLine.findUniqueOrThrow({ where: { id: b.line.id } })).held,
    1,
  );
  await withTwoWorkers(async () => {
    await waitFor(
      async () =>
        (await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status ===
        "succeeded",
    );
  });
  assert.equal(await db.simReceipt.count({ where: { reference: r.ref } }), 1);
  const c = await paid();
  const p = await approved(c);
  const run = await release(owner, c.line.id, {
    proofId: p.id,
    quantity: 1,
    reason: "Recovery test",
  });
  await arm("factory");
  await crash({ action: "factory", id: run.id });
  await withTwoWorkers(async () => {
    await waitFor(
      async () =>
        (await db.productionRun.findUniqueOrThrow({ where: { id: run.id } }))
          .state === "accepted",
    );
  });
  assert.equal(
    await db.simReceipt.count({ where: { reference: run.externalRef } }),
    1,
  );
  assert.equal(
    (await db.orderLine.findUniqueOrThrow({ where: { id: c.line.id } })).locked,
    1,
  );
});
test("A21 v2 has changed pixels; corrupt approved master blocks release", async () => {
  const b = await paid();
  await claim(owner, b.line.id);
  const p1 = await publishProof(owner, b.line.id, 0);
  await decideProof(b.a, p1.id, "changes", "Blue background please", 1);
  const revision = await db.revision.findUniqueOrThrow({
    where: { id: b.line.revisionId },
  });
  await saveWork(
    owner,
    b.line.id,
    {
      ...(revision.data as any),
      background: "#0044ff",
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    },
    3,
    1,
  );
  const p2 = await publishProof(owner, b.line.id, 1);
  await assert.rejects(decideProof(b.a, p1.id, "approve", "", 1));
  assert.notEqual(p1.productionSha, p2.productionSha);
  const f = await readAsset(p2.productionId);
  const pixel = await sharp(f.data)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.deepEqual([...pixel].slice(0, 3), [0, 68, 255]);
  await decideProof(b.a, p2.id, "approve", "", 2);
  const loc = path.join(mediaRoot(), f.asset.key);
  await fs.writeFile(loc, Buffer.from("corrupt"));
  await assert.rejects(
    release(owner, b.line.id, {
      proofId: p2.id,
      quantity: 1,
      reason: "Must fail integrity",
    }),
  );
  await fs.writeFile(loc, f.data);
  const run = await release(owner, b.line.id, {
    proofId: p2.id,
    quantity: 1,
    reason: "Verified v2 master",
  });
  await submitFactory(run.id);
  const receipt = await db.simReceipt.findUniqueOrThrow({
    where: { reference: run.externalRef },
  });
  assert.equal((receipt.payload as any).productionSha, p2.productionSha);
});
test("A22 six PAWS10 units refund 2915 × 5 + 2916; full single unit includes delivery", async () => {
  const b = await paid(6, "PAWS10");
  assert.equal(b.o.total, 17491);
  const amounts = [];
  for (let i = 0; i < 6; i++) {
    const r = await refund(owner, b.o.id, {
      lineId: b.line.id,
      quantity: 1,
      reason: "Unit cancellation " + i,
      key: randomUUID(),
    });
    amounts.push((await settle(r)).amount);
  }
  assert.deepEqual(amounts, [2915, 2915, 2915, 2915, 2915, 2916]);
  const c = await paid();
  const r = await refund(owner, c.o.id, {
    lineId: c.line.id,
    quantity: 1,
    reason: "Full cancellation",
    key: randomUUID(),
  });
  assert.equal((await settle(r)).amount, 3838);
});
test("A23 release/cancel compete for original units; completed quantities split into bounded parcels", async () => {
  const b = await paid();
  const p = await approved(b);
  const results = await Promise.allSettled([
    release(owner, b.line.id, {
      proofId: p.id,
      quantity: 1,
      reason: "Race release",
    }),
    refund(owner, b.o.id, {
      lineId: b.line.id,
      quantity: 1,
      reason: "Race cancellation",
      key: randomUUID(),
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const l = await db.orderLine.findUniqueOrThrow({ where: { id: b.line.id } });
  assert.equal(l.locked + l.held, 1);
  const c = await paid(2),
    p2 = await approved(c);
  const run = await release(owner, c.line.id, {
    proofId: p2.id,
    quantity: 2,
    reason: "Split package",
  });
  await assert.rejects(
    createShipment(owner, c.o.id, {
      items: [{ runId: run.id, quantity: 1 }],
      reason: "Too early",
    }),
  );
  await submitFactory(run.id);
  await factoryEvent(owner, run.id, "completed");
  const s1 = await createShipment(owner, c.o.id, {
    items: [{ runId: run.id, quantity: 1 }],
    reason: "First parcel",
  });
  await createShipment(owner, c.o.id, {
    items: [{ runId: run.id, quantity: 1 }],
    reason: "Second parcel",
  });
  await assert.rejects(
    createShipment(owner, c.o.id, {
      items: [{ runId: run.id, quantity: 1 }],
      reason: "Too many",
    }),
  );
  await scan(owner, s1.id, "delivered", randomUUID());
  await scan(owner, s1.id, "shipped", randomUUID());
  assert.equal(
    (await db.shipment.findUniqueOrThrow({ where: { id: s1.id } })).state,
    "delivered",
  );
});
test("A25 image normalization strips EXIF and rejects HEIC and MIME mismatch", async () => {
  const a = fixture();
  const jpg = await sharp({
    create: { width: 20, height: 10, channels: 3, background: "#ff0000" },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 10, height: 10, channels: 3, background: "#0000ff" },
        })
          .png()
          .toBuffer(),
        left: 10,
        top: 0,
      },
    ])
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const asset = await upload(a, jpg, "image/jpeg");
  assert.equal(asset.width, 10);
  assert.equal(asset.height, 20);
  const read = await readAsset(asset.id);
  assert.equal((await sharp(read.data).metadata()).orientation, undefined);
  const top = await sharp(read.data)
      .extract({ left: 5, top: 4, width: 1, height: 1 })
      .raw()
      .toBuffer(),
    bottom = await sharp(read.data)
      .extract({ left: 5, top: 15, width: 1, height: 1 })
      .raw()
      .toBuffer();
  assert.ok(
    top[0] > 230 && top[2] < 25 && bottom[2] > 230 && bottom[0] < 25,
    "EXIF rotation must move the colored corners, not only swap dimensions",
  );
  await assert.rejects(upload(a, jpg, "image/heic"));
  await assert.rejects(upload(a, jpg, "image/png"));
  await assert.rejects(
    upload(a, Buffer.alloc(12 * 1024 * 1024 + 1), "image/png"),
  );
  await assert.rejects(upload(a, Buffer.from("damaged"), "image/png"));
  const oversized = await sharp({
    create: { width: 6000, height: 5000, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  await assert.rejects(upload(a, oversized, "image/png"));
});
test("A26 financial monitor reconciles against independent SQL capture/refund sums", async () => {
  const m = await metrics(owner, new URLSearchParams("source=test"));
  const rows = await db.$queryRaw<
    { gross: bigint; refunds: bigint }[]
  >`SELECT COALESCE(SUM(amount) FILTER(WHERE type='capture' AND state='succeeded'),0) AS gross,COALESCE(SUM(amount) FILTER(WHERE type='refund' AND state='succeeded'),0) AS refunds FROM "SimReceipt"`;
  assert.equal(m.data.finance.gross, Number(rows[0].gross));
  assert.equal(m.data.finance.refunds, Number(rows[0].refunds));
  assert.equal(m.data.finance.net, Number(rows[0].gross - rows[0].refunds));
});

test("A13 SMTP receipt after process kill reconciles by Message-ID without duplicate mail", async () => {
  const b = await paid();
  const notification = await db.notification.findUniqueOrThrow({
    where: { key: "order:" + b.o.id },
  });
  await arm("email");
  await crash({ action: "email", id: notification.id });
  assert.equal(
    (
      await db.notification.findUniqueOrThrow({
        where: { id: notification.id },
      })
    ).state,
    "sending",
  );
  await withTwoWorkers(async () => {
    await waitFor(
      async () =>
        (
          await db.notification.findUniqueOrThrow({
            where: { id: notification.id },
          })
        ).state === "sent",
    );
  });
  const query = "message-id:" + notification.messageId.replace(/[<>]/g, "");
  const response = await fetch(
    process.env.MAILPIT_URL +
      "/api/v1/search?query=" +
      encodeURIComponent(query),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from("operator:" + process.env.MAIL_PASSWORD).toString(
            "base64",
          ),
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages.length, 1);
});

test("A18 price changes invalidate quotes and two buyers cannot consume the last unit twice", async () => {
  const b = await bag();
  const v = await db.variant.findUniqueOrThrow({
    where: { id: "mug-porcelain" },
  });
  const { editCatalog } = await import("../../src/domain/operations");
  const product = await db.product.findUniqueOrThrow({
    where: { id: "mug" },
    include: { variants: true },
  });
  await editCatalog(owner, "mug", {
    ...product,
    reason: "Test quote invalidation",
    variants: product.variants.map((x) => ({ ...x, price: x.price + 1 })),
  });
  await assert.rejects(attempt(b.a, b.q.id, randomUUID(), b.c.version));
  await editCatalog(owner, "mug", {
    ...product,
    reason: "Restore price; constrain final capacity",
    variants: [{ ...v, capacity: v.allocated + v.reserved + 1 }],
  });
  const x = await bag(),
    y = await bag();
  const result = await Promise.allSettled([
    attempt(x.a, x.q.id, randomUUID(), x.c.version),
    attempt(y.a, y.q.id, randomUUID(), y.c.version),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const final = await db.variant.findUniqueOrThrow({ where: { id: v.id } });
  assert.equal(final.capacity - final.allocated - final.reserved, 0);
  await editCatalog(owner, "mug", {
    ...product,
    reason: "Restore capacity after contention",
    variants: [
      { ...final, capacity: Math.max(v.capacity, final.allocated + 10) },
    ],
  });
});

test("A24 scoped, expired and revoked grants cannot approve or expose other resources", async () => {
  const b = await paid();
  const { issueGrant } = await import("../../src/domain/notifications");
  const { grantOrder } = await import("../../src/domain/auth");
  const { hash } = await import("../../src/domain/common");
  const viewer = fixture();
  const raw = await issueGrant(db, "order", b.o.id, b.o.email);
  await grantOrder(viewer, raw);
  await grantOrder(viewer, raw);
  const grant = await db.grant.findUniqueOrThrow({
    where: { tokenHash: hash(raw) },
  });
  assert.equal(grant.usedAt, null);
  await db.grant.update({
    where: { id: grant.id },
    data: { expiresAt: new Date(Date.now() - 1) },
  });
  await assert.rejects(grantOrder(fixture(), raw));
  const revoked = await issueGrant(db, "order", b.o.id, b.o.email);
  await db.grant.update({
    where: { tokenHash: hash(revoked) },
    data: { revokedAt: new Date() },
  });
  await assert.rejects(grantOrder(fixture(), revoked));
  const reset = await issueGrant(db, "reset", b.o.id, b.o.email);
  await assert.rejects(grantOrder(viewer, reset));
});

test("A26 refund transaction day differs from the original order cohort", async () => {
  const env: Record<string, string | undefined> = process.env;
  const originalEnv = env.NODE_ENV,
    oldClock = env.TEST_NOW;
  try {
    env.NODE_ENV = "test";
    process.env.TEST_NOW = "2026-10-30T20:00:00.000Z";
    const b = await paid(1);
    process.env.TEST_NOW = "2026-10-31T20:00:00.000Z";
    const r = await refund(owner, b.o.id, {
      lineId: b.line.id,
      quantity: 1,
      reason: "Next business day refund",
      key: randomUUID(),
    });
    await settleRefund(r.id);
    const transactions = await metrics(
      owner,
      new URLSearchParams("source=test&start=2026-10-31&end=2026-10-31"),
    );
    assert.equal(transactions.data.finance.orders, 0);
    assert.equal(transactions.data.finance.refunds, 3838);
    const cohort = await metrics(
      owner,
      new URLSearchParams(
        "source=test&start=2026-10-30&end=2026-10-30&mode=cohort",
      ),
    );
    assert.equal(cohort.data.finance.orders, 1);
    assert.equal(cohort.data.finance.net, 0);
    const sql = await db.$queryRaw<
      { amount: bigint }[]
    >`SELECT COALESCE(SUM(amount),0) AS amount FROM "SimReceipt" WHERE type='refund' AND state='succeeded' AND "createdAt">='2026-10-31T07:00:00Z'::timestamp AND "createdAt"<'2026-11-01T07:00:00Z'::timestamp`;
    assert.equal(Number(sql[0].amount), transactions.data.finance.refunds);
  } finally {
    if (originalEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalEnv;
    if (oldClock === undefined) delete process.env.TEST_NOW;
    else process.env.TEST_NOW = oldClock;
  }
});

test("A23 partial cancellation and replacement preserve original delivery; goodwill changes money only", async () => {
  const b = await paid(2),
    p = await approved(b);
  const run = await release(owner, b.line.id, {
    proofId: p.id,
    quantity: 1,
    reason: "Deliver first original unit",
  });
  await submitFactory(run.id);
  await factoryEvent(owner, run.id, "completed");
  const s = await createShipment(owner, b.o.id, {
    items: [{ runId: run.id, quantity: 1 }],
    reason: "First original unit",
  });
  await scan(owner, s.id, "delivered", randomUUID());
  const r = await refund(owner, b.o.id, {
    lineId: b.line.id,
    quantity: 1,
    reason: "Cancel remaining unproduced unit",
    key: randomUUID(),
  });
  await settleRefund(r.id);
  assert.equal(
    (await db.orderLine.findUniqueOrThrow({ where: { id: b.line.id } })).state,
    "delivered",
  );
  const replacement = await release(owner, b.line.id, {
    proofId: p.id,
    quantity: 1,
    kind: "replacement",
    parentId: run.id,
    reason: "Damaged item replacement",
  });
  await submitFactory(replacement.id);
  assert.equal(
    (await db.orderLine.findUniqueOrThrow({ where: { id: b.line.id } })).state,
    "delivered",
  );
  const before = await db.variant.findUniqueOrThrow({
    where: { id: b.line.variantId },
  });
  const { goodwillRefund } = await import("../../src/domain/refunds");
  const credit = await goodwillRefund(owner, b.o.id, {
    lineId: b.line.id,
    net: 100,
    tax: 8,
    shipping: 0,
    reason: "Service recovery",
    key: randomUUID(),
  });
  await settleRefund(credit.id);
  assert.equal(
    (await db.variant.findUniqueOrThrow({ where: { id: b.line.variantId } }))
      .allocated,
    before.allocated,
  );
  const after = await db.orderLine.findUniqueOrThrow({
    where: { id: b.line.id },
  });
  assert.equal(after.state, "delivered");
  assert.equal(after.canceled, 1);
  assert.equal(after.locked, 1);
  await assert.rejects(
    goodwillRefund(owner, b.o.id, {
      lineId: b.line.id,
      net: 3000,
      tax: 0,
      shipping: 0,
      reason: "Excess credit",
      key: randomUUID(),
    }),
  );
});

test("A26 mixed SKU order, declined analytics, production cost and zero-order denominator reconcile independently", async () => {
  const a = fixture(),
    pet = await sample(a, "mochi", "front");
  const variants = await db.variant.findMany({
    where: { productId: { in: ["shirt", "balls"] }, active: true },
    include: { product: true },
  });
  const chosen = [
    variants.find((v) => v.productId === "shirt")!,
    variants.find((v) => v.productId === "balls")!,
  ];
  for (const v of chosen) {
    const d = await createDesign(a, v.id);
    await saveDesign(a, d.id, d.version, {
      ...initialData,
      frontId: pet.id,
      name: "Mochi",
    });
    await addCart(a, d.id, 1);
  }
  const c = await getCart(a),
    q = await quote(a, {
      address: addr,
      method: "standard",
      code: "PAWS10",
      cartVersion: c.version,
    }),
    at = await attempt(a, q.id, randomUUID(), c.version);
  assert.equal(at.total, 7774);
  const o = await db.order.findUniqueOrThrow({
    where: { ref: at.orderRef! },
    include: { lines: true },
  });
  const shirt = o.lines.find((l) => l.variantId === chosen[0].id)!,
    balls = o.lines.find((l) => l.variantId === chosen[1].id)!;
  await claim(owner, shirt.id);
  const proof = await publishProof(owner, shirt.id, 0);
  await decideProof(a, proof.id, "approve", "", 1);
  const run = await release(owner, shirt.id, {
    proofId: proof.id,
    quantity: 1,
    reason: "Mixed-SKU cost verification",
  });
  await submitFactory(run.id);
  const r = await refund(owner, o.id, {
    lineId: balls.id,
    quantity: 1,
    reason: "Only cancel golf balls",
    key: randomUUID(),
  });
  await settleRefund(r.id);
  const shirtMetrics = await metrics(
      owner,
      new URLSearchParams("source=test&sku=" + shirt.variantId),
    ),
    ballsMetrics = await metrics(
      owner,
      new URLSearchParams("source=test&sku=" + balls.variantId),
    );
  const sql = await db.$queryRaw<
    { gross: bigint; cost: bigint }[]
  >`SELECT (SELECT SUM(net+tax) FROM "OrderLine" WHERE "variantId"=${shirt.variantId}) AS gross,(SELECT SUM(cost) FROM "ProductionRun" WHERE "lineId"=${shirt.id}) AS cost`;
  assert.equal(shirtMetrics.data.finance.gross, Number(sql[0].gross));
  assert.equal(shirtMetrics.data.finance.productionCost, Number(sql[0].cost));
  assert.equal(ballsMetrics.data.finance.net, 0);
  assert.equal(shirtMetrics.data.traffic.observableSessions, 0);
  const empty = await metrics(
    owner,
    new URLSearchParams("source=test&start=2000-01-01&end=2000-01-01"),
  );
  assert.equal(empty.data.finance.orders, 0);
  assert.equal(empty.data.finance.aov, null);
  assert.equal(empty.data.traffic.conversion, null);
});

test('H01 media IDs in user notes never grant access to another customer file',async()=>{
  await db.variant.update({where:{id:'mug-porcelain'},data:{capacity:{increment:200}}});
  const foreign=await sample(fixture(),'mochi','front');
  const b=await bag(1,'',{note:foreign.id});
  await attempt(b.a,b.q.id,randomUUID(),b.c.version);
  await assert.rejects(authorizedAsset(b.a,foreign.id),(e:any)=>e.code==='NOT_FOUND');
  const d=await createDesign(b.a,'mug-porcelain');
  await assert.rejects(saveDesign(b.a,d.id,d.version,{...initialData,frontId:foreign.id,name:'Stolen'}));
});

test('H02 media and design job deep links remain valid beyond 500 orders and 100 jobs',async()=>{
  const b=await paid();
  const {lines,...base}=b.o;
  const ids=Array.from({length:510},()=>randomUUID());
  const fake=ids.map((id,i)=>({...base,address:json(base.address),snapshot:json(base.snapshot),attribution:json(base.attribution),id,ref:'BOUNDARY-'+id,cartId:'fixture-'+id,attemptId:'fixture-'+id,paidAt:new Date('2020-01-01T00:00:00Z')}));
  await db.order.createMany({data:fake});
  await db.orderLine.createMany({data:ids.map(id=>({...b.line,snapshot:json(b.line.snapshot),unitSlices:json(b.line.unitSlices),workDraft:undefined,id:randomUUID(),orderId:id,deadline:new Date('2020-01-01T00:00:00Z')}))});
  try{
    const target=await paid();
    const revision=await db.revision.findUniqueOrThrow({where:{id:target.line.revisionId}});
    const file=await authorizedAsset(owner,revision.previewId);
    assert.equal(file.asset.id,revision.previewId);
    const {studioJob,studioJobs}=await import('../../src/domain/proofs');
    const job=await studioJob(owner,target.line.id);
    assert.equal(job.id,target.line.id);
    assert.equal(job.net,undefined);
    assert.equal((await studioJobs(owner,'all',1)).length,100);
    await assert.rejects(authorizedAsset(fixture(),revision.previewId));
    await assert.rejects(studioJob(fixture(),target.line.id));
  }finally{
    await db.orderLine.deleteMany({where:{orderId:{in:ids}}});
    await db.order.deleteMany({where:{id:{in:ids}}});
  }
});

test('H03 three waves of 32 concurrent payment submissions retain one charge per cart',async()=>{
  for(let wave=0;wave<3;wave++){
    const b=await bag();
    await db.setting.upsert({where:{key:'paymentScenario'},create:{key:'paymentScenario',value:{cartId:b.c.id,scenario:'lost_response'}},update:{value:{cartId:b.c.id,scenario:'lost_response'}}});
    const results=await Promise.all(Array.from({length:32},()=>attempt(b.a,b.q.id,randomUUID(),b.c.version)));
    assert.equal(new Set(results.map(r=>r.id)).size,1);
    await capture(results[0].id,{},'test');
    const at=await db.attempt.findUniqueOrThrow({where:{id:results[0].id}});
    assert.equal(await db.simReceipt.count({where:{reference:at.providerRef,type:'capture'}}),1);
    assert.equal(await db.order.count({where:{cartId:b.c.id}}),1);
  }
});

test('H04 concurrent refund replay reserves a unit once; repeated settlement cannot over-refund',async()=>{
  const b=await paid(6,'PAWS10');
  const key=randomUUID();
  const replies=await Promise.all(Array.from({length:24},()=>refund(owner,b.o.id,{lineId:b.line.id,quantity:1,reason:'Concurrent identical refund',key})));
  assert.equal(new Set(replies.map(r=>r.id)).size,1);
  await Promise.all(Array.from({length:16},()=>settleRefund(replies[0].id)));
  const row=await db.orderLine.findUniqueOrThrow({where:{id:b.line.id}});
  assert.equal(row.canceled,1);assert.equal(row.held,0);
  assert.equal(await db.simReceipt.count({where:{reference:replies[0].ref,type:'refund'}}),1);
  assert.equal((await db.refund.findUniqueOrThrow({where:{id:replies[0].id}})).amount,2915);
});

test('H16 persisted coupon validity is rechecked before reserving or charging',async()=>{
 const prior=await db.setting.findUniqueOrThrow({where:{key:'rules'}});
 const originalEnv={node:process.env.NODE_ENV,time:process.env.TEST_NOW};
 const {now}=await import('../../src/domain/common');
 const at=now();
 try{
  await db.setting.update({where:{key:'rules'},data:{value:json({...prior.value as object,couponStartsAt:new Date(at.getTime()-60000).toISOString(),couponEndsAt:new Date(at.getTime()+300000).toISOString(),couponMinimum:0,couponProductIds:['mug']})}});
  const b=await bag(1,'PAWS10');
  const before=await db.variant.findUniqueOrThrow({where:{id:'mug-porcelain'}});
  Object.assign(process.env,{NODE_ENV:'test',TEST_NOW:new Date(at.getTime()+360000).toISOString()});
  await assert.rejects(attempt(b.a,b.q.id,randomUUID(),b.c.version),/valid dates/);
  await assert.rejects(quote(b.a,{address:addr,method:'standard',code:'PAWS10',cartVersion:b.c.version}),/valid dates/);
  assert.equal(await db.attempt.count({where:{cartId:b.c.id}}),0);
  assert.equal((await getCart(b.a)).state,"open");
  const after=await db.variant.findUniqueOrThrow({where:{id:'mug-porcelain'}});
  assert.equal(after.reserved,before.reserved);assert.equal(after.allocated,before.allocated);
 }finally{
  await db.setting.update({where:{key:'rules'},data:{value:json(prior.value)}});
  if(originalEnv.node===undefined)Reflect.deleteProperty(process.env,"NODE_ENV");else Object.assign(process.env,{NODE_ENV:originalEnv.node});
  if(originalEnv.time===undefined)delete process.env.TEST_NOW;else process.env.TEST_NOW=originalEnv.time;
 }
});

test('H17 audit filters and full CSV include older rows without exposing private reason text',async()=>{
 const {auditLog,auditCsv}=await import('../../src/domain/audit-log');
 const {dateWindow}=await import('../../src/domain/monitor');
 const prefix='=review.audit.'+randomUUID(),window=dateWindow('2026-11-01','2026-11-01');
 const ids=Array.from({length:216},()=>randomUUID());
 await db.event.createMany({data:ids.map((id,i)=>({id,eventId:'EV-'+id,kind:prefix,actor:i===215?'guest_'+id:owner.principal,objectId:'review-fixture',createdAt:new Date(window.start.getTime()+i*1000),data:{reason:'private@example.test /private/customer.png secret-token',quantity:1}}))});
 try{
  const params=new URLSearchParams({event:prefix,role:'owner',start:'2026-11-01',end:'2026-11-01'});
  const first=await auditLog(owner,params);assert.equal(first.total,215);assert.equal(first.items.length,50);assert.equal(new Date(first.windowEnd).getTime()-new Date(first.windowStart).getTime(),25*3600000);
  params.set('page','4');const last=await auditLog(owner,params);assert.equal(last.items.length,15);
  const csv=await auditCsv(owner,params);assert.equal(csv.split('\r\n').length,216);assert(csv.includes("'="));
  assert(!JSON.stringify(first).includes('private@example'));assert(!csv.includes('secret-token'));assert(!csv.includes('/private/'));
  params.set('role','guest');params.set('page','0');assert.equal((await auditLog(owner,params)).total,1);
  params.set('start','2026-11-02');params.set('end','2026-11-02');assert.equal((await auditLog(owner,params)).total,0);
  params.set('start','2026-11-03');await assert.rejects(auditLog(owner,params),/start date/);
  await assert.rejects(auditLog({...owner,role:'designer'},new URLSearchParams()),/authorized staff/);
 }finally{await db.event.deleteMany({where:{id:{in:ids}}})}
});
