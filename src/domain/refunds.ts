import { refreshLineState } from "./line-state";
import { recordReceipt } from "../infra/receipts";
import { afterReceipt } from "./faults";
import { db, json, transaction, lock } from "../infra/db";
import { type Auth, role } from "./auth";
import { assert, hash, ref, audit, enqueue, now } from "./common";
import { orderNotice } from "./notifications";
export async function refund(
  a: Auth,
  orderId: string,
  body: {
    lineId: string;
    quantity: number;
    reason: string;
    key: string;
    scenario?: string;
    expectedAmount?: number;
  },
) {
  role(a, "owner");
  assert(body.reason?.trim(), "REASON", "Record a refund reason.");
  assert(
    Number.isInteger(body.quantity) && body.quantity > 0,
    "QUANTITY",
    "Choose a positive whole quantity.",
  );
  assert(body.key?.length >= 10, "KEY", "A refund request key is required.");
  const requestHash = hash(
    JSON.stringify({
      orderId,
      lineId: body.lineId,
      quantity: body.quantity,
      reason: body.reason,
    }),
  );
  return transaction(async (tx) => {
    await lock(tx, "Order", orderId);
    const existing = await tx.refund.findUnique({ where: { key: body.key } });
    if (existing) {
      assert(
        existing.requestHash === requestHash,
        "KEY_REUSED",
        "This refund key has different details.",
        409,
      );
      return existing;
    }
    await lock(tx, "OrderLine", body.lineId);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true, refunds: { include: { allocations: true } } },
    });
    const line = order.lines.find((l) => l.id === body.lineId);
    assert(line, "NOT_FOUND", "Order item unavailable.", 404);
    const runs = await tx.productionRun.findMany({
      where: { lineId: line.id, kind: "original" },
    });
    const { slices, net, tax, shipping, amount } = cancellationPlan(
      order,
      line,
      runs,
      body.quantity,
    );
    if (body.expectedAmount !== undefined)
      assert(
        body.expectedAmount === amount,
        "REFUND_CHANGED",
        "The refundable amount changed. Reload and review it.",
        409,
      );
    const r = await tx.refund.create({
      data: {
        ref: ref("REFUND"),
        orderId,
        key: body.key,
        requestHash,
        reason: body.reason.trim(),
        amount,
        scenario: body.scenario || "success",
        allocations: {
          create: {
            lineId: line.id,
            units: json(slices.map((u) => u.ordinal)),
            quantity: body.quantity,
            net,
            tax,
            shipping,
          },
        },
      },
    });
    await tx.orderLine.update({
      where: { id: line.id },
      data: { held: { increment: body.quantity }, state: "refund_pending" },
    });
    await enqueue(tx, `refund:${r.id}`, "refund", { refundId: r.id });
    await audit(tx, a.principal, "refund.requested", orderId, {
      refundId: r.id,
      lineId: line.id,
      quantity: body.quantity,
      amount,
      reason: body.reason,
    });
    return r;
  });
}
export async function settleRefund(id: string) {
  const refund = await db.refund.findUniqueOrThrow({ where: { id } });
  if (!["pending", "unknown"].includes(refund.status)) return refund;
  const receipt = await recordReceipt({
    where: { reference: refund.ref },
    create: {
      reference: refund.ref,
      type: "refund",
      amount: refund.amount,
      state: refund.scenario === "declined" ? "failed" : "succeeded",
      payload: json({ refundId: id, orderId: refund.orderId }),
    },
    update: {},
  });
  await afterReceipt("refund", refund.ref);
  assert(
    receipt.amount === refund.amount,
    "REFUND_MISMATCH",
    "Refund requires reconciliation.",
    409,
  );
  if (refund.scenario === "lost_response" && refund.status === "pending") {
    await db.refund.update({ where: { id }, data: { status: "unknown" } });
    throw Error("RefundResponseUnknown");
  }
  return transaction(async (tx) => {
    await lock(tx, "Order", refund.orderId);
    const current = await tx.refund.findUniqueOrThrow({
      where: { id },
      include: { allocations: true, order: true },
    });
    if (!["pending", "unknown"].includes(current.status)) return current;
    for (const allocation of [...current.allocations].sort((a, b) =>
      a.lineId.localeCompare(b.lineId),
    )) {
      await lock(tx, "OrderLine", allocation.lineId);
      const line = await tx.orderLine.findUniqueOrThrow({
        where: { id: allocation.lineId },
      });
      if (allocation.quantity === 0) continue;
      if (receipt.state === "succeeded") {
        await lock(tx, "Variant", line.variantId);
        await tx.variant.update({
          where: { id: line.variantId },
          data: { allocated: { decrement: allocation.quantity } },
        });
        await tx.capacityEffect.create({
          data: {
            effectKey: `cancel:${id}:${line.id}`,
            variantId: line.variantId,
            delta: -allocation.quantity,
            reason: "cancellation",
          },
        });
        const canceled = line.canceled + allocation.quantity;
        const proof = await tx.proof.findFirst({
          where: { lineId: line.id },
          orderBy: { version: "desc" },
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: {
            held: { decrement: allocation.quantity },
            canceled: { increment: allocation.quantity },
            state:
              canceled === line.quantity
                ? "canceled"
                : line.locked
                  ? "in_production"
                  : proof?.state === "approved"
                    ? "ready"
                    : "awaiting_design",
          },
        });
      } else
        await tx.orderLine.update({
          where: { id: line.id },
          data: {
            held: { decrement: allocation.quantity },
            state: "awaiting_design",
          },
        });
    }
    for (const allocation of current.allocations)
      await refreshLineState(tx, allocation.lineId);
    await tx.refund.update({
      where: { id },
      data: {
        status: receipt.state === "succeeded" ? "succeeded" : "failed",
        succeededAt: receipt.state === "succeeded" ? now() : null,
      },
    });
    await audit(tx, "worker", "refund." + receipt.state, current.orderId, {
      refundId: id,
      amount: current.amount,
    });
    if (receipt.state === "succeeded")
      await orderNotice(
        tx,
        current.order,
        `refund:${id}`,
        "Your refund is recorded",
        `Refund ${current.ref} returned ${(current.amount / 100).toFixed(2)} simulated USD. Your other items keep their own progress.`,
      );
    return current;
  });
}

function cancellationPlan(
  order: any,
  line: any,
  runs: any[],
  quantity: number,
) {
  const previous = order.refunds
    .filter((r: any) => r.status !== "failed")
    .flatMap((r: any) =>
      r.allocations.filter((x: any) => x.lineId === line.id),
    );
  const reservedUnits = previous.flatMap((x: any) => x.units as number[]);
  const lockedUnits = runs.flatMap((r: any) => r.units as number[]);
  const slices = (
    line.unitSlices as { ordinal: number; net: number; tax: number }[]
  )
    .filter(
      (u) =>
        !reservedUnits.includes(u.ordinal) && !lockedUnits.includes(u.ordinal),
    )
    .slice(0, quantity);
  assert(
    slices.length === quantity,
    "CANNOT_CANCEL",
    "These units are already refunded, reserved for a refund, or released to the factory. Contact support for an exception.",
    409,
  );
  const net = slices.reduce((n, u) => n + u.net, 0),
    tax = slices.reduce((n, u) => n + u.tax, 0);
  const allCanceled = order.lines.every(
    (l: any) =>
      l.canceled + l.held + (l.id === line.id ? quantity : 0) === l.quantity &&
      l.locked === 0,
  );
  const shippingAlready = order.refunds
    .filter((r: any) => r.status !== "failed")
    .reduce(
      (n: number, r: any) =>
        n + r.allocations.reduce((m: number, x: any) => m + x.shipping, 0),
      0,
    );
  const shipping = allCanceled
    ? Math.max(0, order.shipping - shippingAlready)
    : 0;
  const amount = net + tax + shipping;
  const occupied = order.refunds
    .filter((r: any) => r.status !== "failed")
    .reduce((n: number, r: any) => n + r.amount, 0);
  assert(
    occupied + amount <= order.total,
    "REFUND_LIMIT",
    "This would exceed the remaining refundable balance.",
    409,
  );

  return { slices, net, tax, shipping, amount };
}
export async function refundQuote(
  a: Auth,
  orderId: string,
  lineId: string,
  quantity: number,
) {
  role(a, "owner");
  assert(
    Number.isInteger(quantity) && quantity > 0,
    "QUANTITY",
    "Choose a positive quantity.",
  );
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true, refunds: { include: { allocations: true } } },
  });
  const line = order.lines.find((l) => l.id === lineId);
  assert(line, "NOT_FOUND", "Order item unavailable.", 404);
  const runs = await db.productionRun.findMany({
    where: { lineId, kind: "original" },
  });
  return cancellationPlan(order, line, runs, quantity);
}

/** Money-only exception after all remaining original units have been released. */
export async function goodwillRefund(
  a: Auth,
  orderId: string,
  body: {
    lineId: string;
    net: number;
    tax: number;
    shipping: number;
    reason: string;
    key: string;
  },
) {
  role(a, "owner");
  assert(
    body.reason?.trim(),
    "REASON",
    "Record the reason for this exception.",
  );
  assert(body.key?.length >= 10, "KEY", "A stable request key is required.");
  assert(
    [body.net, body.tax, body.shipping].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ),
    "AMOUNT",
    "Enter nonnegative whole cents.",
  );
  const amount = body.net + body.tax + body.shipping;
  assert(amount > 0, "AMOUNT", "Enter an amount to refund.");
  const requestHash = hash(JSON.stringify({ orderId, ...body }));
  return transaction(async (tx) => {
    await lock(tx, "Order", orderId);
    const existing = await tx.refund.findUnique({ where: { key: body.key } });
    if (existing) {
      assert(
        existing.requestHash === requestHash,
        "KEY_REUSED",
        "This key has different refund details.",
        409,
      );
      return existing;
    }
    await lock(tx, "OrderLine", body.lineId);
    const o = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true, refunds: { include: { allocations: true } } },
    });
    const l = o.lines.find((l) => l.id === body.lineId);
    assert(l, "NOT_FOUND", "Order item unavailable.", 404);
    assert(
      l.locked > 0 && l.locked + l.canceled === l.quantity && !l.held,
      "EXCEPTION_STATE",
      "Use cancellation for unreleased units. This exception is for fully released items.",
      409,
    );
    const occupied = o.refunds.filter((r) => r.status !== "failed"),
      allocations = occupied.flatMap((r) =>
        r.allocations.filter((x) => x.lineId === l.id),
      );
    const sum = (key: "net" | "tax" | "shipping") =>
      allocations.reduce((n, x) => n + x[key], 0);
    assert(
      body.net + sum("net") <= l.net &&
        body.tax + sum("tax") <= l.tax &&
        body.shipping + sum("shipping") <=
          ((l.snapshot as any).shippingAllocation ?? 0) &&
        amount + occupied.reduce((n, r) => n + r.amount, 0) <= o.total,
      "REFUND_LIMIT",
      "This exceeds the remaining refundable merchandise, tax or delivery balance.",
      409,
    );
    const r = await tx.refund.create({
      data: {
        ref: ref("REFUND"),
        orderId,
        key: body.key,
        requestHash,
        reason: "Goodwill: " + body.reason.trim(),
        amount,
        allocations: {
          create: {
            lineId: l.id,
            units: [],
            quantity: 0,
            net: body.net,
            tax: body.tax,
            shipping: body.shipping,
          },
        },
      },
    });
    await enqueue(tx, "refund:" + r.id, "refund", { refundId: r.id });
    await audit(tx, a.principal, "refund.goodwill_requested", orderId, {
      refundId: r.id,
      lineId: l.id,
      amount,
      reason: body.reason,
    });
    return r;
  });
}
