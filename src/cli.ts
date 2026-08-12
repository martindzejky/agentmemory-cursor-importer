#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chunkObservations,
  listSessionIds,
  OBSERVE_BULK_MAX,
  postObserveBulk,
  type AgentmemoryClient,
} from "./client.js";
import { loadDotEnv, requireEnv } from "./env.js";
import { parseTranscriptFile, type ImportEvent } from "./parse.js";
import { decodeProjectSlug } from "./project.js";
import { findParentTranscripts, type TranscriptFile } from "./walk.js";

type Options = {
  apply: boolean;
  path: string;
  before: string | null;
  limit: number | null;
};

type RunState = {
  stopAfterCurrent: boolean;
  hardStop: boolean;
  currentSessionId: string | null;
  abortController: AbortController | null;
};

function printHelp(): void {
  console.log(`Import local Cursor agent transcripts into agentmemory.

Usage:
  node dist/cli.js [--apply] [--path DIR] [--before ISO] [--limit N]

Defaults to dry-run (no writes). Pass --apply to POST /agentmemory/observe/bulk
(one request per session, chunked at ${OBSERVE_BULK_MAX} events).

Ctrl+C once: finish the current session, then stop.
Ctrl+C twice: abort immediately (may leave a partial session).

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

function toObservations(
  events: ImportEvent[],
  sessionId: string,
  project: string,
  cwd: string,
): Record<string, unknown>[] {
  return events.map((event) =>
    event.hookType === "prompt_submit"
      ? {
          hookType: "prompt_submit",
          sessionId,
          project,
          cwd,
          agentId: "cursor",
          timestamp: event.timestamp,
          eventId: event.eventId,
          data: { prompt: event.text },
        }
      : {
          hookType: "assistant_response",
          sessionId,
          project,
          cwd,
          agentId: "cursor",
          timestamp: event.timestamp,
          eventId: event.eventId,
          data: { assistantResponse: event.text },
        },
  );
}

function progressPrefix(indexOneBased: number, total: number): string {
  if (total <= 0) return "[100%]";
  const pct = Math.min(100, Math.round((indexOneBased / total) * 100));
  return `[${String(pct).padStart(3, " ")}%]`;
}

function installSigint(state: RunState): void {
  let count = 0;
  process.on("SIGINT", () => {
    count += 1;
    if (count === 1) {
      state.stopAfterCurrent = true;
      console.log("");
      console.log(
        "Finishing import of the current session. Press Ctrl+C again to terminate immediately.",
      );
      return;
    }
    state.hardStop = true;
    state.abortController?.abort();
  });
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name: unknown }).name) : "";
  return name === "AbortError";
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

  let files: TranscriptFile[] = await findParentTranscripts(opts.path);
  if (opts.limit !== null) files = files.slice(0, opts.limit);
  const totalFiles = files.length;
  console.log(`Parent transcript files found: ${totalFiles}`);

  const state: RunState = {
    stopAfterCurrent: false,
    hardStop: false,
    currentSessionId: null,
    abortController: null,
  };
  installSigint(state);

  let skippedExists = 0;
  let skippedBefore = 0;
  let skippedEmpty = 0;
  let importedSessions = 0;
  let posted = 0;
  let deduped = 0;
  let failed = 0;
  let plannedEvents = 0;
  let filesHandled = 0;
  let interruptedSessionId: string | null = null;
  let exitCode = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      if (state.stopAfterCurrent || state.hardStop) break;

      const file = files[i];
      const prefix = progressPrefix(i + 1, totalFiles);
      const { project, cwd } = decodeProjectSlug(file.projectSlug);
      state.currentSessionId = file.sessionId;

      if (existing.has(file.sessionId)) {
        skippedExists += 1;
        filesHandled += 1;
        console.log(`${prefix} skipped(exists) ${file.sessionId} project=${project}`);
        state.currentSessionId = null;
        if (state.stopAfterCurrent || state.hardStop) break;
        continue;
      }

      let events: ImportEvent[];
      try {
        events = await parseTranscriptFile(file.path, file.sessionId);
      } catch (err) {
        if (state.hardStop || isAbortError(err)) {
          interruptedSessionId = file.sessionId;
          console.log(`Interrupted import of session ${file.sessionId}`);
          exitCode = 130;
          break;
        }
        throw err;
      }

      if (state.hardStop) {
        interruptedSessionId = file.sessionId;
        console.log(`Interrupted import of session ${file.sessionId}`);
        exitCode = 130;
        break;
      }

      if (events.length === 0) {
        skippedEmpty += 1;
        filesHandled += 1;
        console.log(`${prefix} skipped(empty) ${file.sessionId} project=${project}`);
        state.currentSessionId = null;
        if (state.stopAfterCurrent || state.hardStop) break;
        continue;
      }

      if (cutoff !== null) {
        const first = Date.parse(events[0].timestamp);
        if (!Number.isNaN(first) && first >= cutoff) {
          skippedBefore += 1;
          filesHandled += 1;
          console.log(
            `${prefix} skipped(before) ${file.sessionId} project=${project} first=${events[0].timestamp}`,
          );
          state.currentSessionId = null;
          if (state.stopAfterCurrent || state.hardStop) break;
          continue;
        }
      }

      const chunks = chunkObservations(events, OBSERVE_BULK_MAX);
      console.log(
        `${prefix} ${opts.apply ? "import" : "dry-run"} ${file.sessionId} project=${project} events=${events.length} chunks=${chunks.length} first=${events[0].timestamp}`,
      );

      if (!opts.apply) {
        plannedEvents += events.length;
        importedSessions += 1;
        filesHandled += 1;
        state.currentSessionId = null;
        if (state.stopAfterCurrent || state.hardStop) break;
        continue;
      }

      const observations = toObservations(events, file.sessionId, project, cwd);
      const observationChunks = chunkObservations(observations, OBSERVE_BULK_MAX);
      let sessionComplete = true;

      for (const chunk of observationChunks) {
        if (state.hardStop) {
          sessionComplete = false;
          break;
        }

        state.abortController = new AbortController();
        try {
          const result = await postObserveBulk(client, chunk, state.abortController.signal);
          if (!result.ok) {
            failed += chunk.length;
            console.error(`  bulk fail (${chunk.length} events): ${result.error}`);
            continue;
          }
          posted += result.imported;
          deduped += result.deduplicated;
          failed += result.failed;
          for (const err of result.errors) {
            const where =
              err.eventId ?? (typeof err.index === "number" ? `index ${err.index}` : "item");
            console.error(`  fail ${where}: ${err.error}`);
          }
        } catch (err) {
          if (state.hardStop || isAbortError(err)) {
            sessionComplete = false;
            break;
          }
          throw err;
        } finally {
          state.abortController = null;
        }
      }

      if (!sessionComplete || state.hardStop) {
        interruptedSessionId = file.sessionId;
        console.log(`Interrupted import of session ${file.sessionId}`);
        exitCode = 130;
        state.currentSessionId = null;
        break;
      }

      plannedEvents += events.length;
      importedSessions += 1;
      filesHandled += 1;
      state.currentSessionId = null;

      if (state.stopAfterCurrent) break;
    }
  } finally {
    const remaining = Math.max(0, totalFiles - filesHandled - (interruptedSessionId ? 1 : 0));
    let stopReason = "completed";
    if (interruptedSessionId) stopReason = "interrupted mid-session";
    else if (state.stopAfterCurrent && filesHandled < totalFiles)
      stopReason = "stopped after session";

    console.log("");
    console.log("Summary");
    console.log(`  status: ${stopReason}`);
    console.log(`  files total: ${totalFiles}`);
    console.log(`  files handled: ${filesHandled}`);
    console.log(`  files remaining: ${remaining}`);
    if (interruptedSessionId) {
      console.log(`  partial session (forget if needed): ${interruptedSessionId}`);
    }
    console.log(`  sessions skipped (exists): ${skippedExists}`);
    console.log(`  sessions skipped (--before): ${skippedBefore}`);
    if (skippedEmpty > 0) console.log(`  sessions skipped (empty): ${skippedEmpty}`);
    console.log(`  sessions ${opts.apply ? "imported" : "would import"}: ${importedSessions}`);
    console.log(
      `  events ${opts.apply ? "posted" : "planned"}: ${opts.apply ? posted : plannedEvents}`,
    );
    if (opts.apply) {
      console.log(`  events deduplicated: ${deduped}`);
      console.log(`  events failed: ${failed}`);
    }
  }

  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
