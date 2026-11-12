import { NextRequest, NextResponse } from "next/server";
import { db, json } from "@/infra/db";
import {
  auth,
  login,
  role,
  type Auth,
  orderAuth,
  grantOrder,
} from "@/domain/auth";
import {
  assert,
  DomainError,
  origin,
  ref,
  setting,
  hash,
  addMinutes,
  token,
  audit,
  limit,
} from "@/domain/common";
import {
  getCart,
  addCart,
  changeCart,
  quote,
  attempt,
  getAttempt,
} from "@/domain/checkout";
import {
  createDesign,
  getDesign,
  saveDesign,
  upload,
  sample,
  authorizedAsset,
  mediaRoot,
} from "@/domain/media";
import { issueGrant, notify } from "@/domain/notifications";
import fs from "node:fs/promises";
import { extraRoutes, UNHANDLED } from "@/domain/routes";
import { databaseSummary, databaseOrderTrace } from "@/domain/database";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function dispatch(req: NextRequest, parts: string[], a: Auth) {
  const route = parts.join("/"),
    method = req.method;
  let body: any = {};
  if (
    !["GET", "HEAD"].includes(method) &&
    !req.headers.get("content-type")?.includes("multipart/form-data")
  ) {
    assert(
      Number(req.headers.get("content-length") || 0) < 100000,
      "BODY_SIZE",
      "This request is too large.",
      413,
    );
    const raw = await bounded(req, 100000);
    try {
      body = JSON.parse(raw.toString() || "{}");
    } catch {
      assert(false, "JSON", "Use a valid JSON request.");
    }
    assert(body && typeof body === "object" && !Array.isArray(body), "JSON_OBJECT", "Use a JSON object for this request.");
  }
  if (
    method === "POST" &&
    (parts[0] === "auth" || route === "orders/lookup" || route === "contact")
  ) {
    await limit(route, a.principal, 20);
    if (body.email)
      await limit(
        route + ":email",
        String(body.email).trim().toLowerCase(),
        10,
      );
  }
  if (method === "GET" && route === "bootstrap")
    return {
      user: { id: a.userId, role: a.role, name: a.name, email: a.email },
      csrf: a.csrf,
      analytics: a.analytics,
      cart: await getCart(a),
    };
  if (method === "GET" && route === "products") {
    const q = (req.nextUrl.searchParams.get("q") || "").slice(0, 100),
      category = req.nextUrl.searchParams.get("category");
    return db.product.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { subtitle: { contains: q, mode: "insensitive" } },
                { kind: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { variants: true },
      orderBy: { id: "asc" },
    });
  }
  if (method === "GET" && parts[0] === "products") {
    const p = await db.product.findUnique({
      where: { slug: parts[1] },
      include: { variants: true },
    });
    assert(p, "NOT_FOUND", "This item was not found.", 404);
    return p;
  }
  if (parts[0] === "auth") {
    if (method === "POST" && ["login", "register"].includes(parts[1])) {
      const result = await login(a, body, parts[1] === "register");
      a.cookie = result.cookie;
      return { csrf: result.csrf, user: result.user };
    }
    if (method === "POST" && parts[1] === "logout") {
      await db.session.delete({ where: { id: a.sessionId } });
      a.cookie = "";
      return { ok: true };
    }
  }
  if (method === "POST" && route === "preferences") {
    await db.session.update({
      where: { id: a.sessionId },
      data: {
        analytics: body.analytics === true,
        attribution: body.analytics ? json(a.attribution) : {},
      },
    });
    return { ok: true };
  }
  if (method === "POST" && route === "events") {
    if (!a.analytics || ["owner", "designer"].includes(a.role))
      return { accepted: false };
    assert(
      [
        "landing",
        "view_product",
        "upload_started",
        "upload_succeeded",
        "design_ready",
        "add_to_cart",
        "checkout_started",
      ].includes(body.kind),
      "EVENT",
      "Unsupported event.",
    );
    const attribution = Object.keys(a.attribution).length
      ? a.attribution
      : body.utm
        ? {
            source: String(body.utm.source || "direct").slice(0, 100),
            medium: String(body.utm.medium || "").slice(0, 100),
            campaign: String(body.utm.campaign || "").slice(0, 100),
          }
        : a.attribution;
    await db.event.upsert({
      where: { eventId: String(body.eventId).slice(0, 128) },
      create: {
        eventId: String(body.eventId).slice(0, 128),
        kind: body.kind,
        actor: a.principal,
        objectId: body.productId || null,
        source: a.source,
        data: json({ session: a.sessionId, attribution }),
      },
      update: {},
    });
    if (!Object.keys(a.attribution).length)
      await db.session.update({
        where: { id: a.sessionId },
        data: { attribution: json(attribution) },
      });
    return { accepted: true };
  }
  if (method === "POST" && route === "designs")
    return createDesign(a, body.variantId);
  if (parts[0] === "designs" && parts[1]) {
    if (method === "GET") return getDesign(a, parts[1]);
    if (method === "PATCH")
      return saveDesign(a, parts[1], body.version, body.data);
  }
  if (method === "POST" && route === "assets/sample")
    return sample(a, body.pet, body.view);
  if (method === "POST" && route === "assets") {
    await limit("upload", a.principal, 30);
    const content = await bounded(req, 13 * 1024 * 1024);
    const form = await new Response(new Uint8Array(content), {
      headers: { "Content-Type": req.headers.get("content-type")! },
    }).formData();
    const file = form.get("file");
    assert(file instanceof File, "FILE", "Choose an image to upload.");
    return upload(a, Buffer.from(await file.arrayBuffer()), file.type);
  }
  if (method === "GET" && parts[0] === "media") {
    const { asset, data } = await authorizedAsset(a, parts[1]);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": asset.mime,
        "Cache-Control": "private,no-store",
        "Content-Disposition": req.nextUrl.searchParams.has("download")
          ? `attachment; filename="pawline-${asset.kind}.png"`
          : "inline",
      },
    });
  }
  if (route === "cart" && method === "GET") return getCart(a);
  if (route === "cart/lines" && method === "POST")
    return addCart(a, body.designId, Number(body.quantity), body.replaceId);
  if (parts[0] === "cart" && parts[1] === "lines" && parts[2]) {
    if (method === "PATCH" || method === "DELETE")
      return changeCart(
        a,
        parts[2],
        method === "DELETE" ? null : Number(body.quantity),
      );
    if (method === "POST" && parts[3] === "edit") {
      const c = await getCart(a);
      const l = c.lines.find((l) => l.id === parts[2]);
      assert(l?.revision, "NOT_FOUND", "Bag item unavailable.", 404);
      const d = await createDesign(a, l.variantId);
      await db.design.update({
        where: { id: d.id },
        data: {
          data: json(l.revision.data),
          previewId: l.revision.previewId,
          productionId: l.revision.productionId,
        },
      });
      return { id: d.id };
    }
  }
  if (method === "POST" && route === "checkout/quote") return quote(a, body);
  if (method === "POST" && route === "checkout/attempts")
    return attempt(
      a,
      body.quoteId,
      req.headers.get("idempotency-key") || "",
      body.expectedCartVersion,
      body.scenario || "success",
    );
  if (method === "GET" && route === "checkout/recovery") {
    const key = req.nextUrl.searchParams.get("key") || "";
    const at = await db.attempt.findUnique({
      where: { principal_key: { principal: a.principal, key } },
    });
    assert(
      at,
      "NOT_FOUND",
      "No accepted payment request was found. Review your quote before trying again.",
      404,
    );
    return getAttempt(a, at.id);
  }
  if (method === "GET" && parts[0] === "checkout" && parts[1] === "attempts")
    return getAttempt(a, parts[2]);
  if (method === "GET" && route === "account") {
    assert(a.userId, "LOGIN_REQUIRED", "Sign in to see your account.", 401);
    return {
      orders: await db.order.findMany({
        where: { principal: a.principal },
        orderBy: { paidAt: "desc" },
        take: 100,
      }),
      designs: await db.design.findMany({
        where: { owner: a.principal },
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
    };
  }
  if (method === "GET" && route === "drafts")
    return db.design.findMany({
      where: { owner: a.principal },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  if (method === "GET" && parts[0] === "order-access") {
    const grant = await grantOrder(a, parts[1]);
    return db.order.findUnique({
      where: { id: grant.scope },
      select: { ref: true },
    });
  }
  if (method === "GET" && parts[0] === "orders" && parts[1]) {
    const o = await db.order.findUnique({
      where: { ref: parts[1] },
      include: {
        lines: {
          include: { proofs: { orderBy: { version: "desc" } }, runs: true },
        },
        refunds: { include: { allocations: true } },
        shipments: { include: { items: true } },
      },
    });
    assert(o, "NOT_FOUND", "Order unavailable.", 404);
    await orderAuth(a, o.id);
    const lines = await Promise.all(
      o.lines.map(async (l) => ({
        ...l,
        revision: await db.revision.findUnique({ where: { id: l.revisionId } }),
      })),
    );
    return {
      ...o,
      lines,
      dateProposals: await db.ticket.findMany({
        where: { orderId: o.id, kind: "date_change" },
        orderBy: { createdAt: "desc" },
      }),
      refunded: o.refunds
        .filter((r) => r.status === "succeeded")
        .reduce((n, r) => n + r.amount, 0),
    };
  }
  if (method === "POST" && route === "orders/lookup") {
    const found = await db.order.findMany({
      where: {
        email: String(body.email || "")
          .trim()
          .toLowerCase(),
        ...(body.ref ? { ref: body.ref } : {}),
      },
      take: 10,
    });
    for (const o of found) {
      const raw = await issueGrant(db, "order", o.id, o.email);
      await notify(
        db,
        ref("lookup"),
        o.email,
        "Your private order link",
        `Open order ${o.ref} using this private link.`,
        `${origin()}/order-access/${raw}`,
      );
    }
    return {
      message:
        "If matching orders exist, a private link has been sent to the recorded email address.",
    };
  }
  if (method === "POST" && route === "contact") {
    assert(
      typeof body.email === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email),
      "EMAIL",
      "Enter a valid email.",
    );
    assert(
      body.message?.trim() && body.subject?.trim(),
      "MESSAGE",
      "Add a subject and message.",
    );
    return db.ticket.create({
      data: {
        ref: ref("HELP"),
        principal: a.principal,
        email: body.email,
        subject: String(body.subject).slice(0, 150),
        messages: json([
          {
            by: "customer",
            text: String(body.message).slice(0, 5000),
            at: new Date().toISOString(),
          },
        ]),
      },
    });
  }
  const extra = await extraRoutes(req, parts, a, body);
  if (extra !== UNHANDLED) return extra;
  if (parts[0] === "admin") {
    role(a, "owner");
    if (method === "GET" && route === "admin/database") return databaseSummary(a);
    if (method === "GET" && parts.length === 4 && parts[1] === "database" && parts[2] === "orders") return databaseOrderTrace(a, parts[3]);
    if (method === "GET" && parts[1] === "orders" && req.nextUrl.searchParams.has('page')) {
      const page=Math.max(0,Math.min(10000,Math.floor(Number(req.nextUrl.searchParams.get('page'))||0)));
      const search=(req.nextUrl.searchParams.get('q')||'').slice(0,100), status=req.nextUrl.searchParams.get('status');
      const where={...(search?{ref:{contains:search,mode:'insensitive' as const}}:{}),...(status==='design'?{lines:{some:{state:'awaiting_design'}}}:status==='refunds'?{refunds:{some:{}}}:{})};
      const [items,total,payments,refunds]=await Promise.all([
        db.order.findMany({where,orderBy:[{paidAt:'desc'},{id:'desc'}],skip:page*50,take:50,include:{lines:true,refunds:true}}),
        db.order.count({where}),db.order.aggregate({where,_sum:{total:true}}),
        db.refund.aggregate({where:{status:'succeeded',order:where},_sum:{amount:true}}),
      ]);
      return {items,total,page,pageCount:Math.max(1,Math.ceil(total/50)),payments:payments._sum.total||0,refunds:refunds._sum.amount||0};
    }
    if (method === "GET" && parts[1] === "orders")
      return db.order.findMany({
        orderBy: { paidAt: "desc" },
        take: 100,
        include: { lines: true, refunds: true },
      });
  }
  throw new DomainError("NOT_FOUND", "This action is unavailable.", 404);
}
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const start = Date.now();
  const parts = (await params).path;
  let a: Auth | undefined;
  let response: NextResponse;
  try {
    if (parts.join("/") === "health/live")
      return NextResponse.json({ status: "alive" });
    if (parts.join("/") === "health/ready") {
      await db.$queryRaw`SELECT 1`;
      await db.product.count();
      await fs.mkdir(mediaRoot(), { recursive: true });
      await fs.access(mediaRoot());
      return NextResponse.json({ status: "ready" });
    }
    a = await auth();
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      assert(
        req.headers.get("origin") === origin(),
        "ORIGIN",
        "This request came from an unrecognized origin.",
        403,
      );
      assert(
        req.headers.get("x-csrf-token") === a.csrf,
        "CSRF",
        "Your session changed. Refresh and try again.",
        403,
      );
      assert(
        !(await setting("maintenance", false)),
        "MAINTENANCE",
        "The studio is taking a consistent backup. Please try again shortly.",
        503,
      );
    }
    const result = await dispatch(req, parts, a);
    response =
      result instanceof NextResponse
        ? result
        : NextResponse.json(result, {
            status: req.method === "POST" ? 200 : 200,
          });
  } catch (e) {
    const d =
      e instanceof DomainError
        ? e
        : new DomainError(
            "UNAVAILABLE",
            "The service is temporarily unavailable. Your saved data is safe; please retry.",
            503,
          );
    if (!(e instanceof DomainError))
      console.error("request failed", e instanceof Error ? e.name : "unknown");
    response = NextResponse.json(
      {
        error: { code: d.code, message: d.message, retryable: d.status >= 500 },
        requestId: ref("REQ"),
      },
      { status: d.status },
    );
  }
  response.headers.set("Cache-Control", "private,no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (a?.cookie !== undefined)
    response.cookies.set("pawline_session", a.cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: origin().startsWith("https:"),
      path: "/",
      maxAge: a.cookie ? 60 * 60 * 24 * 30 : 0,
    });
  if (!["media", "events", "health"].includes(parts[0]))
    db.requestMetric
      .create({
        data: {
          route: `/${parts[0]}/${parts[1] ? "resource" : ""}`,
          status: response.status,
          duration: Date.now() - start,
        },
      })
      .catch(() => {});
  return response;
}
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };

async function bounded(req: NextRequest, max: number) {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) {
      await reader.cancel();
      assert(false, "BODY_SIZE", "This request is too large.", 413);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}
