import { db, json, transaction, lock } from "../infra/db";
import { role, type Auth, orderAuth } from "./auth";
import {
  assert,
  audit,
  ref,
  hash,
  now,
  addMinutes,
  passwordHash,
  email,
  origin,
  setting,
} from "./common";
import { issueGrant, notify, orderNotice } from "./notifications";
import {
  validateAddress,
  defaultRules,
  type Address,
  type Rules,
} from "./money";
export async function adminOrder(a: Auth, reference: string) {
  role(a, "owner");
  const o = await db.order.findUnique({
    where: { ref: reference },
    include: {
      lines: {
        include: { proofs: { orderBy: { version: "desc" } }, runs: true },
      },
      refunds: { include: { allocations: true } },
      shipments: { include: { items: true } },
    },
  });
  assert(o, "NOT_FOUND", "Order unavailable.", 404);
  return {
    ...o,
    lines: await Promise.all(
      o.lines.map(async (l) => ({
        ...l,
        revision: await db.revision.findUnique({ where: { id: l.revisionId } }),
      })),
    ),
    refunded: o.refunds
      .filter((r) => r.status === "succeeded")
      .reduce((n, r) => n + r.amount, 0),
    tickets: await db.ticket.findMany({
      where: { orderId: o.id },
      orderBy: { createdAt: "desc" },
    }),
  };
}
export async function editCatalog(a: Auth, id: string, body: any) {
  role(a, "owner");
  assert(
    typeof body.reason === "string" && body.reason.trim(),
    "REASON",
    "Record why you are changing the catalog.",
  );
  assert(Array.isArray(body.variants), "VARIANT", "Provide product options to update.");
  return transaction(async (tx) => {
    const p = await tx.product.findUniqueOrThrow({ where: { id } });
    for (const input of body.variants || []) {
      assert(input && typeof input.id === "string", "VARIANT", "Choose a valid product option.");
      assert(typeof input.active === "boolean", "VARIANT", "Choose whether this product option is available.");
      await lock(tx, "Variant", input.id);
      const v = await tx.variant.findUniqueOrThrow({ where: { id: input.id } });
      assert(
        v.productId === id,
        "VARIANT",
        "Variant does not belong to this product.",
      );
      assert(
        [input.price, input.cost, input.capacity].every(
          (x: any) => Number.isInteger(x) && x >= 0 && x <= 1_000_000,
        ),
        "NUMBER",
        "Use whole cents and capacity between 0 and 1,000,000.",
      );
      assert(
        input.capacity >= v.allocated + v.reserved,
        "CAPACITY",
        "Capacity cannot be reduced below committed units.",
        409,
      );
      await tx.variant.update({
        where: { id: v.id },
        data: {
          price: input.price,
          cost: input.cost,
          capacity: input.capacity,
          active: input.active,
          version: { increment: 1 },
        },
      });
    }
    const updated = await tx.product.update({
      where: { id },
      data: {
        name: String(body.name || p.name).slice(0, 120),
        description: String(body.description || p.description).slice(0, 3000),
        active: body.active === true,
        version: { increment: 1 },
      },
    });
    await audit(tx, a.principal, "catalog.updated", id, {
      reason: body.reason,
    });
    return updated;
  });
}
export async function updateTicket(a: Auth, id: string, body: any) {
  role(a, "owner");
  const t = await db.ticket.findUniqueOrThrow({ where: { id } });
  assert(
    ["open", "closed"].includes(body.state),
    "TICKET_STATE",
    "Choose open or closed.",
  );
  const messages = t.messages as any[];
  if (body.reply?.trim()) {
    messages.push({
      by: "studio",
      text: String(body.reply).slice(0, 5000),
      at: now().toISOString(),
    });
    await notify(
      db,
      ref("support"),
      t.email,
      `Studio reply · ${t.ref}`,
      String(body.reply).slice(0, 5000),
      t.orderId ? `${origin()}/orders/lookup` : undefined,
    );
  }
  await audit(db, a.principal, "support.updated", id, { state: body.state });
  return db.ticket.update({
    where: { id },
    data: { messages: json(messages), state: body.state },
  });
}
export async function requestAddress(
  a: Auth,
  orderId: string,
  address: Address,
) {
  await orderAuth(a, orderId);
  validateAddress(address);
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true },
  });
  assert(
    o.lines.every((l) => l.locked === 0),
    "ADDRESS_LOCK",
    "Production has started. Contact support to discuss delivery changes.",
    409,
  );
  return db.ticket.create({
    data: {
      ref: ref("HELP"),
      principal: a.principal,
      email: o.email,
      orderId,
      kind: "address_change",
      subject: "Delivery address change",
      messages: json([
        {
          by: "customer",
          text: "Please review this address update.",
          address,
          at: now().toISOString(),
        },
      ]),
    },
  });
}
export async function approveAddress(
  a: Auth,
  ticketId: string,
  reason: string,
) {
  role(a, "owner");
  assert(reason?.trim(), "REASON", "Record the review reason.");
  return transaction(async (tx) => {
    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    assert(
      ticket.orderId && ticket.kind === "address_change",
      "TICKET",
      "This is not an address change request.",
    );
    await lock(tx, "Order", ticket.orderId);
    const reviewed = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    if (reviewed.state === "closed") return { ok: true };
    const o = await tx.order.findUniqueOrThrow({
      where: { id: ticket.orderId },
      include: { lines: true },
    });
    assert(
      o.lines.every((l) => l.locked === 0),
      "ADDRESS_LOCK",
      "Production has started; contact support.",
      409,
    );
    const address = (ticket.messages as any[])[0].address as Address;
    validateAddress(address);
    const old = o.address as unknown as Address;
    assert(
      address.state === old.state && address.zip === old.zip,
      "REQUOTE_REQUIRED",
      "This changes the demo tax/delivery zone. Cancel and reorder, or record a support exception. No extra charge will be made.",
      409,
    );
    await tx.order.update({
      where: { id: o.id },
      data: { address: json(address), addressVersion: { increment: 1 } },
    });
    await tx.ticket.update({
      where: { id: ticketId },
      data: { state: "closed" },
    });
    await audit(tx, a.principal, "order.address_updated", o.id, {
      version: o.addressVersion + 1,
      reason,
    });
    await orderNotice(
      tx,
      o,
      ref("address"),
      "Your delivery address was updated",
      "Your original purchase record is preserved. The studio reviewed a new delivery snapshot.",
    );
    return { ok: true };
  });
}
export async function forgotPassword(value: string) {
  const e = email(String(value || ""));
  const u = await db.user.findUnique({ where: { email: e } });
  if (u) {
    const raw = await issueGrant(db, "reset", u.id, u.email);
    await notify(
      db,
      ref("reset"),
      u.email,
      "Reset your Pawline password",
      "This local link expires in 30 minutes. Opening it does not reset your password.",
      `${origin()}/account/reset/${raw}`,
    );
  }
  return {
    message: "If an account matches, a reset link has been sent to its email.",
  };
}
export async function resetPassword(raw: string, password: string) {
  assert(
    typeof password === "string" &&
      password.length >= 10 &&
      password.length <= 128,
    "PASSWORD",
    "Use 10–128 characters.",
  );
  return transaction(async (tx) => {
    const grant = await tx.grant.findUnique({
      where: { tokenHash: hash(raw) },
    });
    assert(
      grant &&
        grant.purpose === "reset" &&
        !grant.revokedAt &&
        !grant.usedAt &&
        grant.expiresAt > now(),
      "RESET_LINK",
      "This reset link is unavailable. Request a new one.",
      410,
    );
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${grant.scope} FOR UPDATE`;
    const current = await tx.grant.findUniqueOrThrow({
      where: { id: grant.id },
    });
    assert(
      !current.usedAt && !current.revokedAt,
      "RESET_LINK",
      "This reset link was already used.",
      410,
    );
    await tx.user.update({
      where: { id: grant.scope },
      data: { passwordHash: passwordHash(password) },
    });
    await tx.grant.updateMany({
      where: { purpose: "reset", scope: grant.scope },
      data: { revokedAt: now() },
    });
    await tx.grant.update({ where: { id: grant.id }, data: { usedAt: now() } });
    await tx.session.deleteMany({ where: { userId: grant.scope } });
    await audit(tx, grant.scope, "account.password_reset", grant.scope);
    return { message: "Password updated. Sign in with your new password." };
  });
}
export async function requestClaim(a: Auth, orderRef: string) {
  assert(a.userId, "SIGN_IN", "Sign in before claiming a guest order.", 401);
  const o = await db.order.findUnique({ where: { ref: orderRef } });
  if (o && o.email === a.email) {
    const raw = await issueGrant(db, "claim", o.id, o.email);
    await notify(
      db,
      ref("claim"),
      o.email,
      "Confirm your order claim",
      "Sign in to your account, then explicitly confirm to add this guest order.",
      `${origin()}/account/claim/${raw}`,
    );
  }
  return {
    message:
      "If the order email matches your account, a confirmation link has been sent.",
  };
}
export async function claimOrder(a: Auth, raw: string) {
  assert(a.userId, "SIGN_IN", "Sign in before claiming this order.", 401);
  return transaction(async (tx) => {
    const g = await tx.grant.findUnique({ where: { tokenHash: hash(raw) } });
    assert(
      g &&
        g.purpose === "claim" &&
        !g.revokedAt &&
        g.expiresAt > now() &&
        g.email === a.email,
      "CLAIM_LINK",
      "This claim link is unavailable.",
      410,
    );
    await lock(tx, "Order", g.scope);
    const o = await tx.order.findUniqueOrThrow({ where: { id: g.scope } });
    if (o.principal === a.principal) return { ref: o.ref };
    assert(
      !g.usedAt && o.principal.startsWith("guest_"),
      "CLAIMED",
      "This order has already been claimed.",
      409,
    );
    await tx.order.update({
      where: { id: o.id },
      data: { principal: a.principal },
    });
    await tx.grant.update({ where: { id: g.id }, data: { usedAt: now() } });
    await audit(tx, a.principal, "order.claimed", o.id);
    return { ref: o.ref };
  });
}
