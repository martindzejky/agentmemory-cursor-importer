import { readFile, stat } from "node:fs/promises";
import { extractTimestampTag, TimestampCursor } from "./timestamps.js";

export type ImportEvent = {
  hookType: "prompt_submit" | "assistant_response";
  text: string;
  timestamp: string;
  eventId: string;
};

type ContentPart = {
  type?: string;
  text?: string;
};

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as ContentPart;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

function extractUserPrompt(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  const body = (m ? m[1] : text).trim();
  return body;
}

function extractAssistantText(text: string): string {
  return text.trim();
}

async function fileAnchorMs(path: string): Promise<number> {
  const st = await stat(path);
  const birth = Number((st as { birthtimeMs?: number }).birthtimeMs ?? 0);
  if (birth > 0) return birth;
  return st.mtimeMs;
}

export async function parseTranscriptFile(path: string, sessionId: string): Promise<ImportEvent[]> {
  const raw = await readFile(path, "utf8");
  const clock = new TimestampCursor(await fileAnchorMs(path));
  const events: ImportEvent[] = [];
  let index = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = obj.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = textFromMessage(obj.message);
    if (!text.trim()) continue;

    if (role === "user") {
      const prompt = extractUserPrompt(text);
      if (!prompt) continue;
      const explicit = extractTimestampTag(text);
      const timestamp = clock.next(explicit);
      events.push({
        hookType: "prompt_submit",
        text: prompt,
        timestamp,
        eventId: `cursor-local:${sessionId}:u:${index}`,
      });
      index += 1;
      continue;
    }

    const assistant = extractAssistantText(text);
    if (!assistant) continue;
    // Assistant lines never carry <timestamp>; advance 1ms from current.
    const timestamp = clock.next(null);
    events.push({
      hookType: "assistant_response",
      text: assistant,
      timestamp,
      eventId: `cursor-local:${sessionId}:a:${index}`,
    });
    index += 1;
  }

  return events;
}
