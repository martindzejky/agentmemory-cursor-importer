import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchCloudConversation,
  listCloudAgents,
  type CloudAgentListItem,
  type CloudConversationMessage,
  type CursorCloudClient,
} from "./cursor-cloud.js";

export type CloudExportEnvelope = {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: string;
  source: { repos: Array<{ url: string }> };
  messages: CloudConversationMessage[];
};

export type ExportCloudOptions = {
  outDir: string;
  /** Max agents to fetch conversations for (after list). */
  limit: number | null;
  signal?: AbortSignal;
  /** Checked between agents; return true to stop after the current one finishes. */
  shouldStop?: () => boolean;
  onProgress?: (line: string) => void;
};

export type ExportCloudSummary = {
  listed: number;
  written: number;
  skippedDeleted: number;
  skippedEmpty: number;
  failed: number;
  outDir: string;
};

function progressPrefix(indexOneBased: number, total: number): string {
  if (total <= 0) return "[100%]";
  const pct = Math.min(100, Math.round((indexOneBased / total) * 100));
  return `[${String(pct).padStart(3, " ")}%]`;
}

function toEnvelope(
  agent: CloudAgentListItem,
  messages: CloudConversationMessage[],
): CloudExportEnvelope {
  return {
    id: agent.id,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    name: agent.name,
    status: agent.status,
    source: { repos: agent.repos },
    messages,
  };
}

export async function exportCloudAgents(
  client: CursorCloudClient,
  opts: ExportCloudOptions,
): Promise<ExportCloudSummary> {
  const log = opts.onProgress ?? (() => {});
  await mkdir(opts.outDir, { recursive: true });

  log("Listing cloud agents via GET /v1/agents …");
  let agents = await listCloudAgents(client, { signal: opts.signal });
  // Oldest first so progress feels chronological; API returns newest first.
  agents = agents.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (opts.limit !== null) agents = agents.slice(0, opts.limit);

  const listed = agents.length;
  log(`Agents to fetch: ${listed}`);

  let written = 0;
  let skippedDeleted = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (let i = 0; i < agents.length; i++) {
    if (opts.signal?.aborted || opts.shouldStop?.()) break;

    const agent = agents[i];
    const prefix = progressPrefix(i + 1, listed);
    const result = await fetchCloudConversation(client, agent.id, opts.signal);

    if (!result.ok) {
      if (result.reason === "deleted") {
        skippedDeleted += 1;
        log(`${prefix} skipped(deleted) ${agent.id} ${agent.name}`);
      } else if (opts.signal?.aborted) {
        break;
      } else {
        failed += 1;
        log(
          `${prefix} failed ${agent.id} http=${result.status} ${result.detail.replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }
    } else if (result.messages.length === 0) {
      skippedEmpty += 1;
      log(`${prefix} skipped(empty) ${agent.id} ${agent.name}`);
    } else {
      const envelope = toEnvelope(agent, result.messages);
      const path = join(opts.outDir, `${agent.id}.json`);
      await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      written += 1;
      log(
        `${prefix} wrote ${agent.id} messages=${result.messages.length} created=${agent.createdAt}`,
      );
    }

    if (opts.shouldStop?.()) break;
  }

  return {
    listed,
    written,
    skippedDeleted,
    skippedEmpty,
    failed,
    outDir: opts.outDir,
  };
}
