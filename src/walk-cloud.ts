import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type CloudExportFile = {
  sessionId: string;
  path: string;
  createdAt: string;
};

/** List `*.json` cloud export envelopes under dir, oldest createdAt first. */
export async function findCloudExportFiles(dir: string): Promise<CloudExportFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "ENOENT") return [];
    throw err;
  }

  const out: CloudExportFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let createdAt = "";
    let sessionId = name.replace(/\.json$/i, "");
    try {
      const raw = await readFile(path, "utf8");
      const obj = JSON.parse(raw) as { id?: unknown; createdAt?: unknown };
      if (typeof obj.id === "string" && obj.id) sessionId = obj.id;
      if (typeof obj.createdAt === "string") createdAt = obj.createdAt;
    } catch {
      continue;
    }
    out.push({ sessionId, path, createdAt });
  }

  out.sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  return out;
}
