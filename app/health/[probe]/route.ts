import { NextResponse } from "next/server";
import { db } from "@/infra/db";
import { mediaRoot } from "@/domain/media";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const dynamic = "force-dynamic";
export async function GET(
  _r: Request,
  { params }: { params: Promise<{ probe: string }> },
) {
  const { probe } = await params;
  if (probe === "live") return NextResponse.json({ status: "alive" });
  try {
    await db.$queryRaw`SELECT 1`;
    await db.product.count();
    await fs.mkdir(mediaRoot(), { recursive: true });
    const probeFile = path.join(mediaRoot(), ".health-" + randomUUID());
    await fs.writeFile(probeFile, "ok");
    await fs.readFile(probeFile);
    await fs.unlink(probeFile);
    return NextResponse.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
