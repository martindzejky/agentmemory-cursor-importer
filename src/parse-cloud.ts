import { readFile } from "node:fs/promises";
import type { CloudExportEnvelope } from "./export-cloud.js";
import type { ImportEvent } from "./parse.js";

function extractUserPrompt(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (m ? m[1] : text).trim();
}

function parseMs(iso: string, label: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ${label}: ${iso}`);
  return ms;
}

/** Spread message times evenly from createdAt to updatedAt; +1ms steps if equal. */
export function interpolateTimestamps(
  createdAt: string,
  updatedAt: string,
  count: number,
): string[] {
  if (count <= 0) return [];
  const start = parseMs(createdAt, "createdAt");
  let end = parseMs(updatedAt, "updatedAt");
  if (end < start) end = start;

  if (count === 1) return [new Date(start).toISOString()];

  if (end === start) {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push(new Date(start + i).toISOString());
    }
    return out;
  }

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const ms = start + ((end - start) * i) / (count - 1);
    out.push(new Date(Math.round(ms)).toISOString());
  }
  return out;
}

export function projectFromCloudRepos(repos: Array<{ url: string }>): {
  project: string;
  cwd: string;
} {
  const raw = repos[0]?.url?.trim() || "";
  if (!raw) return { project: "unknown", cwd: "" };

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const noGit = withScheme.replace(/\.git$/i, "");
  let pathPart = noGit;
  try {
    pathPart = new URL(noGit).pathname;
  } catch {
    pathPart = noGit.replace(/^https?:\/\/[^/]+/i, "");
  }
  const segments = pathPart.split("/").filter(Boolean);
  const project = segments[segments.length - 1] || "unknown";
  return { project, cwd: noGit };
}

export function parseCloudEnvelope(envelope: CloudExportEnvelope): ImportEvent[] {
  const sessionId = envelope.id;
  if (!sessionId) throw new Error("cloud envelope missing id");

  type Prepared = {
    hookType: ImportEvent["hookType"];
    text: string;
    msgId: string;
  };

  const prepared: Prepared[] = [];
  for (const msg of envelope.messages) {
    if (!msg || typeof msg !== "object") continue;
    if (typeof msg.id !== "string" || !msg.id) continue;
    if (typeof msg.text !== "string") continue;

    if (msg.type === "user_message") {
      const prompt = extractUserPrompt(msg.text);
      if (!prompt) continue;
      prepared.push({ hookType: "prompt_submit", text: prompt, msgId: msg.id });
      continue;
    }

    if (msg.type === "assistant_message") {
      const assistant = msg.text.trim();
      if (!assistant) continue;
      prepared.push({ hookType: "assistant_response", text: assistant, msgId: msg.id });
    }
  }

  const stamps = interpolateTimestamps(envelope.createdAt, envelope.updatedAt, prepared.length);
  return prepared.map((item, i) => ({
    hookType: item.hookType,
    text: item.text,
    timestamp: stamps[i],
    eventId: `cursor-cloud:${sessionId}:${item.msgId}`,
  }));
}

export async function parseCloudExportFile(path: string): Promise<{
  sessionId: string;
  project: string;
  cwd: string;
  createdAt: string;
  events: ImportEvent[];
}> {
  const raw = await readFile(path, "utf8");
  let envelope: CloudExportEnvelope;
  try {
    envelope = JSON.parse(raw) as CloudExportEnvelope;
  } catch {
    throw new Error(`Invalid cloud export JSON: ${path}`);
  }

  if (!envelope || typeof envelope !== "object" || typeof envelope.id !== "string") {
    throw new Error(`Cloud export missing id: ${path}`);
  }

  const { project, cwd } = projectFromCloudRepos(envelope.source?.repos ?? []);
  const events = parseCloudEnvelope(envelope);
  return {
    sessionId: envelope.id,
    project,
    cwd,
    createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt : "",
    events,
  };
}
