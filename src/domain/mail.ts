import nodemailer from "nodemailer";
import { db } from "../infra/db";
import { afterReceipt } from "./faults";
const smtp = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "127.0.0.1",
  port: Number(process.env.SMTP_PORT || 1025),
  secure: false,
  connectionTimeout: 5000,
  socketTimeout: 5000,
  disableFileAccess: true,
  disableUrlAccess: true,
});
export async function deliver(id: string) {
  const n = await db.notification.findUniqueOrThrow({ where: { id } });
  if (n.state === "sent") return;
  if (["sending", "unknown"].includes(n.state)) {
    const query = "message-id:" + n.messageId.replace(/[<>]/g, "");
    const r = await fetch(
      (process.env.MAILPIT_URL || "http://mailpit:8025") +
        "/api/v1/search?query=" +
        encodeURIComponent(query),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from("operator:" + process.env.MAIL_PASSWORD).toString(
              "base64",
            ),
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!r.ok) throw Error("MailReceiptUnknown");
    const inbox = await r.json();
    if (
      inbox.messages?.some(
        (m: any) => m.MessageID === n.messageId.replace(/[<>]/g, ""),
      )
    ) {
      await db.notification.update({
        where: { id },
        data: { state: "sent", sentAt: new Date() },
      });
      return;
    }
  }
  await db.notification.update({ where: { id }, data: { state: "sending" } });
  try {
    await smtp.sendMail({
      from: "Pawline Studio <studio@pawline.local>",
      to: n.to,
      subject: n.subject,
      html: n.html,
      messageId: n.messageId,
    });
    await afterReceipt("email", n.messageId);
    await db.notification.update({
      where: { id },
      data: { state: "sent", sentAt: new Date() },
    });
  } catch (e) {
    await db.notification.update({ where: { id }, data: { state: "unknown" } });
    throw e;
  }
}
