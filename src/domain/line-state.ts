import { type Store } from "../infra/db";
/** Recompute customer progress from original sale units; replacement batches never add sales. */
export async function refreshLineState(tx: Store, id: string) {
  const l = await tx.orderLine.findUniqueOrThrow({
    where: { id },
    include: { proofs: { orderBy: { version: "desc" }, take: 1 }, runs: true },
  });
  const active = l.quantity - l.canceled,
    original = l.runs.filter(
      (r) => r.kind === "original" && r.state !== "canceled",
    );
  const packed = await tx.shipmentItem.findMany({
    where: { lineId: id, runId: { in: original.map((r) => r.id) } },
    include: { shipment: true },
  });
  const delivered = packed
    .filter((i) => i.shipment.state === "delivered")
    .reduce((n, i) => n + i.quantity, 0);
  const shipped = packed
    .filter((i) =>
      ["shipped", "in_transit", "delivered"].includes(i.shipment.state),
    )
    .reduce((n, i) => n + i.quantity, 0);
  let state = "awaiting_design";
  if (!active) state = "canceled";
  else if (l.held) state = "refund_pending";
  else if (delivered >= active) state = "delivered";
  else if (delivered) state = "partially_delivered";
  else if (shipped) state = shipped >= active ? "shipped" : "partially_shipped";
  else if (original.some((r) => r.state === "unknown")) state = "unknown";
  else if (original.some((r) => r.state === "submitting")) state = "submitting";
  else if (l.locked)
    state =
      original.every((r) => r.state === "completed") && l.locked === active
        ? "ready_to_ship"
        : "in_production";
  else if (l.proofs[0]?.state === "approved") state = "ready";
  else if (
    ["awaiting_review", "changes_requested"].includes(l.proofs[0]?.state)
  )
    state = l.proofs[0].state;
  return tx.orderLine.update({ where: { id }, data: { state } });
}
