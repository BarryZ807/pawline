import { Temporal } from "@js-temporal/polyfill";
import { db, json, transaction, lock } from "../infra/db";
import { type Auth, role, orderAuth } from "./auth";
import { assert, now, ref, audit } from "./common";
import { orderNotice } from "./notifications";
export async function proposeDate(
  a: Auth,
  lineId: string,
  body: { date: string; reason: string },
) {
  role(a, "owner");
  assert(
    body.reason?.trim(),
    "REASON",
    "Explain why the production target needs to change.",
  );
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(body.date),
    "DATE",
    "Choose a valid production date.",
  );
  let proposed: Date;
  try {
    proposed = new Date(
      Temporal.PlainDate.from(body.date).toZonedDateTime({
        timeZone: "America/Los_Angeles",
        plainTime: "12:00",
      }).epochMilliseconds,
    );
  } catch {
    assert(false, "DATE", "Choose a valid production date.");
  }
  assert(
    proposed.getTime() > now().getTime(),
    "DATE",
    "Choose a future production date.",
  );
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", lineId);
    const line = await tx.orderLine.findUniqueOrThrow({
      where: { id: lineId },
      include: { order: true },
    });
    assert(
      line.canceled < line.quantity &&
        !["delivered", "shipped"].includes(line.state),
      "LINE_STATE",
      "This item no longer needs a production date.",
      409,
    );
    assert(
      !(await tx.ticket.findFirst({
        where: { lineId, kind: "date_change", state: "awaiting_customer" },
      })),
      "DATE_PENDING",
      "The customer already has a date proposal to review.",
      409,
    );
    const ticket = await tx.ticket.create({
      data: {
        ref: ref("DATE"),
        principal: line.order.principal,
        email: line.order.email,
        orderId: line.orderId,
        lineId,
        kind: "date_change",
        subject: "Production date proposal",
        state: "awaiting_customer",
        messages: json([
          {
            by: "studio",
            text: body.reason.trim(),
            originalDate: line.originalShipDate.toISOString(),
            proposedDate: proposed.toISOString(),
            at: now().toISOString(),
          },
        ]),
      },
    });
    await orderNotice(
      tx,
      line.order,
      "date:" + ticket.id,
      "Please review a production date change",
      "The original production target is preserved. Open your order to accept or decline the proposed date.",
    );
    await audit(tx, a.principal, "date.proposed", lineId, {
      ticketId: ticket.id,
      date: proposed.toISOString(),
      reason: body.reason,
    });
    return ticket;
  });
}
export async function decideDate(
  a: Auth,
  orderId: string,
  ticketId: string,
  decision: string,
) {
  await orderAuth(a, orderId);
  assert(
    ["buyer", "guest"].includes(a.role),
    "BUYER_REQUIRED",
    "The customer must decide on the proposed date.",
    403,
  );
  assert(
    ["accepted", "declined"].includes(decision),
    "DECISION",
    "Accept or decline the date.",
  );
  return transaction(async (tx) => {
    await lock(tx, "Order", orderId);
    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    assert(
      ticket.orderId === orderId && ticket.kind === "date_change",
      "NOT_FOUND",
      "Date proposal unavailable.",
      404,
    );
    if (ticket.state === decision) return ticket;
    assert(
      ticket.state === "awaiting_customer",
      "DATE_DECIDED",
      "This proposal has already been decided.",
      409,
    );
    const result = await tx.ticket.update({
      where: { id: ticketId },
      data: {
        state: decision,
        messages: json([
          ...(ticket.messages as any[]),
          {
            by: "customer",
            text:
              decision === "accepted"
                ? "I accept this production target."
                : "I decline this date. Please contact me about alternatives or cancellation.",
            at: now().toISOString(),
          },
        ]),
      },
    });
    await audit(tx, a.principal, "date." + decision, ticket.lineId!, {
      ticketId,
    });
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    await orderNotice(
      tx,
      order,
      "date-decision:" + ticketId,
      "Your date decision is saved",
      "The studio has your response. Your original promise and decision remain on the order.",
    );
    return result;
  });
}
