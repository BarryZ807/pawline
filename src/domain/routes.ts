import { proposeDate, decideDate } from "./promises";
import { NextRequest, NextResponse } from "next/server";
import { metrics, exportCsv } from "./monitor";
import { auditLog, auditCsv } from "./audit-log";
import { db, json } from "../infra/db";
import { type Auth, role, orderAuth } from "./auth";
import { assert, ref, audit, setting, enqueue, now } from "./common";
import {
  studioJobs,
  studioJob,
  claim,
  saveWork,
  publishProof,
  proofAccess,
  decideProof,
  resendProof,
} from "./proofs";
import {
  release,
  factoryEvent,
  createShipment,
  scan,
  requestCancellation,
} from "./fulfillment";
import { refund, refundQuote, goodwillRefund } from "./refunds";
import {
  adminOrder,
  editCatalog,
  updateTicket,
  forgotPassword,
  resetPassword,
  requestClaim,
  claimOrder,
  requestAddress,
  approveAddress,
} from "./operations";
import { orderNotice } from "./notifications";
export const UNHANDLED = Symbol("unhandled");
export async function extraRoutes(
  req: NextRequest,
  parts: string[],
  a: Auth,
  body: any,
) {
  const r = parts.join("/"),
    m = req.method;
  if (r === "auth/forgot" && m === "POST") return forgotPassword(body.email);
  if (r === "auth/reset" && m === "POST")
    return resetPassword(body.token, body.password);
  if (r === "account/claim-request" && m === "POST")
    return requestClaim(a, body.orderRef);
  if (r === "account/claim" && m === "POST") return claimOrder(a, body.token);
  if (parts[0] === "studio") {
    role(a, "owner", "designer");
    if (m === "GET" && parts.length === 1)
      return studioJobs(a, req.nextUrl.searchParams.get("filter") || "all", Math.max(0,Math.min(10000,Math.floor(Number(req.nextUrl.searchParams.get('page'))||0))));
    if (parts[1] === "jobs") {
      if (m === "GET" && parts[3] === "manifest") {
        await studioJob(a, parts[2]);
        const p = await db.proof.findUnique({
          where: {
            lineId_version: {
              lineId: parts[2],
              version: Number(req.nextUrl.searchParams.get("version")),
            },
          },
        });
        assert(p, "NOT_FOUND", "Production parameters unavailable.", 404);
        return new NextResponse(JSON.stringify(p.manifest, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition":
              "attachment; filename=pawline-production-parameters.json",
          },
        });
      }
      if (m === "GET") return studioJob(a, parts[2]);
      if (m === "POST" && parts[3] === "claim") return claim(a, parts[2]);
      if (m === "PATCH" && parts[3] === "draft")
        return saveWork(
          a,
          parts[2],
          body.data,
          body.minutes,
          body.expectedVersion,
        );
      if (m === "POST" && parts[3] === "publish")
        return publishProof(a, parts[2], body.expectedVersion);
    }
  }
  if (parts[0] === "proofs") {
    if (m === "GET" && parts[2] === "manifest") {
      const p = await proofAccess(a, parts[1]);
      return new NextResponse(JSON.stringify(p.manifest, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition":
            "attachment; filename=production-manifest.json",
        },
      });
    }
    if (m === "GET") return proofAccess(a, parts[1]);
    if (m === "POST" && parts[2] === "decisions")
      return decideProof(
        a,
        parts[1],
        body.decision,
        body.feedback,
        body.expectedVersion,
      );
    if (m === "POST" && parts[2] === "resend") return resendProof(a, parts[1]);
  }
  if (parts[0] === "orders" && m === "POST") {
    const order = await db.order.findUnique({ where: { ref: parts[1] } });
    assert(order, "NOT_FOUND", "Order unavailable.", 404);
    await orderAuth(a, order.id);
    if (parts[2] === "date-decision")
      return decideDate(a, order.id, body.ticketId, body.decision);
    if (parts[2] === "cancel")
      return requestCancellation(a, order.id, body.lineId, body.reason);
    if (parts[2] === "address")
      return requestAddress(a, order.id, body.address);
    if (parts[2] === "resend") {
      await orderNotice(
        db,
        order,
        ref("resend"),
        "Your order details",
        `A fresh private link to order ${order.ref}.`,
      );
      await audit(db, a.principal, "order.email_resent", order.id);
      return { message: "Sent a fresh link to the order email." };
    }
  }
  if (parts[0] === "admin") {
    role(a, "owner");
    if (m === "GET" && parts[1] === "metrics")
      return metrics(a, req.nextUrl.searchParams);
    if (m === "GET" && parts[1] === "export")
      return new NextResponse(await exportCsv(a, req.nextUrl.searchParams), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=pawline-ledger.csv",
        },
      });
    if (m === "GET" && parts[1] === "orders" && parts[2])
      return parts[3] === "refund-quote"
        ? refundQuote(
            a,
            parts[2],
            req.nextUrl.searchParams.get("line") || "",
            Number(req.nextUrl.searchParams.get("quantity")),
          )
        : adminOrder(a, parts[2]);
    if (m === "POST" && parts[1] === "lines" && parts[3] === "date")
      return proposeDate(a, parts[2], body);
    if (m === "POST" && parts[1] === "lines" && parts[3] === "release")
      return release(a, parts[2], body);
    if (m === "POST" && parts[1] === "orders" && parts[3] === "goodwill")
      return goodwillRefund(a, parts[2], body);
    if (m === "POST" && parts[1] === "orders" && parts[3] === "refunds")
      return refund(a, parts[2], body);
    if (m === "POST" && r === "admin/shipments")
      return createShipment(a, body.orderId, body);
    if (m === "POST" && parts[1] === "shipments" && parts[3] === "scan")
      return scan(a, parts[2], body.state, body.eventId || ref("SCAN"));
    if (m === "POST" && parts[1] === "production" && parts[3] === "event")
      return factoryEvent(a, parts[2], body.state);
    if (m === "GET" && parts[1] === "production")
      return db.productionRun.findMany({
        include: { line: { include: { order: { select: { ref: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    if (m === "GET" && parts[1] === "shipments")
      return db.shipment.findMany({
        include: { items: true, order: { select: { ref: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    if (m === "GET" && parts[1] === "catalog")
      return db.product.findMany({
        include: { variants: true },
        orderBy: { id: "asc" },
      });
    if (m === "PATCH" && parts[1] === "catalog")
      return editCatalog(a, parts[2], body);
    if (m === "GET" && parts[1] === "support")
      return db.ticket.findMany({ orderBy: { updatedAt: "desc" }, take: 100 });
    if (m === "PATCH" && parts[1] === "support")
      return updateTicket(a, parts[2], body);
    if (
      m === "POST" &&
      parts[1] === "support" &&
      parts[3] === "approve-address"
    )
      return approveAddress(a, parts[2], body.reason);
    if (m === "GET" && parts[1] === "jobs")
      return db.job.findMany({
        where: req.nextUrl.searchParams.get("state")
          ? { state: req.nextUrl.searchParams.get("state")! }
          : {},
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    if (m === "POST" && parts[1] === "jobs" && parts[3] === "retry") {
      const j = await db.job.findUniqueOrThrow({ where: { id: parts[2] } });
      assert(
        ["dead", "retry"].includes(j.state),
        "JOB_STATE",
        "This job is not waiting for a manual retry.",
        409,
      );
      await audit(db, a.principal, "job.retry", j.id, {
        reason: body.reason || "Operator requested retry",
      });
      return db.job.update({
        where: { id: j.id },
        data: { state: "pending", nextRunAt: now(), error: null },
      });
    }
    if (m === "GET" && parts[1] === "audit" && parts.length === 2) {
      if (req.nextUrl.searchParams.get("format") === "csv") return new NextResponse(await auditCsv(a, req.nextUrl.searchParams), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=pawline-audit.csv", "Cache-Control": "private, no-store" } });
      return auditLog(a, req.nextUrl.searchParams);
    }
    if (m === "GET" && parts[1] === "simulator")
      return {
        paused: await setting("workerPaused", false),
        uploadFailure: await setting("uploadFailure", false),
        carts: await db.cart.findMany({
          where: { state: "open" },
          include: { lines: true },
          take: 100,
        }),
        receipts: await db.simReceipt.findMany({
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        attempts: await db.attempt.findMany({
          where: { status: { in: ["pending", "unknown"] } },
          take: 100,
        }),
        runs: await db.productionRun.findMany({
          where: {
            state: {
              in: ["submitting", "unknown", "accepted", "in_production"],
            },
          },
          take: 100,
        }),
        refunds: await db.refund.findMany({
          where: { status: { in: ["pending", "unknown"] } },
          take: 100,
        }),
      };
    if (m === "POST" && parts[1] === "simulator") {
      assert(
        body.reason?.trim(),
        "REASON",
        "Record the purpose of this simulator action.",
      );
      if (["workerPaused", "uploadFailure"].includes(body.action)) {
        await db.setting.upsert({
          where: { key: body.action },
          create: { key: body.action, value: body.value === true },
          update: { value: body.value === true },
        });
      } else if (body.action === "paymentScenario") {
        assert(
          ["success", "declined", "lost_response"].includes(body.scenario),
          "SCENARIO",
          "Choose a supported simulation.",
        );
        const cart = await db.cart.findUnique({ where: { id: body.cartId } });
        assert(
          cart && cart.state === "open",
          "CART",
          "Select an open cart.",
          409,
        );
        await db.setting.upsert({
          where: { key: "paymentScenario" },
          create: {
            key: "paymentScenario",
            value: json({ cartId: cart.id, scenario: body.scenario }),
          },
          update: { value: json({ cartId: cart.id, scenario: body.scenario }) },
        });
      } else throw Error("Unknown simulator operation");
      await audit(
        db,
        a.principal,
        "simulator.action",
        body.cartId || body.action,
        { action: body.action, reason: body.reason },
      );
      return { ok: true, eventId: ref("SIM") };
    }
  }
  return UNHANDLED;
}
