import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { escapeHtml } from "./common";
/** Deterministic local product diagrams, paired with the actual print master. */
export async function mockup(
  master: Buffer,
  product: any,
  data: any,
  variant?: any,
) {
  const image = (bytes: Buffer, x: number, y: number, w: number, h: number) =>
    `<image href="data:image/png;base64,${bytes.toString("base64")}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
  const stamp = await sharp(master)
    .resize(600, 600, { fit: "contain", background: data.background })
    .png()
    .toBuffer();
  const label = (text: string, x = 400, y = 720, size = 19) =>
    `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle" font-family="DejaVu Sans" fill="#234736">${escapeHtml(text)}</text>`;
  const color =
    variant?.color?.toLowerCase() === "dark"
      ? "#24352d"
      : variant?.color?.toLowerCase() === "pine"
        ? "#285444"
        : "#f7f5ec";
  let shapes = "";
  if (product.kind === "mug") {
    for (let i = 0; i < 2; i++) {
      const x = 80 + i * 370,
        handle = (data.orientation === "left" ? 1 : 0) ^ i;
      shapes += `<ellipse cx="${x + 128}" cy="570" rx="145" ry="19" fill="#dddcd2"/><path d="M ${handle ? x : x + 250} 310 q ${handle ? -110 : 110} 0 ${handle ? -110 : 110} 95 q 0 90 ${handle ? 110 : -110} 90" fill="none" stroke="#cfd3cb" stroke-width="32"/><rect x="${x}" y="250" width="255" height="310" rx="30" fill="url(#ceramic)" stroke="#cdd0c8"/>${image(stamp, x + 37, 300, 180, 210)}<ellipse cx="${x + 127}" cy="250" rx="127" ry="20" fill="#eeeae1" stroke="#cdd0c8"/><ellipse cx="${x + 127}" cy="250" rx="106" ry="12" fill="#d6d8d0"/>${label(i ? "Opposite angle" : "Primary angle", x + 128, 625, 17)}`;
    }
    shapes += label(
      "11 oz white ceramic · " + data.orientation + " handle orientation",
    );
  } else if (product.kind === "shirt") {
    shapes = `<path d="M 270 150 L 180 195 L 100 330 L 205 389 L 240 330 L 240 650 L 560 650 L 560 330 L 595 389 L 700 330 L 620 195 L 530 150 L 470 180 Q 400 255 330 180 Z" fill="${color}" stroke="#b7beb3" stroke-width="4"/><path d="M330 180 Q400 260 470 180" fill="none" stroke="#9ba497" stroke-width="7"/>${image(master, 295, 285, 210, 270)}${label((variant?.size || "M") + " · " + (variant?.color || "light") + " · chest print placement")}`;
  } else if (product.kind === "balls") {
    for (let i = 0; i < 6; i++) {
      const x = 185 + (i % 3) * 215,
        y = 270 + Math.floor(i / 3) * 235;
      shapes += `<circle cx="${x}" cy="${y}" r="94" fill="url(#ball)" stroke="#ccd1c9"/>`;
      for (let j = 0; j < 20; j++) {
        const angle = (j * Math.PI) / 10;
        shapes += `<circle cx="${x + 78 * Math.cos(angle)}" cy="${y + 78 * Math.sin(angle)}" r="4" fill="#dfe3dc"/>`;
      }
      shapes += image(stamp, x - 52, y - 52, 104, 104);
    }
    shapes += label("6-pack · one sales unit · illustrative small print area");
  } else if (product.kind === "tee") {
    shapes = image(master, 45, 85, 710, 460);
    const cocoSample = await sharp(await fs.readFile(path.join(process.cwd(), "public/assets/coco/tee.png")))
      .resize(180, 180, { fit: "contain", background: "#f4f1e9" }).png().toBuffer();
    shapes += image(cocoSample, 310, 535, 180, 180);
    shapes += label("COCO · SCULPTED COLLECTION SAMPLE", 400, 738, 14);
    shapes += label(
      "YOUR PHOTO REFERENCES ABOVE · NOT A CUSTOM 3D RECONSTRUCTION",
      400,
      765,
      15,
    );
  } else {
    shapes = `<path d="M 270 140 Q 400 75 530 140 Q 565 220 540 420 L 485 490 L 485 680 L 315 680 L 315 490 L 260 420 Q 235 220 270 140 Z" fill="${color}" stroke="#aeb9a8" stroke-width="4"/><path d="M 320 510 L 480 510 M 320 550 L 480 550 M 320 590 L 480 590 M 320 630 L 480 630" stroke="#81947e" stroke-width="3" opacity=".4"/>${image(master, 285, 160, 230, 280)}${label("Printed driver headcover · flat portrait panel", 400, 740)}`;
  }
  const svg = `<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ceramic"><stop stop-color="#e9e8df"/><stop offset=".42" stop-color="#fffef9"/><stop offset="1" stop-color="#dcded5"/></linearGradient><radialGradient id="ball" cx="35%" cy="30%" r="75%"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#dfe3dc"/></radialGradient></defs><rect width="800" height="800" fill="#f4f1e9"/>${label("PAWLINE · PERSONAL PLACEMENT PREVIEW", 400, 45, 14)}${shapes}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
