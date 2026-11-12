import { db } from "../infra/db";
import { type Auth, role } from "./auth";
import { assert, hash, now } from "./common";
import { csvCell, dateWindow, timezone } from "./monitor";

export async function auditLog(a: Auth, params: URLSearchParams, exportAll = false) {
  role(a, "owner");
  const actorRole = params.get("role") || "all";
  const kind = (params.get("event") || "").trim();
  const page = Number(params.get("page") || 0);
  assert(["all", "owner", "designer", "buyer", "guest", "system"].includes(actorRole), "ROLE", "Choose an audit role.");
  assert(Number.isSafeInteger(page) && page >= 0 && page <= 100000 && kind.length <= 100, "FILTER", "Choose valid audit filters.");
  let window;
  try { window = dateWindow(params.get("start") || undefined, params.get("end") || undefined); }
  catch { assert(false, "DATE", "Choose valid dates."); }
  assert(window.start < window.end, "DATE", "The start date must not be after the end date.");
  const users = await db.user.findMany({ select: { id: true, role: true } });
  const roles = new Map(users.map(u => [u.id, u.role]));
  const actor = actorRole === "all" ? undefined : actorRole === "guest" ? { startsWith: "guest_" }
    : actorRole === "system" ? { notIn: users.map(u => u.id), not: { startsWith: "guest_" } }
    : { in: users.filter(u => u.role === actorRole).map(u => u.id) };
  const where = { AND: [{ kind: { contains: "." } }, { kind: { contains: kind, mode: "insensitive" as const } }], actor, createdAt: { gte: window.start, lt: window.end } };
  const [total, events] = await db.$transaction([
    db.event.count({ where }),
    db.event.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...(exportAll ? {} : { skip: page * 50, take: 50 }) }),
  ], { isolationLevel: "RepeatableRead" });
  const items = events.map(e => {
    const raw = e.data && typeof e.data === "object" ? e.data as Record<string, unknown> : {};
    // Audit records retain full reasons privately; list/export only safe structured metadata.
    const data: Record<string, unknown> = {};
    for (const key of ["version", "amount", "quantity", "releaseNo", "total", "minutes", "canceled", "addressVersion"])
      if (typeof raw[key] === "number" || typeof raw[key] === "boolean") data[key] = raw[key];
    if (typeof raw.reason === "string") data.reasonRecorded = !!raw.reason;
    return { id: e.id, eventId: e.eventId, kind: e.kind, role: roles.get(e.actor) || (e.actor.startsWith("guest_") ? "guest" : "system"), actor: "actor_" + hash(e.actor).slice(0, 12), objectId: e.objectId, createdAt: e.createdAt, data };
  });
  return { items, total, page, pageSize: 50, asOf: now().toISOString(), timezone, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), filters: { role: actorRole, event: kind } };
}
export async function auditCsv(a: Auth, params: URLSearchParams) {
  const result = await auditLog(a, params, true);
  return [["event_id", "time_utc", "role", "event", "actor_scope", "object", "details"], ...result.items.map(e => [e.eventId, e.createdAt.toISOString(), e.role, e.kind, e.actor, e.objectId, JSON.stringify(e.data)])].map(row => row.map(csvCell).join(",")).join("\r\n");
}
