import { cookies } from "next/headers";
import { db, json, transaction, lock } from "../infra/db";
import {
  assert,
  token,
  hash,
  addMinutes,
  email,
  passwordValid,
  passwordHash,
  audit,
} from "./common";
export type Auth = {
  sessionId: string;
  principal: string;
  userId: string | null;
  role: string;
  name: string;
  email: string;
  csrf: string;
  analytics: boolean;
  source: string;
  attribution: Record<string, string>;
  cookie?: string;
};
export async function auth(): Promise<Auth> {
  const jar = await cookies();
  const raw = jar.get("pawline_session")?.value;
  let session = raw
    ? await db.session.findUnique({ where: { tokenHash: hash(raw) } })
    : null;
  let cookie: string | undefined;
  if (!session || session.expiresAt < new Date()) {
    cookie = token();
    session = await db.session.create({
      data: {
        tokenHash: hash(cookie),
        principal: "guest_" + token(),
        csrf: token(),
        source: process.env.DATA_SOURCE === "test" ? "test" : "demo",
        expiresAt: addMinutes(60 * 24 * 30),
      },
    });
  }
  const user = session.userId
    ? await db.user.findUnique({ where: { id: session.userId } })
    : null;
  return {
    sessionId: session.id,
    principal: session.principal,
    userId: session.userId,
    role: user?.role || "guest",
    name: user?.name || "",
    email: user?.email || "",
    csrf: session.csrf,
    analytics: session.analytics,
    attribution: session.attribution as Record<string, string>,
    source: session.source,
    cookie,
  };
}
export function role(a: Auth, ...roles: string[]) {
  assert(
    roles.includes(a.role),
    "FORBIDDEN",
    "This area is available to authorized staff.",
    403,
  );
}
export async function orderAllowed(a: Auth, orderId: string) {
  const o = await db.order.findUnique({ where: { id: orderId } });
  if (!o) return false;
  if (a.role === "owner" || o.principal === a.principal) return true;
  const grant = await db.orderAccess.findUnique({
    where: { sessionId_orderId: { sessionId: a.sessionId, orderId } },
  });
  return !!grant && grant.expiresAt > new Date();
}
export async function orderAuth(a: Auth, orderId: string) {
  assert(
    await orderAllowed(a, orderId),
    "NOT_FOUND",
    "This order is unavailable. Request a new access link.",
    404,
  );
}
export async function login(
  a: Auth,
  body: { email: string; password: string; name?: string },
  register = false,
) {
  assert(
    typeof body.email === "string" && typeof body.password === "string",
    "LOGIN",
    "Enter your email and password.",
  );
  const normalized = email(body.email);
  assert(
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized),
    "EMAIL",
    "Enter a valid email.",
  );
  let user = await db.user.findUnique({ where: { email: normalized } });
  if (register) {
    assert(
      body.password.length >= 10 && body.password.length <= 128,
      "PASSWORD",
      "Use 10–128 characters for your password.",
    );
    assert(
      !user,
      "REGISTER",
      "An account could not be created. Try sign in or password reset.",
      409,
    );
    user = await db.user.create({
      data: {
        email: normalized,
        name: (body.name || "Pet lover").slice(0, 80),
        passwordHash: passwordHash(body.password),
        role: "buyer",
      },
    });
  } else
    assert(
      user &&
        body.password.length <= 128 &&
        passwordValid(body.password, user.passwordHash),
      "LOGIN",
      "Email or password did not match.",
      401,
    );
  const u = user!;
  const cookie = token();
  const next = await transaction(async (tx) => {
    const oldCart = await tx.cart.findFirst({
      where: { principal: a.principal, state: { in: ["open", "processing"] } },
    });
    const newCart = await tx.cart.findFirst({
      where: { principal: u.id, state: { in: ["open", "processing"] } },
    });
    if (oldCart && oldCart.id !== newCart?.id) {
      for (const c of [oldCart, newCart]
        .filter(Boolean)
        .sort((x, y) => x!.id.localeCompare(y!.id)))
        await lock(tx, "Cart", c!.id);
      assert(
        oldCart.state === "open" && (!newCart || newCart.state === "open"),
        "CHECKOUT_IN_PROGRESS",
        "Finish checking payment status before signing in.",
        409,
      );
      if (newCart) {
        await tx.cartLine.updateMany({
          where: { cartId: oldCart.id },
          data: { cartId: newCart.id },
        });
        await tx.cart.update({
          where: { id: newCart.id },
          data: { version: { increment: 1 } },
        });
        await tx.cart.update({
          where: { id: oldCart.id },
          data: { state: "merged" },
        });
      } else
        await tx.cart.update({
          where: { id: oldCart.id },
          data: { principal: u.id },
        });
    }
    await tx.design.updateMany({
      where: { owner: a.principal },
      data: { owner: u.id },
    });
    await tx.asset.updateMany({
      where: { owner: a.principal },
      data: { owner: u.id },
    });
    await tx.session.delete({ where: { id: a.sessionId } });
    await audit(
      tx,
      u.id,
      register ? "account.registered" : "account.login",
      u.id,
    );
    return tx.session.create({
      data: {
        tokenHash: hash(cookie),
        principal: u.id,
        userId: u.id,
        csrf: token(),
        analytics: a.analytics,
        attribution: json(a.attribution),
        expiresAt: addMinutes(60 * 24 * 30),
      },
    });
  });
  return {
    cookie,
    csrf: next.csrf,
    user: { name: u.name, email: u.email, role: u.role },
  };
}
export async function grantOrder(a: Auth, raw: string, purpose = "order") {
  const g = await db.grant.findUnique({ where: { tokenHash: hash(raw) } });
  assert(
    g && g.purpose === purpose && !g.revokedAt && g.expiresAt > new Date(),
    "LINK_EXPIRED",
    "This link has expired or was replaced. Request a fresh link.",
    410,
  );
  await db.orderAccess.upsert({
    where: { sessionId_orderId: { sessionId: a.sessionId, orderId: g.scope } },
    create: {
      sessionId: a.sessionId,
      orderId: g.scope,
      expiresAt: addMinutes(120),
    },
    update: { expiresAt: addMinutes(120) },
  });
  return g;
}
