import { recordReceipt } from "../infra/receipts";
import { afterReceipt } from "./faults";
import { db, json, transaction, lock, type Store } from "../infra/db";
import {
  assert,
  hash,
  ref,
  now,
  addMinutes,
  setting,
  audit,
  enqueue,
  businessDays,
} from "./common";
import { type Auth } from "./auth";
import { priceOrder, validateCoupon, defaultRules, type Address, type Rules } from "./money";
import { freezeDesign } from "./media";
import { orderNotice } from "./notifications";
export async function cartFor(a: Auth, tx: Store = db) {
  let c = await tx.cart.findFirst({
    where: { principal: a.principal, state: { in: ["open", "processing"] } },
  });
  if (!c) {
    try {
      c = await tx.cart.create({ data: { principal: a.principal } });
    } catch {
      c = await tx.cart.findFirstOrThrow({
        where: {
          principal: a.principal,
          state: { in: ["open", "processing"] },
        },
      });
    }
  }
  return c;
}
export async function getCart(a: Auth) {
  const c = await cartFor(a);
  const raw = await db.cartLine.findMany({
    where: { cartId: c.id },
    orderBy: { id: "asc" },
  });
  const lines = await Promise.all(
    raw.map(async (l) => ({
      ...l,
      variant: await db.variant.findUnique({
        where: { id: l.variantId },
        include: { product: true },
      }),
      revision: await db.revision.findUnique({ where: { id: l.revisionId } }),
    })),
  );
  return {
    ...c,
    lines,
    count: lines.reduce((n, l) => n + l.quantity, 0),
    subtotal: lines.reduce(
      (n, l) => n + l.quantity * (l.variant?.price || 0),
      0,
    ),
  };
}
export async function addCart(
  a: Auth,
  designId: string,
  quantity: number,
  replaceId?: string,
) {
  assert(
    Number.isInteger(quantity) && quantity >= 1 && quantity <= 20,
    "QUANTITY",
    "Choose 1–20 units.",
  );
  const revision = await freezeDesign(a, designId);
  const design = await db.design.findUniqueOrThrow({ where: { id: designId } });
  return transaction(async (tx) => {
    const cart = await cartFor(a, tx);
    await lock(tx, "Cart", cart.id);
    const c = await tx.cart.findUniqueOrThrow({ where: { id: cart.id } });
    assert(
      c.state === "open",
      "PAYMENT_PENDING",
      "Wait for payment status before changing your bag.",
      409,
    );
    const v = await tx.variant.findUniqueOrThrow({
      where: { id: design.variantId },
    });
    assert(
      v.capacity - v.allocated - v.reserved >= quantity,
      "SOLD_OUT",
      "This quantity exceeds available demo capacity.",
      409,
    );
    if (replaceId) {
      const line = await tx.cartLine.findUnique({ where: { id: replaceId } });
      assert(
        line?.cartId === cart.id,
        "NOT_FOUND",
        "Bag item unavailable.",
        404,
      );
      await tx.cartLine.update({
        where: { id: replaceId },
        data: {
          revisionId: revision.id,
          quantity,
          variantId: design.variantId,
        },
      });
    } else
      await tx.cartLine.create({
        data: {
          cartId: cart.id,
          variantId: design.variantId,
          revisionId: revision.id,
          quantity,
        },
      });
    return tx.cart.update({
      where: { id: cart.id },
      data: { version: { increment: 1 } },
    });
  });
}
export async function changeCart(a: Auth, id: string, quantity: number | null) {
  return transaction(async (tx) => {
    const c = await cartFor(a, tx);
    await lock(tx, "Cart", c.id);
    const current = await tx.cart.findUniqueOrThrow({ where: { id: c.id } });
    assert(
      current.state === "open",
      "PAYMENT_PENDING",
      "Wait for payment status before changing your bag.",
      409,
    );
    const line = await tx.cartLine.findUnique({ where: { id } });
    assert(line?.cartId === c.id, "NOT_FOUND", "Bag item unavailable.", 404);
    if (quantity === null) await tx.cartLine.delete({ where: { id } });
    else {
      assert(
        Number.isInteger(quantity) && quantity >= 1 && quantity <= 20,
        "QUANTITY",
        "Choose 1–20 units.",
      );
      await tx.cartLine.update({ where: { id }, data: { quantity } });
    }
    return tx.cart.update({
      where: { id: c.id },
      data: { version: { increment: 1 } },
    });
  });
}
export async function quote(
  a: Auth,
  body: { address: Address; method: string; code: string; cartVersion: number },
) {
  const c = await getCart(a);
  assert(
    c.state === "open",
    "CHECKOUT_IN_PROGRESS",
    "A payment is being checked. Please wait.",
    409,
  );
  assert(
    c.version === body.cartVersion,
    "CART_CHANGED",
    "Your bag changed. Review it and request a new quote.",
    409,
  );
  for (const l of c.lines)
    assert(
      l.variant?.active && l.variant.product.active && l.revision,
      "UNAVAILABLE",
      "An item is no longer available.",
      409,
    );
  const rules = await setting<Rules>("rules", defaultRules);
  const priced = priceOrder(
    c.lines.map((l) => ({
      id: l.id,
      price: l.variant!.price,
      quantity: l.quantity,
      productId: l.variant!.productId,
    })),
    body.address,
    body.method,
    body.code || "",
    rules,
  );
  const snapshot = {
    ...priced,
    address: {
      ...body.address,
      email: body.address.email.trim().toLowerCase(),
    },
    lines: priced.lines.map((l) => {
      const cl = c.lines.find((x) => x.id === l.id)!;
      return {
        ...l,
        variantId: cl.variantId,
        variantVersion: cl.variant!.version,
        product: cl.variant!.product,
        variant: cl.variant,
        revisionId: cl.revisionId,
      };
    }),
  };
  return db.quote.create({
    data: {
      cartId: c.id,
      cartVersion: c.version,
      principal: a.principal,
      inputHash: hash(JSON.stringify(snapshot)),
      snapshot: json(snapshot),
      expiresAt: addMinutes(10),
    },
  });
}
export async function attempt(
  a: Auth,
  quoteId: string,
  key: string,
  expectedCartVersion: number,
  scenario = "success",
) {
  assert(typeof quoteId === "string" && quoteId.length > 0 && quoteId.length <= 128, "QUOTE", "Request a valid quote first.", 422);
  assert(
    typeof key === "string" && key.length >= 10 && key.length <= 128,
    "KEY",
    "A payment request key is required.",
  );
  assert(
    ["success", "declined"].includes(scenario) || a.role === "owner",
    "SCENARIO",
    "This payment mode is unavailable.",
  );
  const requestHash = hash(
    JSON.stringify({ quoteId, expectedCartVersion, scenario }),
  );
  const at = await transaction(async (tx) => {
    const existing = await tx.attempt.findUnique({
      where: { principal_key: { principal: a.principal, key } },
    });
    if (existing) {
      assert(
        existing.requestHash === requestHash,
        "KEY_REUSED",
        "This request key belongs to another checkout.",
        409,
      );
      return existing;
    }
    const q = await tx.quote.findUnique({ where: { id: quoteId } });
    assert(
      q && q.principal === a.principal,
      "QUOTE",
      "Request a valid quote first.",
      404,
    );
    await lock(tx, "Cart", q.cartId);
    const c = await tx.cart.findUniqueOrThrow({ where: { id: q.cartId } });
    if (c.activeAttemptId) {
      const pending = await tx.attempt.findUniqueOrThrow({
        where: { id: c.activeAttemptId },
      });
      if (["pending", "unknown", "paid"].includes(pending.status)) {
        assert(
          pending.requestHash === requestHash,
          "CHECKOUT_IN_PROGRESS",
          "Another payment request is already being checked. Its details cannot be changed; check the original payment status.",
          409,
        );
        return pending;
      }
    }
    assert(
      c.state === "open" &&
        c.version === q.cartVersion &&
        c.version === expectedCartVersion,
      "CART_CHANGED",
      "Your bag changed. Review a new quote.",
      409,
    );
    assert(
      q.expiresAt > now(),
      "QUOTE_EXPIRED",
      "Your quote expired. Review a new quote.",
      409,
    );
    const s = q.snapshot as any;
    const rules = await setting<Rules>("rules", defaultRules, tx);
    assert(
      s.ruleVersion === rules.version,
      "PRICE_CHANGED",
      "Delivery or discount rules changed. Review a new quote.",
      409,
    );
    const quantities: Record<string, number> = {};
    validateCoupon(s.code, rules, s.lines.map((l: any) => ({ ...l, productId: l.product.id })));
    for (const l of s.lines)
      quantities[l.variantId] = (quantities[l.variantId] || 0) + l.quantity;
    for (const variantId of Object.keys(quantities).sort()) {
      await lock(tx, "Variant", variantId);
      const v = await tx.variant.findUniqueOrThrow({
        where: { id: variantId },
        include: { product: true },
      });
      assert(
        v.active &&
          v.product.active &&
          s.lines
            .filter((l: any) => l.variantId === variantId)
            .every(
              (l: any) => l.price === v.price && l.variantVersion === v.version,
            ),
        "PRICE_CHANGED",
        "An item changed. Review a new quote.",
        409,
      );
      assert(
        v.capacity - v.allocated - v.reserved >= quantities[variantId],
        "SOLD_OUT",
        "This item is no longer available in that quantity.",
        409,
      );
    }
    const injected = await setting<any>("paymentScenario", {}, tx);
    const effectiveScenario =
      injected.cartId === c.id ? injected.scenario : scenario;
    if (injected.cartId === c.id)
      await tx.setting.update({
        where: { key: "paymentScenario" },
        data: { value: {} },
      });
    const at = await tx.attempt.create({
      data: {
        cartId: c.id,
        cartVersion: c.version,
        quoteId: q.id,
        principal: a.principal,
        key,
        requestHash,
        providerRef: ref("PAY"),
        amount: s.total,
        scenario: effectiveScenario,
      },
    });
    for (const [variantId, quantity] of Object.entries(quantities)) {
      await tx.variant.update({
        where: { id: variantId },
        data: { reserved: { increment: quantity } },
      });
      await tx.reservation.create({
        data: {
          attemptId: at.id,
          variantId,
          quantity,
          expiresAt: addMinutes(15),
        },
      });
    }
    await tx.cart.update({
      where: { id: c.id },
      data: { state: "processing", activeAttemptId: at.id },
    });
    await enqueue(tx, `capture:${at.id}`, "capture", {
      attemptId: at.id,
      attribution: a.analytics ? a.attribution : {},
      source: a.source,
    });
    await audit(tx, a.principal, "payment.started", at.id);
    return at;
  });
  if (["pending", "unknown"].includes(at.status))
    await capture(at.id, a.analytics ? a.attribution : {}, a.source);
  return getAttempt(a, at.id);
}
export async function capture(
  id: string,
  attribution: unknown = {},
  source = "demo",
) {
  const at = await db.attempt.findUniqueOrThrow({ where: { id } });
  if (!["pending", "unknown"].includes(at.status)) return at;
  const receipt = await recordReceipt({
    where: { reference: at.providerRef },
    create: {
      reference: at.providerRef,
      type: "capture",
      amount: at.amount,
      state: at.scenario === "declined" ? "declined" : "succeeded",
      payload: json({ attemptId: at.id }),
    },
    update: {},
  });
  await afterReceipt("capture", at.providerRef);
  assert(
    receipt.amount === at.amount,
    "RECEIPT_MISMATCH",
    "Payment requires reconciliation.",
    409,
  );
  if (at.scenario === "lost_response" && at.status === "pending") {
    await db.attempt.update({ where: { id }, data: { status: "unknown" } });
    return;
  }
  return transaction(async (tx) => {
    await lock(tx, "Cart", at.cartId);
    await lock(tx, "Attempt", id);
    const current = await tx.attempt.findUniqueOrThrow({ where: { id } });
    if (!["pending", "unknown"].includes(current.status)) return current;
    const reservations = await tx.reservation.findMany({
      where: { attemptId: id, state: "reserved" },
      orderBy: { variantId: "asc" },
    });
    for (const r of reservations) await lock(tx, "Variant", r.variantId);
    if (receipt.state === "declined") {
      for (const r of reservations) {
        await tx.variant.update({
          where: { id: r.variantId },
          data: { reserved: { decrement: r.quantity } },
        });
        await tx.reservation.update({
          where: { id: r.id },
          data: { state: "released" },
        });
      }
      await tx.cart.update({
        where: { id: at.cartId },
        data: { state: "open", activeAttemptId: null },
      });
      await audit(tx, at.principal, "payment.declined", id);
      return tx.attempt.update({ where: { id }, data: { status: "declined" } });
    }
    const q = await tx.quote.findUniqueOrThrow({ where: { id: at.quoteId } });
    const s = q.snapshot as any;
    const order = await tx.order.create({
      data: {
        ref: ref("PL"),
        paidAt: now(),
        principal: at.principal,
        email: s.address.email,
        cartId: at.cartId,
        cartVersion: at.cartVersion,
        attemptId: at.id,
        address: json(s.address),
        snapshot: json(s),
        subtotal: s.subtotal,
        discount: s.discount,
        tax: s.tax,
        shipping: s.shipping,
        total: s.total,
        source,
        attribution: json(attribution),
        lines: {
          create: s.lines.map((l: any) => ({
            variantId: l.variantId,
            revisionId: l.revisionId,
            quantity: l.quantity,
            snapshot: json(l),
            net: l.net,
            tax: l.tax,
            unitSlices: json(l.units),
            deadline: businessDays(now(), 2),
            originalShipDate: businessDays(now(), l.product.template.days),
          })),
        },
      },
    });
    for (const r of reservations) {
      await tx.variant.update({
        where: { id: r.variantId },
        data: {
          reserved: { decrement: r.quantity },
          allocated: { increment: r.quantity },
        },
      });
      await tx.reservation.update({
        where: { id: r.id },
        data: { state: "allocated" },
      });
      await tx.capacityEffect.create({
        data: {
          effectKey: `purchase:${id}:${r.variantId}`,
          variantId: r.variantId,
          delta: r.quantity,
          reason: "purchase",
        },
      });
    }
    await tx.cart.update({
      where: { id: at.cartId },
      data: { state: "closed" },
    });
    await tx.attempt.update({
      where: { id },
      data: { status: "paid", orderId: order.id },
    });
    await audit(tx, at.principal, "order.paid", order.id, {
      total: order.total,
    });
    await orderNotice(
      tx,
      order,
      `order:${order.id}`,
      "Your Pawline order is in",
      `Order ${order.ref} is paid in our local demo. Your designer will prepare a proof before anything goes into production.`,
    );
    return order;
  });
}
export async function getAttempt(a: Auth, id: string) {
  const at = await db.attempt.findUnique({ where: { id } });
  assert(
    at && at.principal === a.principal,
    "NOT_FOUND",
    "Payment attempt unavailable.",
    404,
  );
  const order = at.orderId
    ? await db.order.findUnique({ where: { id: at.orderId } })
    : null;
  if (order && a.analytics && ["guest", "buyer"].includes(a.role)) {
    const eventId = "purchase:" + at.id;
    const payload = json({ session: a.sessionId, attribution: a.attribution });
    await db.$executeRaw`INSERT INTO "Event"(id,"eventId",kind,actor,"objectId",source,data,"createdAt") VALUES (${ref("EV")},${eventId},'purchase','customer',${order.id},${a.source},${JSON.stringify(payload)}::jsonb,${now()}) ON CONFLICT("eventId") DO NOTHING`;
  }
  return {
    id: at.id,
    status: at.status,
    orderRef: order?.ref,
    total: at.amount,
  };
}
