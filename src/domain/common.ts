import { Temporal } from "@js-temporal/polyfill";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { db, json, type Store } from "../infra/db";
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function assert(
  ok: unknown,
  code: string,
  message: string,
  status = 422,
): asserts ok {
  if (!ok) throw new DomainError(code, message, status);
}
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const ref = (prefix: string) =>
  `${prefix}-${randomBytes(5).toString("hex").toUpperCase()}`;
export const passwordHash = (p: string) => {
  const salt = token();
  return salt + ":" + scryptSync(p, salt, 64).toString("hex");
};
export const passwordValid = (p: string, stored: string) => {
  const [salt, h] = stored.split(":");
  const value = scryptSync(p, salt, 64);
  return h?.length === 128 && timingSafeEqual(value, Buffer.from(h, "hex"));
};
export const email = (s: string) => s.trim().toLowerCase();
export const now = () =>
  process.env.NODE_ENV === "test" && process.env.TEST_NOW
    ? new Date(process.env.TEST_NOW)
    : new Date();
export const addMinutes = (n: number) => new Date(now().getTime() + n * 60000);
export const businessDays = (date: Date, n: number) => {
  let day = Temporal.Instant.from(date.toISOString()).toZonedDateTimeISO(
    "America/Los_Angeles",
  );
  while (n > 0) {
    day = day.add({ days: 1 });
    if (day.dayOfWeek <= 5) n--;
  }
  return new Date(day.epochMilliseconds);
};
export const safeText = (s: unknown, max = 1000) => {
  assert(typeof s === "string", "TEXT_REQUIRED", "Please enter text.");
  return s.trim().slice(0, max);
};
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const origin = () =>
  process.env.APP_PUBLIC_ORIGIN || "http://127.0.0.1:3000";
export async function setting<T>(
  key: string,
  fallback: T,
  tx: Store = db,
): Promise<T> {
  return ((await tx.setting.findUnique({ where: { key } }))?.value ??
    fallback) as T;
}
export async function audit(
  tx: Store,
  actor: string,
  kind: string,
  objectId: string,
  data: unknown = {},
) {
  return tx.event.create({
    data: { eventId: ref("EV"), kind, actor, objectId, data: json(data) },
  });
}
export async function enqueue(
  tx: Store,
  effectKey: string,
  kind: string,
  payload: unknown,
) {
  return tx.job.upsert({
    where: { effectKey },
    create: { effectKey, kind, payload: json(payload) },
    update: {},
  });
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const contentHash = (value: unknown) => hash(canonical(value));

export async function limit(
  scope: string,
  identity: string,
  maximum = 10,
  seconds = 60,
) {
  const id = hash(scope + ":" + identity);
  const result = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO "RateLimit" (id,count,"resetsAt") VALUES (${id},1,NOW()+${seconds}*interval '1 second') ON CONFLICT(id) DO UPDATE SET count=CASE WHEN "RateLimit"."resetsAt"<NOW() THEN 1 ELSE "RateLimit".count+1 END,"resetsAt"=CASE WHEN "RateLimit"."resetsAt"<NOW() THEN NOW()+${seconds}*interval '1 second' ELSE "RateLimit"."resetsAt" END RETURNING count`;
  assert(
    result[0].count <= maximum,
    "RATE_LIMIT",
    "Please wait a minute before trying again.",
    429,
  );
}
