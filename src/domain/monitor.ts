import fs from "node:fs/promises";
import path from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { db, json } from "../infra/db";
import { assert, now, setting, ref } from "./common";
import { mediaRoot } from "./media";
import { type Auth, role } from "./auth";
import { allocate, halfUp } from "./money";
export const timezone = "America/Los_Angeles";
export function dateWindow(start?: string, end?: string) {
  const today = Temporal.Now.zonedDateTimeISO(timezone).toPlainDate();
  const from = start
    ? Temporal.PlainDate.from(start)
    : today.subtract({ days: 30 });
  const through = end ? Temporal.PlainDate.from(end) : today;
  const a = from.toZonedDateTime({ timeZone: timezone, plainTime: "00:00" });
  const b = through
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: timezone, plainTime: "00:00" });
  return {
    start: new Date(Number(a.epochMilliseconds)),
    end: new Date(Number(b.epochMilliseconds)),
  };
}
async function alert(fingerprint: string, message: string, active: boolean) {
  const existing = await db.alert.findFirst({
    where: { fingerprint, resolvedAt: null },
  });
  if (active && !existing) {
    try {
      await db.alert.create({ data: { fingerprint, message } });
    } catch {}
  } else if (!active && existing)
    await db.alert.update({
      where: { id: existing.id },
      data: { resolvedAt: now() },
    });
}
let probeInProgress = false;
let gapSince: Date | null = null;
export async function healthProbe() {
  if (probeInProgress) return;
  probeInProgress = true;
  try {
    await db.$queryRaw`SELECT 1`;
    if (gapSince) {
      await db.event.create({
        data: {
          eventId: ref("GAP"),
          actor: "monitor",
          kind: "monitor.observation_gap",
          data: json({ from: gapSince.toISOString(), to: now().toISOString() }),
        },
      });
      gapSince = null;
    }
    const h = await db.heartbeat.findMany();
    const stale =
      !h.length || h.every((b) => now().getTime() - b.at.getTime() > 30000);
    await alert(
      "worker-stale",
      "Worker heartbeat is stale. Check the worker process and reconcile pending receipts.",
      stale,
    );
    const dead = await db.job.count({ where: { state: "dead" } });
    await alert(
      "dead-jobs",
      "One or more jobs require operator attention.",
      dead > 0,
    );
    const unknown = await db.productionRun.count({
      where: { state: "unknown" },
    });
    await alert(
      "factory-unknown",
      "A factory receipt is unknown. Reconcile by its stable external reference.",
      unknown > 0,
    );
    const oldest = await db.job.findFirst({
      where: { state: { in: ["pending", "retry"] }, nextRunAt: { lte: now() } },
      orderBy: { createdAt: "asc" },
    });
    await alert(
      "queue-aged",
      "An executable task has waited over 60 seconds.",
      !!oldest && now().getTime() - oldest.createdAt.getTime() > 60000,
    );
    let media = true;
    try {
      const f = path.join(mediaRoot(), ".probe-" + ref("FS"));
      await fs.writeFile(f, "probe");
      await fs.readFile(f);
      await fs.unlink(f);
      if (await setting("uploadFailure", false)) media = false;
    } catch {
      media = false;
    }
    await alert(
      "media-unavailable",
      "Private media storage is unavailable or the operator upload-failure scenario is active.",
      !media,
    );
    let mail = true;
    try {
      const r = await fetch(
        (process.env.MAILPIT_URL || "http://mailpit:8025") +
          "/api/v1/messages?limit=1",
        {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from("operator:" + process.env.MAIL_PASSWORD).toString(
                "base64",
              ),
          },
          signal: AbortSignal.timeout(2000),
        },
      );
      mail = r.ok;
    } catch {
      mail = false;
    }
    await alert(
      "mail-unavailable",
      "Local Mailpit is unavailable. Accepted notifications remain queued.",
      !mail,
    );
    await db.setting.upsert({
      where: { key: "healthSnapshot" },
      create: {
        key: "healthSnapshot",
        value: json({
          asOf: now(),
          media,
          mail,
          worker: stale
            ? "stale"
            : (await setting("workerPaused", false))
              ? "paused"
              : "running",
        }),
      },
      update: {
        value: json({
          asOf: now(),
          media,
          mail,
          worker: stale
            ? "stale"
            : (await setting("workerPaused", false))
              ? "paused"
              : "running",
        }),
      },
    });
  } catch {
    if (!gapSince) gapSince = now();
  } finally {
    probeInProgress = false;
  }
}
export async function metrics(a: Auth, params: URLSearchParams) {
  role(a, "owner");
  let window;
  try {
    window = dateWindow(
      params.get("start") || undefined,
      params.get("end") || undefined,
    );
  } catch {
    assert(false, "DATE", "Choose valid dates.");
  }
  const source = params.get("source") || "demo",
    sku = params.get("sku") || "",
    channel = params.get("channel") || "",
    mode = params.get("mode") || "transaction";
  const orders = await db.order.findMany({
    where: { ...(source === "all" ? {} : { source }) },
    include: {
      lines: { include: { runs: true } },
      refunds: { include: { allocations: true } },
      shipments: { include: { items: true } },
    },
  });
  const receipts = await db.simReceipt.findMany({
    where: { type: { in: ["capture", "refund"] }, state: "succeeded" },
  });
  const filtered = orders.filter(
    (o) =>
      (!channel || ((o.attribution as any).source || "unknown") === channel) &&
      (!sku || o.lines.some((l) => l.variantId === sku)),
  );
  let gross = 0,
    refunds = 0,
    netMerch = 0,
    tax = 0,
    shipping = 0,
    discount = 0,
    productionCost = 0,
    shippingCost = 0,
    designCost = 0,
    paymentFees = 0;
  const capturedOrderIds = new Set<string>(),
    refundOrderIds = new Set<string>();
  let aovSum = 0,
    missingMinutes = 0;
  const inWindow = (d: Date) => d >= window.start && d < window.end;
  const laborEvents = await db.event.findMany({
    where: { kind: "design.draft_saved" },
    orderBy: { createdAt: "desc" },
  });
  const records: any[] = [];
  for (const o of filtered) {
    const selected = o.lines.filter((l) => !sku || l.variantId === sku);
    const stable = [...o.lines].sort((a, b) =>
      (a.snapshot as any).id.localeCompare((b.snapshot as any).id),
    );
    const shippingShares = allocate(
      o.shipping,
      stable.map((l) => l.net),
    );
    const feeShares = allocate(
      halfUp(o.total * 27, 1000) + 30,
      stable.map((l) => l.net),
    );
    const ship = selected.reduce(
      (n, l) =>
        n +
        ((l.snapshot as any).shippingAllocation ??
          shippingShares[stable.findIndex((x) => x.id === l.id)]),
      0,
    );
    const fee = selected.reduce(
      (n, l) =>
        n +
        ((l.snapshot as any).paymentFeeAllocation ??
          feeShares[stable.findIndex((x) => x.id === l.id)]),
      0,
    );
    const capture = receipts.find(
      (r) =>
        r.type === "capture" && (r.payload as any).attemptId === o.attemptId,
    );
    const captureMatches =
      !!capture &&
      (mode === "cohort" ? inWindow(o.paidAt) : inWindow(capture.createdAt));
    const relatedRefunds = o.refunds.filter(
      (r) =>
        r.status === "succeeded" &&
        (mode === "cohort"
          ? inWindow(o.paidAt)
          : !!r.succeededAt && inWindow(r.succeededAt)),
    );
    const matchedRefunds = relatedRefunds.flatMap((r) =>
      r.allocations.filter((x) => selected.some((l) => l.id === x.lineId)),
    );
    if (captureMatches) {
      capturedOrderIds.add(o.id);
      const merchandise = selected.reduce((n, l) => n + l.net, 0),
        lineTax = selected.reduce((n, l) => n + l.tax, 0);

      gross += merchandise + lineTax + ship;
      netMerch += merchandise;
      tax += lineTax;
      shipping += ship;
      discount += selected.reduce(
        (n, l) => n + (l.snapshot as any).discount,
        0,
      );
      aovSum += sku ? merchandise : o.subtotal - o.discount;
      paymentFees += fee;
    }
    for (const l of selected) {
      const labor = laborEvents.find((e) => e.objectId === l.id);
      if (
        mode === "cohort"
          ? inWindow(o.paidAt)
          : labor && inWindow(labor.createdAt)
      ) {
        if (l.minutes === null) missingMinutes++;
        else designCost += l.minutes * 40;
      } else if (captureMatches && l.minutes === null) missingMinutes++;
      for (const r of l.runs)
        if (
          r.acceptedAt &&
          (mode === "cohort" ? inWindow(o.paidAt) : inWindow(r.acceptedAt))
        )
          productionCost += r.cost;
    }
    for (const shipment of o.shipments) {
      const first = (shipment.events as any[]).find((e) =>
        ["shipped", "in_transit", "delivered"].includes(e.state),
      );
      if (
        first &&
        (mode === "cohort" ? inWindow(o.paidAt) : inWindow(new Date(first.at)))
      )
        shippingCost += shipment.items
          .filter((i) => selected.some((l) => l.id === i.lineId))
          .reduce((n, i) => n + i.costAllocation, 0);
    }
    if (matchedRefunds.length) {
      refundOrderIds.add(o.id);
      for (const r of matchedRefunds) {
        refunds += r.net + r.tax + r.shipping;
        netMerch -= r.net;
        tax -= r.tax;
        shipping -= r.shipping;
      }
    }
    if (captureMatches || matchedRefunds.length)
      records.push({
        ref: o.ref,
        paidAt: o.paidAt,
        source: o.source,
        channel: (o.attribution as any).source || "unknown",
        captured: captureMatches
          ? selected.reduce((n, l) => n + l.net + l.tax, 0) + ship
          : 0,
        refunded: matchedRefunds.reduce(
          (n, x) => n + x.net + x.tax + x.shipping,
          0,
        ),
        lineIds: selected.map((l) => l.id),
      });
  }
  const visitKinds = [
    "landing",
    "view_product",
    "upload_started",
    "upload_succeeded",
    "design_ready",
    "add_to_cart",
    "checkout_started",
    "purchase",
  ];
  const visits = await db.event.findMany({
    where: {
      kind: { in: visitKinds },
      createdAt: { gte: window.start, lt: window.end },
      ...(source === "all" ? {} : { source }),
    },
    orderBy: { createdAt: "asc" },
    take: 50000,
  });
  const productId = sku
    ? (await db.variant.findUnique({ where: { id: sku } }))?.productId
    : null;
  const productSessions = new Set(
    visits
      .filter((e) => e.objectId === productId)
      .map((e) => (e.data as any).session),
  );
  const eligible = visits.filter(
    (e) =>
      (!sku || productSessions.has((e.data as any).session)) &&
      (!channel ||
        ((e.data as any).attribution?.source || "unknown") === channel),
  );
  const sessions = new Set(eligible.map((e) => (e.data as any).session));
  const funnelStages = [
    "landing",
    "view_product",
    "upload_succeeded",
    "design_ready",
    "add_to_cart",
    "checkout_started",
  ];
  const bySession = new Map<string, typeof eligible>();
  for (const e of eligible) {
    const id = (e.data as any).session;
    bySession.set(id, [...(bySession.get(id) || []), e]);
  }
  const funnel = funnelStages.map((kind, index) => ({
    kind,
    count: [...bySession.values()].filter((es) => {
      let pos = 0;
      for (let i = 0; i <= index; i++) {
        const j = es.findIndex(
          (e, k) => k >= pos && e.kind === funnelStages[i],
        );
        if (j < 0) return false;
        pos = j + 1;
      }
      return true;
    }).length,
  }));
  const active = new Set(
    eligible
      .filter((e) => e.createdAt.getTime() >= now().getTime() - 300000)
      .map((e) => (e.data as any).session),
  ).size;
  const lines = filtered
    .filter((o) => inWindow(o.paidAt))
    .flatMap((o) => o.lines.filter((l) => !sku || l.variantId === sku));
  const counts: Record<string, number> = {};
  for (const l of lines)
    counts[l.state] =
      (counts[l.state] || 0) + Math.max(0, l.quantity - l.canceled);
  const jobs = await db.job.groupBy({ by: ["state"], _count: { _all: true } });
  const h = await db.heartbeat.findMany();
  const health = await setting<any>("healthSnapshot", {});
  const reqs = await db.requestMetric.findMany({
    where: { createdAt: { gte: new Date(now().getTime() - 300000) } },
    select: { duration: true, status: true },
    take: 20000,
  });
  const durations = reqs.map((r) => r.duration).sort((a, b) => a - b);
  const alerts = await db.alert.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const lastMail = await db.notification.findFirst({
    where: { state: "sent" },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });
  return {
    asOf: now().toISOString(),
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    timezone,
    source,
    filters: { sku, channel, mode },
    sampleSize: records.length,
    status: "ok",
    data: {
      finance: {
        orders: capturedOrderIds.size,
        refundOrders: refundOrderIds.size,
        gross,
        refunds,
        net: gross - refunds,
        netMerch,
        tax,
        shipping,
        discount,
        aov: capturedOrderIds.size
          ? Math.round(aovSum / capturedOrderIds.size)
          : null,
        productionCost,
        shippingCost,
        designCost,
        paymentFees,
        contribution:
          netMerch +
          shipping -
          productionCost -
          shippingCost -
          designCost -
          paymentFees,
        costStatus: missingMinutes ? "incomplete" : "estimated",
        missingMinutes,
      },
      records,
      traffic: {
        active,
        observableSessions: sessions.size,
        conversion: funnel[0].count
          ? funnel.at(-1)!.count / funnel[0].count
          : null,
        funnel,
        scope:
          "Only sessions that opted in; no denominator is inferred for people who declined.",
      },
      operations: counts,
      system: {
        scope: "Global system health · not filtered by SKU/source/date",
        health,
        heartbeats: h,
        jobs: jobs.map((j) => ({ state: j.state, count: j._count._all })),
        requests: reqs.length,
        errors: reqs.filter((r) => r.status >= 500).length,
        p95: durations.length
          ? durations[
              Math.min(
                durations.length - 1,
                Math.ceil(durations.length * 0.95) - 1,
              )
            ]
          : null,
        lastMail: lastMail?.sentAt || null,
        window: "last 5 minutes",
      },
      alerts,
    },
  };
}
export function csvCell(value: unknown) {
  const s = String(value ?? "");
  return (
    '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
  );
}
export async function exportCsv(a: Auth, params: URLSearchParams) {
  const m = await metrics(a, params);
  const rows = [
    [
      "order",
      "paid_at_utc",
      "source",
      "channel",
      "captured_cents",
      "refunded_cents",
      "net_cents",
    ],
    ...m.data.records.map((r) => [
      r.ref,
      new Date(r.paidAt).toISOString(),
      r.source,
      r.channel,
      r.captured,
      r.refunded,
      r.captured - r.refunded,
    ]),
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
