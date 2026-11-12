import { contentHash } from "./common";
import { db, json, transaction, lock } from "../infra/db";
import { type Auth, role, orderAllowed } from "./auth";
import { assert, audit, hash, now, addMinutes, ref, origin } from "./common";
import { render, readAsset, validateDesignData, type DesignData } from "./media";
import { issueGrant, notify } from "./notifications";
export async function studioJobs(a: Auth, filter = "all", page = 0) {
  role(a, "designer", "owner");
  const where: any = { canceled: { lt: db.orderLine.fields.quantity } };
  if (filter === "unclaimed") where.assignedTo = null;
  else if (filter === "mine") where.assignedTo = a.userId;
  else if (filter === "review") where.state = "awaiting_review";
  else if (filter === "changes") where.state = "changes_requested";
  const lines = await db.orderLine.findMany({
    where,
    include: {
      order: { select: { ref: true } },
      proofs: { orderBy: { version: "desc" } },
      runs: true,
    },
    orderBy: [{ deadline: "asc" }, { id: "asc" }],
    skip: page * 100,
    take: 100,
  });
  return Promise.all(
    lines
      .filter((l) => l.canceled < l.quantity)
      .map(async (l) => ({
        ...l,
        snapshot: {
          product: (l.snapshot as any).product,
          variant: ((v: any) => ({
            id: v.id,
            sku: v.sku,
            label: v.label,
            color: v.color,
            size: v.size,
          }))((l.snapshot as any).variant),
        },
        runs: l.runs.map((r) => ({
          id: r.id,
          state: r.state,
          kind: r.kind,
          quantity: r.quantity,
          proofId: r.proofId,
          manifestHash: r.manifestHash,
          externalRef: r.externalRef,
        })),
        net: undefined,
        tax: undefined,
        unitSlices: undefined,
        revision: await db.revision.findUnique({ where: { id: l.revisionId } }),
      })),
  );
}
export async function studioJob(a: Auth, id: string) {
  role(a,'designer','owner');
  const l = await db.orderLine.findUnique({where:{id},include:{order:{select:{ref:true}},proofs:{orderBy:{version:'desc'}},runs:true}});
  assert(l, "NOT_FOUND", "This design job is unavailable.", 404);
  return {...l, snapshot:{product:(l.snapshot as any).product,variant:((v:any)=>({id:v.id,sku:v.sku,label:v.label,color:v.color,size:v.size}))((l.snapshot as any).variant)},runs:l.runs.map(r=>({id:r.id,state:r.state,kind:r.kind,quantity:r.quantity,proofId:r.proofId,manifestHash:r.manifestHash,externalRef:r.externalRef})),net:undefined,tax:undefined,unitSlices:undefined,revision:await db.revision.findUnique({where:{id:l.revisionId}})};
}
export async function claim(a: Auth, id: string) {
  role(a, "designer", "owner");
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", id);
    const l = await tx.orderLine.findUniqueOrThrow({ where: { id } });
    assert(
      !l.assignedTo || l.assignedTo === a.userId,
      "ALREADY_CLAIMED",
      "Another designer is working on this item.",
      409,
    );
    await audit(tx, a.principal, "design.claimed", id);
    return tx.orderLine.update({
      where: { id },
      data: { assignedTo: a.userId },
    });
  });
}
export async function saveWork(
  a: Auth,
  id: string,
  data: DesignData,
  minutes: number | null,
  expectedVersion: number,
) {
  role(a, "designer", "owner");
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", id);
    const l = await tx.orderLine.findUniqueOrThrow({
      where: { id },
      include: { proofs: { orderBy: { version: "desc" }, take: 1 } },
    });
    assert(
      l.assignedTo === a.userId || a.role === "owner",
      "CLAIM_REQUIRED",
      "Claim this design job first.",
      409,
    );
    assert(
      l.locked === 0 && l.held === 0 && l.canceled < l.quantity,
      "PRODUCTION_LOCK",
      "This item cannot be edited in its current production state.",
      409,
    );
    assert(
      (l.proofs[0]?.version || 0) === expectedVersion,
      "VERSION_CONFLICT",
      "A newer proof exists. Reload the job.",
      409,
    );
    assert(
      minutes === null ||
        (Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440),
      "MINUTES",
      "Enter 0–1440 minutes, or leave blank.",
    );
    const original = await tx.revision.findUniqueOrThrow({
      where: { id: l.revisionId },
    });
    assert(
      data && data.frontId === (original.data as any).frontId &&
        data.sideId === (original.data as any).sideId,
      "REFERENCE_SCOPE",
      "Use the reference photos attached to this paid design. New source photos require a support review.",
      403,
    );
    validateDesignData(data);
    await audit(tx, a.principal, "design.draft_saved", id);
    return tx.orderLine.update({
      where: { id },
      data: { workDraft: json(data), minutes },
    });
  });
}
export async function publishProof(
  a: Auth,
  id: string,
  expectedVersion: number,
) {
  role(a, "designer", "owner");
  const l = await db.orderLine.findUniqueOrThrow({
    where: { id },
    include: { order: true },
  });
  assert(
    l.assignedTo === a.userId || a.role === "owner",
    "CLAIM_REQUIRED",
    "Claim this job first.",
    409,
  );
  const original = await db.revision.findUniqueOrThrow({
    where: { id: l.revisionId },
  });
  const data = (l.workDraft || original.data) as unknown as DesignData;
  const source = await readAsset(data.frontId!);
  const generated = await render(
    source.asset.owner,
    (l.snapshot as any).product,
    data,
    (l.snapshot as any).variant,
  );
  const frozenManifest = {
    ...generated.manifest,
    lineId: id,
    revisionId: l.revisionId,
    proofVersion: expectedVersion + 1,
  };
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", id);
    const current = await tx.orderLine.findUniqueOrThrow({
      where: { id },
      include: { proofs: { orderBy: { version: "desc" }, take: 1 } },
    });
    assert(
      current.locked === 0 &&
        current.held === 0 &&
        current.canceled < current.quantity,
      "PRODUCTION_LOCK",
      "This item cannot receive a new proof now.",
      409,
    );
    assert(
      (current.proofs[0]?.version || 0) === expectedVersion,
      "VERSION_CONFLICT",
      "A newer proof exists. Reload the job.",
      409,
    );
    assert(
      JSON.stringify(current.workDraft || original.data) ===
        JSON.stringify(data),
      "DRAFT_CHANGED",
      "The working draft changed. Review it before publishing.",
      409,
    );
    const version = expectedVersion + 1;
    await tx.proof.updateMany({
      where: { lineId: id, state: { in: ["awaiting_review", "approved"] } },
      data: { state: "superseded" },
    });
    const previous = await tx.proof.findMany({
      where: { lineId: id },
      select: { id: true },
    });
    await tx.grant.updateMany({
      where: { purpose: "proof", scope: { in: previous.map((p) => p.id) } },
      data: { revokedAt: now() },
    });
    const p = await tx.proof.create({
      data: {
        lineId: id,
        version,
        revisionId: l.revisionId,
        previewId: generated.preview.id,
        productionId: generated.production.id,
        manifest: json(frozenManifest),
        manifestHash: contentHash(frozenManifest),
        previewSha: generated.preview.sha,
        productionSha: generated.production.sha,
      },
    });
    await tx.orderLine.update({
      where: { id },
      data: { state: "awaiting_review" },
    });
    const raw = await issueGrant(tx, "proof", p.id, l.order.email, version);
    await notify(
      tx,
      `proof:${p.id}`,
      l.order.email,
      `Your ${data.name || "pet"} proof is ready`,
      `Please review version ${version}. Opening this message does not approve your proof.`,
      `${origin()}/proof/${raw}`,
    );
    await audit(tx, a.principal, "proof.published", id, {
      proofId: p.id,
      version,
      manifestHash: p.manifestHash,
    });
    return p;
  });
}
export async function proofAccess(a: Auth, idOrToken: string) {
  let p = await db.proof.findUnique({
    where: { id: idOrToken },
    include: { line: { include: { order: true } } },
  });
  if (p) {
    assert(
      await orderAllowed(a, p.line.orderId),
      "NOT_FOUND",
      "Proof unavailable.",
      404,
    );
  } else {
    const g = await db.grant.findUnique({
      where: { tokenHash: hash(idOrToken) },
    });
    assert(
      g && g.purpose === "proof",
      "LINK_INVALID",
      "This proof link is invalid. Request a new link from your order.",
      410,
    );
    assert(
      !g.revokedAt,
      "LINK_REPLACED",
      "A newer proof or link is available. Open your order for the latest version.",
      410,
    );
    assert(
      g.expiresAt > now(),
      "LINK_EXPIRED",
      "This proof link expired. Request a new link from your order.",
      410,
    );
    p = await db.proof.findUnique({
      where: { id: g.scope },
      include: { line: { include: { order: true } } },
    });
    assert(p, "NOT_FOUND", "Proof unavailable.", 404);
    await db.orderAccess.upsert({
      where: {
        sessionId_orderId: { sessionId: a.sessionId, orderId: p.line.orderId },
      },
      create: {
        sessionId: a.sessionId,
        orderId: p.line.orderId,
        expiresAt: addMinutes(120),
      },
      update: { expiresAt: addMinutes(120) },
    });
  }
  const latest = await db.proof.findFirst({
    where: { lineId: p.lineId },
    orderBy: { version: "desc" },
  });
  const revision = await db.revision.findUniqueOrThrow({
    where: { id: p.line.revisionId },
  });
  return {
    ...p,
    line: { ...p.line, order: { ref: p.line.order.ref } },
    original: revision,
    current: latest?.id === p.id,
    canDecide:
      p.line.order.principal === a.principal ||
      !!(await db.orderAccess.findFirst({
        where: {
          sessionId: a.sessionId,
          orderId: p.line.orderId,
          expiresAt: { gt: now() },
        },
      })),
  };
}
export async function decideProof(
  a: Auth,
  id: string,
  decision: string,
  feedback: string,
  expectedVersion: number,
) {
  const p = await db.proof.findUniqueOrThrow({
    where: { id },
    include: { line: { include: { order: true } } },
  });
  const direct = p.line.order.principal === a.principal;
  const access = await db.orderAccess.findUnique({
    where: {
      sessionId_orderId: { sessionId: a.sessionId, orderId: p.line.orderId },
    },
  });
  assert(
    direct || (access && access.expiresAt > now()),
    "NOT_FOUND",
    "Proof unavailable.",
    404,
  );
  assert(
    ["approve", "changes"].includes(decision),
    "DECISION",
    "Choose approval or request changes.",
  );
  if (decision === "changes")
    assert(feedback?.trim(), "FEEDBACK", "Tell your designer what to change.");
  const production = await readAsset(p.productionId);
  const preview = await readAsset(p.previewId);
  assert(
    production.asset.sha === p.productionSha &&
      preview.asset.sha === p.previewSha &&
      contentHash(p.manifest) === p.manifestHash,
    "INTEGRITY",
    "The proof assets changed. Contact the studio before approval.",
    409,
  );
  return transaction(async (tx) => {
    await lock(tx, "OrderLine", p.lineId);
    const current = await tx.proof.findFirstOrThrow({
      where: { lineId: p.lineId },
      orderBy: { version: "desc" },
    });
    const line = await tx.orderLine.findUniqueOrThrow({
      where: { id: p.lineId },
    });
    assert(
      current.id === id && current.version === expectedVersion,
      "VERSION_CONFLICT",
      "New proof available. Open the latest version.",
      409,
    );
    if (current.state === "approved" && decision === "approve") return current;
    assert(
      current.state === "awaiting_review" &&
        line.canceled < line.quantity &&
        !line.held,
      "DECISION_UNAVAILABLE",
      "This proof is no longer waiting for a decision.",
      409,
    );
    if (decision === "changes" && line.changesUsed >= 1) {
      const ticket = await tx.ticket.create({
        data: {
          ref: ref("HELP"),
          principal: a.principal,
          email: p.line.order.email,
          orderId: line.orderId,
          lineId: line.id,
          kind: "extra_revision",
          subject: "Additional revision requested",
          messages: json([
            { by: "customer", text: feedback, at: now().toISOString() },
          ]),
        },
      });
      await audit(tx, a.principal, "proof.extra_revision_requested", line.id, {
        ticketId: ticket.id,
      });
      return { ticketRef: ticket.ref, state: "support_requested" };
    }
    const result = await tx.proof.update({
      where: { id },
      data:
        decision === "approve"
          ? { state: "approved", approvedAt: now(), approvedBy: a.principal }
          : {
              state: "changes_requested",
              feedback: feedback.trim().slice(0, 3000),
            },
    });
    await tx.orderLine.update({
      where: { id: line.id },
      data: {
        state: decision === "approve" ? "ready" : "changes_requested",
        ...(decision === "changes" ? { changesUsed: { increment: 1 } } : {}),
      },
    });
    await tx.grant.updateMany({
      where: { purpose: "proof", scope: id },
      data: { usedAt: now() },
    });
    await audit(
      tx,
      a.principal,
      decision === "approve" ? "proof.approved" : "proof.changes_requested",
      line.id,
      {
        proofId: id,
        version: current.version,
        previewSha: current.previewSha,
        manifestHash: current.manifestHash,
      },
    );
    return result;
  });
}
export async function resendProof(a: Auth, id: string) {
  const p = await db.proof.findUniqueOrThrow({
    where: { id },
    include: { line: { include: { order: true } } },
  });
  assert(
    await orderAllowed(a, p.line.orderId),
    "NOT_FOUND",
    "Proof unavailable.",
    404,
  );
  assert(
    p.state === "awaiting_review",
    "PROOF_STATE",
    "Only a pending proof can be resent.",
    409,
  );
  const raw = await issueGrant(
    db,
    "proof",
    p.id,
    p.line.order.email,
    p.version,
  );
  await notify(
    db,
    ref("resend"),
    p.line.order.email,
    "Your proof link",
    `Review version ${p.version} for order ${p.line.order.ref}.`,
    `${origin()}/proof/${raw}`,
  );
  await audit(db, a.principal, "proof.link_resent", p.lineId);
  return { message: "A fresh link was sent to the order email." };
}
