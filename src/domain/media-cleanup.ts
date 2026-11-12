import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../infra/db";
import { mediaRoot } from "./media";
/** Only old files without any asset row are eligible; registered originals and revisions remain intact. */
export async function cleanOrphanFiles() {
  const root = mediaRoot(),
    cutoff = Date.now() - 86400000;
  let removed = 0;
  for (const name of (await fs.readdir(root).catch(() => [])).filter((n) =>
    /^[\w-]+\.png(?:\.tmp)?$/.test(n),
  )) {
    const file = path.join(root, name),
      stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.mtimeMs >= cutoff) continue;
    if (
      await db.asset.findUnique({ where: { key: name.replace(/\.tmp$/, "") } })
    )
      continue;
    await fs.unlink(file).catch(() => {});
    if (++removed >= 100) break;
  }
  return removed;
}
