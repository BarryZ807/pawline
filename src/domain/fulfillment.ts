import { refreshLineState } from "./line-state";
import { recordReceipt } from "../infra/receipts";
import { afterReceipt } from "./faults";
import { contentHash } from "./common";
import { db, json, transaction, lock } from "../infra/db";
import { type Auth, role, orderAuth } from "./auth";
import { assert, audit, ref, hash, enqueue, now } from "./common";
import { readAsset } from "./media";
import { orderNotice } from "./notifications";
import { allocate } from "./money";
export async function release(
  a: Auth,
  lineId: string,
  body: {
    quantity: number;
    proofId: string;
    reason: string;
    kind?: string;
    parentId?: string;
    scenario?: string;
  },
) {
  role(a, "owner");
  assert(
    body.reason?.trim(),
    "REASON",
    "Record a reason for this production release.",
  );
  assert(
    Number.isInteger(body.quantity) && body.quantity > 0,
    "QUANTITY",
    "Enter a positive whole quantity.",
  );
  const p = await db.proof.findUniqueOrThrow({ where: { id: body.proofId } });
  const files = await Promise.all([
    readAsset(p.productionId),
    readAsset(p.previewId),
  ]);
  assert(
    files[0].asset.sha === p.productionSha &&
      files[1].asset.sha === p.previewSha &&
      contentHash(p.manifest) === p.manifestHash,
    "INTEGRITY",
    "The approved assets do not match. Production is blocked.",
    409,
  );
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", lineId);
    const line = await tx.orderLine.findUniqueOrThrow({
      where: { id: lineId },
      include: {
        proofs: { orderBy: { version: "desc" }, take: 1 },
        runs: true,
      },
    });
    const current = line.proofs[0];
    assert(
      current?.id === p.id &&
        p.lineId === lineId &&
        current.state === "approved",
      "APPROVAL_REQUIRED",
      "Approve the current proof before releasing production.",
      409,
    );
    const replacement = body.kind === "replacement";
    const originalUnits = line.runs
      .filter((r) => r.kind === "original")
      .flatMap((r) => r.units as number[]);
    const allocations = await tx.refundAllocation.findMany({
      where: { lineId },
      include: { refund: true },
    });
    const refundedUnits = allocations
      .filter((r) => r.refund.status !== "failed")
      .flatMap((r) => r.units as number[]);
    const available = Array.from(
      { length: line.quantity },
      (_, i) => i + 1,
    ).filter((i) => !originalUnits.includes(i) && !refundedUnits.includes(i));
    assert(
      !line.held,
      "REFUND_PENDING",
      "Wait for the pending refund to be reconciled.",
      409,
    );
    if (!replacement)
      assert(
        body.quantity <= available.length,
        "NO_UNITS",
        "This quantity is already released or canceled.",
        409,
      );
    else {
      assert(
        body.parentId &&
          line.runs.some(
            (r) => r.id === body.parentId && r.state === "completed",
          ),
        "PARENT_REQUIRED",
        "Select the original production batch for a replacement.",
      );
      await lock(tx, "Variant", line.variantId);
      const v = await tx.variant.findUniqueOrThrow({
        where: { id: line.variantId },
      });
      assert(
        v.capacity - v.allocated - v.reserved >= body.quantity,
        "CAPACITY",
        "No replacement capacity is available.",
        409,
      );
      await tx.variant.update({
        where: { id: v.id },
        data: { allocated: { increment: body.quantity } },
      });
    }
    const releaseNo = line.runs.length + 1;
    const run = await tx.productionRun.create({
      data: {
        lineId,
        releaseNo,
        proofId: p.id,
        manifestHash: p.manifestHash,
        externalRef: ref("FACTORY"),
        kind: replacement ? "replacement" : "original",
        parentId: body.parentId || null,
        reason: body.reason.trim(),
        quantity: body.quantity,
        units: json(replacement ? [] : available.slice(0, body.quantity)),
        cost: (line.snapshot as any).variant.cost * body.quantity,
        scenario: body.scenario || "success",
      },
    });
    if (!replacement)
      await tx.orderLine.update({
        where: { id: lineId },
        data: { locked: { increment: body.quantity }, state: "submitting" },
      });
    await enqueue(tx, `factory:${run.id}`, "factory", { runId: run.id });
    await audit(tx, a.principal, "production.released", lineId, {
      runId: run.id,
      quantity: body.quantity,
      reason: body.reason,
      manifestHash: p.manifestHash,
    });
    return run;
  });
}
export async function submitFactory(runId: string) {
  const run = await db.productionRun.findUniqueOrThrow({
    where: { id: runId },
    include: { line: true },
  });
  if (!["submitting", "unknown"].includes(run.state)) return run;
  const p = await db.proof.findUniqueOrThrow({ where: { id: run.proofId } });
  const f = await readAsset(p.productionId);
  assert(
    f.asset.sha === p.productionSha && run.manifestHash === p.manifestHash,
    "INTEGRITY",
    "Production file verification failed.",
    409,
  );
  const receipt = await recordReceipt({
    where: { reference: run.externalRef },
    create: {
      reference: run.externalRef,
      type: "factory",
      state: "accepted",
      payload: json({
        runId: run.id,
        quantity: run.quantity,
        manifestHash: run.manifestHash,
        productionSha: p.productionSha,
      }),
    },
    update: {},
  });
  await afterReceipt("factory", run.externalRef);
  assert(
    (receipt.payload as any).manifestHash === run.manifestHash,
    "MANIFEST_MISMATCH",
    "Factory manifest requires reconciliation.",
    409,
  );
  if (run.scenario === "lost_response" && run.state === "submitting") {
    await db.productionRun.update({
      where: { id: run.id },
      data: { state: "unknown" },
    });
    throw new Error("FactoryResponseUnknown");
  }
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", run.lineId);
    const current = await tx.productionRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    if (!["submitting", "unknown"].includes(current.state)) return current;
    await tx.orderLine.update({
      where: { id: run.lineId },
      data: { state: "in_production" },
    });
    await audit(tx, "worker", "factory.accepted", run.id, {
      externalRef: run.externalRef,
      manifestHash: run.manifestHash,
    });
    const updated = await tx.productionRun.update({
      where: { id: run.id },
      data: { state: "accepted", acceptedAt: receipt.createdAt },
    });
    await refreshLineState(tx, run.lineId);
    return updated;
  });
}
export async function factoryEvent(a: Auth, id: string, event: string) {
  role(a, "owner");
  assert(
    ["in_production", "completed"].includes(event),
    "FACTORY_EVENT",
    "Choose a valid factory event.",
  );
  return transaction(async (tx) => {
    const run = await tx.productionRun.findUniqueOrThrow({ where: { id } });
    await lock(tx, "OrderLine", run.lineId);
    const current = await tx.productionRun.findUniqueOrThrow({ where: { id } });
    if (current.state === event || current.state === "completed")
      return current;
    assert(
      ["accepted", "in_production"].includes(current.state),
      "FACTORY_STATE",
      "Wait for a confirmed factory receipt.",
      409,
    );
    await tx.simReceipt.update({
      where: { reference: current.externalRef },
      data: { state: event },
    });
    await audit(tx, a.principal, "factory." + event, id);
    const updated = await tx.productionRun.update({
      where: { id },
      data: { state: event },
    });
    await refreshLineState(tx, current.lineId);
    return updated;
  });
}
export async function createShipment(
  a: Auth,
  orderId: string,
  body: { items: { runId: string; quantity: number }[]; reason: string },
) {
  role(a, "owner");
  assert(
    body.reason?.trim() && body.items?.length,
    "SHIPMENT",
    "Select completed items and record a reason.",
  );
  return transaction(async (tx) => {
    await lock(tx, "Order", orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    const runs = await tx.productionRun.findMany({
      where: { id: { in: body.items.map((x) => x.runId) } },
      include: { line: true },
    });
    assert(
      runs.length === body.items.length,
      "SHIPMENT",
      "Select each production batch once.",
    );
    for (const item of [...body.items].sort((a, b) =>
      a.runId.localeCompare(b.runId),
    )) {
      const run = runs.find((r) => r.id === item.runId)!;
      await lock(tx, "ProductionRun", run.id);
      assert(
        run.line.orderId === orderId && run.state === "completed",
        "NOT_COMPLETED",
        "Only completed production can be packed.",
        409,
      );
      const sum = await tx.shipmentItem.aggregate({
        where: { runId: run.id },
        _sum: { quantity: true },
      });
      assert(
        Number.isInteger(item.quantity) &&
          item.quantity > 0 &&
          item.quantity + (sum._sum.quantity || 0) <= run.quantity,
        "PACKED_QUANTITY",
        "This quantity is already packed or exceeds completed units.",
        409,
      );
    }
    const method = (order.snapshot as any).method;
    const sortedItems = [...body.items].sort((a, b) =>
      a.runId.localeCompare(b.runId),
    );
    const shippingCost = method === "express" ? 1199 : 599;
    const costAllocations = allocate(
      shippingCost,
      sortedItems.map((i) => i.quantity),
    );
    const shipment = await tx.shipment.create({
      data: {
        ref: ref("SHIP"),
        orderId,
        method,
        cost: shippingCost,
        address: json(order.address),
        events: json([
          {
            eventId: ref("SCAN"),
            state: "label_created",
            at: now().toISOString(),
          },
        ]),
        items: {
          create: sortedItems.map((i, index) => ({
            runId: i.runId,
            lineId: runs.find((r) => r.id === i.runId)!.lineId,
            quantity: i.quantity,
            costAllocation: costAllocations[index],
          })),
        },
      },
    });
    await audit(tx, a.principal, "shipment.created", shipment.id, {
      orderId,
      reason: body.reason,
    });
    return shipment;
  });
}
const scanRank: Record<string, number> = {
  label_created: 0,
  shipped: 1,
  in_transit: 2,
  delivered: 3,
};
export async function scan(
  a: Auth,
  id: string,
  state: string,
  eventId: string,
) {
  role(a, "owner");
  assert(
    Object.hasOwn(scanRank, state) || state === "exception",
    "SCAN",
    "Choose a valid tracking event.",
  );
  return transaction(async (tx) => {
    const s = await tx.shipment.findUniqueOrThrow({
      where: { id },
      include: { order: true, items: true },
    });
    await lock(tx, "Order", s.orderId);
    const current = await tx.shipment.findUniqueOrThrow({ where: { id } });
    const events = current.events as any[];
    if (events.some((e) => e.eventId === eventId)) return current;
    const previousRank = Math.max(
      ...events
        .filter((e) => e.state !== "exception")
        .map((e) => scanRank[e.state] || 0),
    );
    const nextState =
      state === "exception"
        ? previousRank === 3
          ? "delivered"
          : "exception"
        : scanRank[state] >= previousRank
          ? state
          : current.state;
    const updated = await tx.shipment.update({
      where: { id },
      data: {
        state: nextState,
        events: json([
          ...events,
          {
            eventId,
            state,
            at: now().toISOString(),
            late: state !== "exception" && scanRank[state] < previousRank,
          },
        ]),
      },
    });
    await tx.simReceipt.upsert({
      where: { reference: "carrier:" + eventId },
      create: {
        reference: "carrier:" + eventId,
        type: "carrier",
        state,
        payload: json({ shipmentId: id }),
      },
      update: {},
    });
    for (const item of s.items) {
      if (["shipped", "in_transit", "delivered"].includes(nextState)) {
        const all = await tx.shipmentItem.findMany({
          where: { lineId: item.lineId },
          include: { shipment: true },
        });
        const line = await tx.orderLine.findUniqueOrThrow({
          where: { id: item.lineId },
        });
        const originalRuns = await tx.productionRun.findMany({
          where: { lineId: line.id, kind: "original" },
        });
        const delivered = all
          .filter(
            (i) =>
              i.shipment.state === "delivered" &&
              originalRuns.some((r) => r.id === i.runId),
          )
          .reduce((n, i) => n + i.quantity, 0);
        await tx.orderLine.update({
          where: { id: line.id },
          data: {
            state:
              delivered >= line.quantity - line.canceled
                ? "delivered"
                : nextState === "delivered"
                  ? "partially_delivered"
                  : "shipped",
          },
        });
      }
    }
    await audit(tx, a.principal, "shipment." + state, id, { eventId });
    if (
      nextState !== current.state &&
      ["shipped", "delivered", "exception"].includes(nextState)
    )
      await orderNotice(
        tx,
        s.order,
        `shipment:${id}:${nextState}`,
        nextState === "delivered"
          ? "Your personal gift has arrived"
          : "Your parcel has an update",
        `Parcel ${s.ref}: ${nextState.replaceAll("_", " ")}. View the items and tracking on your order.`,
      );
    for (const item of s.items) await refreshLineState(tx, item.lineId);
    return updated;
  });
}
export async function requestCancellation(
  a: Auth,
  orderId: string,
  lineId: string,
  message: string,
) {
  await orderAuth(a, orderId);
  assert(message?.trim(), "REASON", "Tell the studio why you want to cancel.");
  const line = await db.orderLine.findUnique({ where: { id: lineId } });
  assert(
    line?.orderId === orderId,
    "NOT_FOUND",
    "Order item unavailable.",
    404,
  );
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const ticket = await db.ticket.create({
    data: {
      ref: ref("HELP"),
      principal: a.principal,
      email: order.email,
      orderId,
      lineId,
      kind: "cancellation",
      subject: "Cancellation request",
      messages: json([
        {
          by: "customer",
          text: message.slice(0, 3000),
          at: now().toISOString(),
        },
      ]),
    },
  });
  await audit(db, a.principal, "cancellation.requested", lineId, {
    ticketId: ticket.id,
  });
  return ticket;
}
