#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { listSessionIds, postObserve, type AgentmemoryClient } from "./client.js";
import { loadDotEnv, requireEnv } from "./env.js";
import { parseTranscriptFile } from "./parse.js";
import { decodeProjectSlug } from "./project.js";
import { findParentTranscripts } from "./walk.js";

type Options = {
  apply: boolean;
  path: string;
  before: string | null;
  limit: number | null;
};

function printHelp(): void {
  console.log(`Import local Cursor agent transcripts into agentmemory.

Usage:
  pnpm start [--apply] [--path DIR] [--before ISO] [--limit N]

Defaults to dry-run (no writes). Pass --apply to POST /agentmemory/observe.

Env:
  AGENTMEMORY_URL
  AGENTMEMORY_SECRET

Timestamps:
  Start from file birthtime (else mtime).
  A user <timestamp> tag sets the clock.
  Anything without a tag advances +1ms.
`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apply: false,
    path: join(homedir(), ".cursor", "projects"),
    before: null,
    limit: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--apply") {
      opts.apply = true;
      continue;
    }
    if (arg === "--path") {
      opts.path = argv[++i] ?? "";
      if (!opts.path) throw new Error("--path needs a directory");
      continue;
    }
    if (arg === "--before") {
      opts.before = argv[++i] ?? "";
      if (!opts.before) throw new Error("--before needs an ISO date");
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--limit needs a positive integer");
      opts.limit = n;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function beforeCutoffMs(before: string | null): number | null {
  if (!before) return null;
  const ms = Date.parse(before);
  if (Number.isNaN(ms)) throw new Error(`Invalid --before value: ${before}`);
  return ms;
}

async function main(): Promise<void> {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));
  const cutoff = beforeCutoffMs(opts.before);

  const client: AgentmemoryClient = {
    baseUrl: requireEnv("AGENTMEMORY_URL").replace(/\/$/, ""),
    secret: requireEnv("AGENTMEMORY_SECRET"),
  };

  console.log(opts.apply ? "Mode: APPLY (writes enabled)" : "Mode: dry-run (no writes)");
  console.log(`Transcripts root: ${opts.path}`);

  const existing = await listSessionIds(client);
  console.log(`Sessions already on server: ${existing.size}`);

  let files = await findParentTranscripts(opts.path);
  if (opts.limit !== null) files = files.slice(0, opts.limit);
  console.log(`Parent transcript files found: ${files.length}`);

  let skippedExists = 0;
  let skippedBefore = 0;
  let importedSessions = 0;
  let posted = 0;
  let deduped = 0;
  let failed = 0;
  let plannedEvents = 0;

  for (const file of files) {
    if (existing.has(file.sessionId)) {
      skippedExists += 1;
      continue;
    }

    const { project, cwd } = decodeProjectSlug(file.projectSlug);
    const events = await parseTranscriptFile(file.path, file.sessionId);
    if (events.length === 0) continue;

    if (cutoff !== null) {
      const first = Date.parse(events[0].timestamp);
      if (!Number.isNaN(first) && first >= cutoff) {
        skippedBefore += 1;
        continue;
      }
    }

    plannedEvents += events.length;
    importedSessions += 1;

    console.log(
      `${opts.apply ? "import" : "dry-run"} ${file.sessionId} project=${project} events=${events.length} first=${events[0].timestamp}`,
    );

    if (!opts.apply) continue;

    for (const event of events) {
      const payload =
        event.hookType === "prompt_submit"
          ? {
              hookType: "prompt_submit",
              sessionId: file.sessionId,
              project,
              cwd,
              agentId: "cursor",
              timestamp: event.timestamp,
              eventId: event.eventId,
              data: { prompt: event.text },
            }
          : {
              hookType: "assistant_response",
              sessionId: file.sessionId,
              project,
              cwd,
              agentId: "cursor",
              timestamp: event.timestamp,
              eventId: event.eventId,
              data: { assistantResponse: event.text },
            };

      const result = await postObserve(client, payload);
      if (!result.ok) {
        failed += 1;
        console.error(`  fail ${event.eventId}: ${result.error}`);
        continue;
      }
      if (result.deduplicated) deduped += 1;
      else posted += 1;
    }
  }

  console.log("");
  console.log("Summary");
  console.log(`  sessions skipped (exists): ${skippedExists}`);
  console.log(`  sessions skipped (--before): ${skippedBefore}`);
  console.log(`  sessions ${opts.apply ? "imported" : "would import"}: ${importedSessions}`);
  console.log(
    `  events ${opts.apply ? "posted" : "planned"}: ${opts.apply ? posted : plannedEvents}`,
  );
  if (opts.apply) {
    console.log(`  events deduplicated: ${deduped}`);
    console.log(`  events failed: ${failed}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
