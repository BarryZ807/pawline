import { db, json, type Store } from "../infra/db";
import { token, hash, addMinutes, enqueue, escapeHtml, origin } from "./common";
export async function issueGrant(
  tx: Store,
  purpose: string,
  scope: string,
  email: string,
  version?: number,
) {
  const raw = token();
  await tx.grant.create({
    data: {
      tokenHash: hash(raw),
      purpose,
      scope,
      email,
      version,
      expiresAt: addMinutes(purpose === "reset" ? 30 : 60 * 48),
    },
  });
  return raw;
}
export async function notify(
  tx: Store,
  key: string,
  to: string,
  subject: string,
  copy: string,
  url?: string,
) {
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#173a2e;background:#f5f3eb;padding:40px"><p style="letter-spacing:3px">PAWLINE GOLF STUDIO</p><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(copy)}</p>${url ? `<p><a href="${escapeHtml(url)}" style="background:#173a2e;color:#fff;padding:14px 22px;display:inline-block">Open your private page</a></p>` : ""}<p style="font-size:12px">Local demo · simulated payment/fulfillment. This message stays in your local inbox.</p></body></html>`;
  const n = await tx.notification.upsert({
    where: { key },
    create: {
      key,
      to,
      subject,
      html,
      messageId: `<${hash(key)}@pawline.local>`,
    },
    update: {},
  });
  await enqueue(tx, `email:${n.id}`, "email", { notificationId: n.id });
  return n;
}
export async function orderNotice(
  tx: Store,
  order: { id: string; email: string; ref: string },
  key: string,
  subject: string,
  copy: string,
) {
  const raw = await issueGrant(tx, "order", order.id, order.email);
  return notify(
    tx,
    key,
    order.email,
    subject,
    copy,
    `${origin()}/order-access/${raw}`,
  );
}
