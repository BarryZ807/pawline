import { contentHash } from "./common";
import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { db, json, transaction, lock } from "../infra/db";
import { assert, hash, token, escapeHtml, setting, audit } from "./common";
import { type Auth, orderAllowed } from "./auth";
import { mockup } from "./mockup";
import { findSamplePet } from "../sample-pets";
export const mediaRoot = () =>
  path.resolve(
    /* turbopackIgnore: true */ process.env.MEDIA_DIR || ".local/media",
  );
export type DesignData = {
  frontId?: string;
  sideId?: string;
  name: string;
  note: string;
  background: string;
  crop: { x: number; y: number; w: number; h: number };
  layout: string;
  orientation: string;
};
export const initialData: DesignData = {
  name: "",
  note: "",
  background: "#e7eadd",
  crop: { x: 0, y: 0, w: 1, h: 1 },
  layout: "classic",
  orientation: "right",
};
export function validateDesignData(data: DesignData) {
  assert(data && typeof data === "object" && !Array.isArray(data), "DESIGN", "Provide valid design settings.");
  assert([data.name, data.note, data.background, data.layout, data.orientation].every(v => typeof v === "string"), "DESIGN", "Use text for the design settings.");
  assert([data.frontId, data.sideId].every(v => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 128)), "PHOTO", "Choose valid reference photos.");
  const c = data.crop;
  assert(c && [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x < 1 && c.y < 1 && c.x + c.w <= 1.00001 && c.y + c.h <= 1.00001, "CROP", "Keep the crop within the photo.");
  assert(/^#[\da-f]{6}$/i.test(data.background), "COLOR", "Choose a valid background color.");
}
export async function storeAsset(
  owner: string,
  bytes: Buffer,
  kind = "source",
) {
  const m = await sharp(bytes, { limitInputPixels: 25000000 }).metadata();
  assert(m.width && m.height, "IMAGE", "This image could not be read.");
  const key = token() + ".png";
  await fs.mkdir(mediaRoot(), { recursive: true, mode: 0o700 });
  const tmp = path.join(mediaRoot(), key + ".tmp");
  await fs.writeFile(tmp, bytes, { mode: 0o600 });
  await fs.rename(tmp, path.join(mediaRoot(), key));
  return db.asset.create({
    data: {
      owner,
      key,
      sha: hash(bytes),
      mime: "image/png",
      width: m.width,
      height: m.height,
      bytes: bytes.length,
      kind,
    },
  });
}
let activeImages = 0;
async function withImageSlot<T>(work: () => Promise<T>) {
  assert(
    activeImages < 4,
    "IMAGE_BUSY",
    "The studio is processing several images. Please retry shortly.",
    429,
  );
  activeImages++;
  try {
    return await work();
  } finally {
    activeImages--;
  }
}
export async function upload(a: Auth, bytes: Buffer, mime: string) {
  return withImageSlot(() => uploadImage(a, bytes, mime));
}
async function uploadImage(a: Auth, bytes: Buffer, mime: string) {
  assert(
    !(await setting("uploadFailure", false)),
    "UPLOAD_UNAVAILABLE",
    "Image storage is unavailable. Your previous image is safe; please retry.",
    503,
  );
  assert(
    bytes.length > 0 && bytes.length <= 12 * 1024 * 1024,
    "FILE_SIZE",
    "Choose a JPG or PNG image smaller than 12 MiB.",
    413,
  );
  assert(
    ["image/jpeg", "image/png"].includes(mime),
    "IMAGE_FORMAT",
    "Please use JPG or PNG. For HEIC, export as JPEG or try a sample pet.",
  );
  try {
    const image = sharp(bytes, { limitInputPixels: 25000000, failOn: "error" });
    const meta = await image.metadata();
    assert(
      ["jpeg", "png"].includes(meta.format || "") &&
        mime === `image/${meta.format}`,
      "IMAGE_FORMAT",
      "The file contents do not match its image type.",
    );
    const out = await image.rotate().png().toBuffer();
    return storeAsset(a.principal, out);
  } catch (e) {
    if (e instanceof Error && e.name === "DomainError") throw e;
    assert(
      false,
      "IMAGE_INVALID",
      "The image is damaged or exceeds 25 megapixels. Choose another JPG or PNG.",
    );
  }
}
export async function sample(a: Auth, pet: string, view: string) {
  const reference = findSamplePet(pet);
  assert(
    reference && ["front", "side"].includes(view),
    "SAMPLE",
    "Choose an available sample.",
  );
  return upload(
    a,
    await fs.readFile(
      path.join(process.cwd(), "public", (view === "front" ? reference.front : reference.side).slice(1)),
    ),
    "image/png",
  );
}
export async function readAsset(id: string) {
  const asset = await db.asset.findUnique({ where: { id } });
  assert(
    asset && asset.state === "ready",
    "ASSET_MISSING",
    "This image is unavailable. Please upload it again.",
    409,
  );
  const data = await fs
    .readFile(
      /* turbopackIgnore: true */ path.join(
        /* turbopackIgnore: true */ mediaRoot(),
        asset.key,
      ),
    )
    .catch(() => null);
  assert(
    data && hash(data) === asset.sha,
    "ASSET_INTEGRITY",
    "The image failed verification. Production is on hold.",
    409,
  );
  return { asset, data };
}
export async function authorizedAsset(a: Auth, id: string) {
  const asset = await db.asset.findUnique({ where: { id } });
  assert(asset, "NOT_FOUND", "Image unavailable.", 404);
  if (asset.owner === a.principal) return readAsset(id);
  // Authorization must not depend on a truncated list of recent orders.
  // Resolve actual asset fields, never a coincidental string in a pet name/note.
  const matches=await db.$queryRaw<{id:string}[]>`
    SELECT l.id FROM "OrderLine" l JOIN "Order" o ON o.id=l."orderId"
    JOIN "Revision" r ON r.id=l."revisionId"
    WHERE (${['owner','designer'].includes(a.role)} OR o.principal=${a.principal}
      OR EXISTS (SELECT 1 FROM "OrderAccess" g WHERE g."orderId"=o.id AND g."sessionId"=${a.sessionId} AND g."expiresAt">NOW()))
    AND (r."previewId"=${id} OR r."productionId"=${id} OR r.data->>'frontId'=${id} OR r.data->>'sideId'=${id}
      OR EXISTS (SELECT 1 FROM "Proof" p WHERE p."lineId"=l.id AND
        (p."previewId"=${id} OR p."productionId"=${id} OR p.manifest->'source'->>'frontId'=${id} OR p.manifest->'source'->>'sideId'=${id})))
    LIMIT 1`;
  if(matches.length)return readAsset(id);
  assert(false, "NOT_FOUND", "Image unavailable.", 404);
}
export async function render(
  owner: string,
  product: any,
  data: DesignData,
  variant?: any,
) {
  return withImageSlot(() => renderImage(owner, product, data, variant));
}
async function renderImage(
  owner: string,
  product: any,
  data: DesignData,
  variant?: any,
) {
  validateDesignData(data);
  assert(data.frontId, "PHOTO_REQUIRED", "Choose or upload a front photo.");
  if (product.kind === "tee")
    assert(data.sideId, "SIDE_REQUIRED", "Add a side photo before continuing.");
  const source = await readAsset(data.frontId);
  assert(source.asset.owner === owner, "NOT_FOUND", "Image unavailable.", 404);
  if (data.sideId) {
    const side = await readAsset(data.sideId);
    assert(side.asset.owner === owner, "NOT_FOUND", "Image unavailable.", 404);
  }
  const t = product.template as {
    width: number;
    height: number;
    version: string;
  };
  const { x, y, w, h } = data.crop;
  assert(
    [x, y, w, h].every(Number.isFinite) &&
      x >= 0 &&
      y >= 0 &&
      w > 0 &&
      h > 0 &&
      x + w <= 1.00001 &&
      y + h <= 1.00001,
    "CROP",
    "Keep the crop within the photo.",
  );
  assert(
    /^#[\da-f]{6}$/i.test(data.background),
    "COLOR",
    "Choose a valid background color.",
  );
  assert(
    [...data.name].length <= (product.kind === "balls" ? 12 : 20),
    "NAME_LENGTH",
    `Use no more than ${product.kind === "balls" ? 12 : 20} characters.`,
  );
  const left = Math.floor(x * source.asset.width),
    top = Math.floor(y * source.asset.height);
  const cropW = Math.min(
    source.asset.width - left,
    Math.max(1, Math.round(w * source.asset.width)),
  );
  const cropH = Math.min(
    source.asset.height - top,
    Math.max(1, Math.round(h * source.asset.height)),
  );
  const size = Math.floor(Math.min(t.width * 0.73, t.height * 0.72));
  const photo = await sharp(source.data)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(size, size, { fit: "cover" })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`,
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  const px =
    product.kind === "tee"
      ? Math.floor(t.width * 0.08)
      : Math.floor((t.width - size) / 2);
  const py = Math.floor(t.height * 0.08);
  const inputs: OverlayOptions[] = [{ input: photo, left: px, top: py }];
  if (product.kind === "tee" && data.sideId) {
    const side = await readAsset(data.sideId);
    inputs.push({
      input: await sharp(side.data)
        .resize(size, size, { fit: "cover" })
        .png()
        .toBuffer(),
      left: Math.floor(t.width * 0.53),
      top: py,
    });
  }
  const textY = Math.min(t.height * 0.94, py + size + t.height * 0.11);
  const font = Math.round(t.height * 0.063);
  inputs.push({
    input: Buffer.from(
      `<svg width="${t.width}" height="${t.height}"><text x="${t.width / 2}" y="${textY}" text-anchor="middle" font-family="DejaVu Sans" font-size="${font}" letter-spacing="${font * 0.07}" fill="#173a2e">${escapeHtml(data.name)}</text>${product.kind === "tee" ? `<text x="${t.width / 2}" y="${t.height * 0.985}" text-anchor="middle" font-family="DejaVu Sans" font-size="20" fill="#173a2e">REFERENCE BOARD · GENERIC SAMPLE · NOT A 3D RECONSTRUCTION</text>` : ""}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  const final = await sharp({
    create: {
      width: t.width,
      height: t.height,
      channels: 4,
      background: data.background,
    },
  })
    .composite(inputs)
    .png()
    .toBuffer();
  const production = await storeAsset(owner, final, "production");
  const preview = await storeAsset(
    owner,
    await mockup(final, product, data, variant),
    "preview",
  );
  const manifest = {
    templateVersion: t.version,
    kind: product.kind,
    variant: variant
      ? { id: variant.id, color: variant.color, size: variant.size }
      : null,
    coordinateSystem: {
      origin: "top-left after EXIF normalization",
      unit: "pixels",
      font: "DejaVu Sans",
      safeInset: 0.05,
      printArea: { x: 0, y: 0, width: t.width, height: t.height },
    },
    dimensions: { width: t.width, height: t.height },
    source: {
      frontId: data.frontId,
      sha: source.asset.sha,
      sideId: data.sideId || null,
      sideSha: data.sideId ? (await readAsset(data.sideId)).asset.sha : null,
    },
    layout: data,
    productionId: production.id,
    productionSha: production.sha,
    previewId: preview.id,
    previewSha: preview.sha,
    notes:
      "Local demo production layout; not a certified printer specification.",
  };
  return {
    production,
    preview,
    manifest,
    manifestHash: contentHash(manifest),
  };
}
export async function createDesign(a: Auth, variantId: string) {
  assert(typeof variantId === "string" && variantId.length > 0 && variantId.length <= 128, "VARIANT", "Choose an available product option.");
  const v = await db.variant.findUnique({
    where: { id: variantId },
    include: { product: true },
  });
  assert(
    v && v.active && v.product.active,
    "PRODUCT_UNAVAILABLE",
    "This item is not currently available.",
    409,
  );
  return db.design.create({
    data: { owner: a.principal, variantId, data: json(initialData) },
  });
}
export async function getDesign(a: Auth, id: string) {
  assert(typeof id === "string" && id.length > 0 && id.length <= 128, "NOT_FOUND", "Design unavailable in this browser.", 404);
  const d = await db.design.findUnique({ where: { id } });
  assert(
    d && d.owner === a.principal,
    "NOT_FOUND",
    "Design unavailable in this browser.",
    404,
  );
  const variant = await db.variant.findUnique({
    where: { id: d.variantId },
    include: { product: true },
  });
  return { ...d, variant };
}
export async function saveDesign(
  a: Auth,
  id: string,
  version: number,
  input: DesignData,
) {
  const d = await getDesign(a, id);
  assert(input && typeof input === "object" && !Array.isArray(input), "DESIGN", "Provide valid design settings.");
  validateDesignData({ ...initialData, ...input });
  assert(
    d.version === version,
    "VERSION_CONFLICT",
    "A newer edit was saved. Reload this design.",
    409,
  );
  const data = {
    ...initialData,
    ...input,
    name: String(input.name || "").trim(),
    note: String(input.note || "").slice(0, 1000),
  };
  let generated: Awaited<ReturnType<typeof render>> | null = null;
  if (data.frontId && !(d.variant!.product.kind === "tee" && !data.sideId))
    generated = await render(a.principal, d.variant!.product, data, d.variant);
  return transaction(async (tx) => {
    await lock(tx, "Design", id);
    const current = await tx.design.findUniqueOrThrow({ where: { id } });
    assert(
      current.version === version,
      "VERSION_CONFLICT",
      "A newer edit was saved. Reload this design.",
      409,
    );
    return tx.design.update({
      where: { id },
      data: {
        data: json(data),
        version: { increment: 1 },
        previewId: generated?.preview.id || null,
        productionId: generated?.production.id || null,
      },
    });
  });
}
export async function freezeDesign(a: Auth, id: string) {
  const d = await getDesign(a, id);
  const data = d.data as unknown as DesignData;
  const r = await render(a.principal, d.variant!.product, data, d.variant);
  return transaction(async (tx) => {
    await lock(tx, "Design", id);
    const current = await tx.design.findUniqueOrThrow({ where: { id } });
    assert(
      current.version === d.version,
      "VERSION_CONFLICT",
      "The design changed. Review it before adding to your bag.",
      409,
    );
    return tx.revision.upsert({
      where: { designId_version: { designId: id, version: d.version } },
      create: {
        designId: id,
        version: d.version,
        data: json(data),
        previewId: r.preview.id,
        productionId: r.production.id,
        manifest: json(r.manifest),
        manifestHash: r.manifestHash,
      },
      update: {},
    });
  });
}
