import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type TranscriptFile = {
  sessionId: string;
  projectSlug: string;
  path: string;
};

/** Parent chats only: .../agent-transcripts/<uuid>/<uuid>.jsonl */
export async function findParentTranscripts(root: string): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  let projectSlugs: string[];
  try {
    projectSlugs = await readdir(root);
  } catch {
    return out;
  }

  for (const projectSlug of projectSlugs) {
    const transcriptsRoot = join(root, projectSlug, "agent-transcripts");
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(transcriptsRoot);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      if (sessionId === "subagents") continue;
      const filePath = join(transcriptsRoot, sessionId, `${sessionId}.jsonl`);
      try {
        const entries = await readdir(join(transcriptsRoot, sessionId));
        if (!entries.includes(`${sessionId}.jsonl`)) continue;
      } catch {
        continue;
      }
      out.push({ sessionId, projectSlug, path: filePath });
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
