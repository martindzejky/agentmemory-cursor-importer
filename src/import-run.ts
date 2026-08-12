import {
  chunkObservations,
  OBSERVE_BULK_MAX,
  postObserveBulk,
  type AgentmemoryClient,
} from "./client.js";
import type { ImportEvent } from "./parse.js";

export type ImportJob = {
  sessionId: string;
  /** Used in skipped(exists) logs before the file is parsed. */
  projectHint: string;
  load: () => Promise<{ project: string; cwd: string; events: ImportEvent[] }>;
};

export type ImportRunOptions = {
  apply: boolean;
  cutoffMs: number | null;
  client: AgentmemoryClient;
  jobs: ImportJob[];
  existing: Set<string>;
  shouldStop: () => boolean;
  isHardStop: () => boolean;
  setAbortController: (controller: AbortController | null) => void;
  isAbortError: (err: unknown) => boolean;
};

export type ImportRunResult = {
  exitCode: number;
  skippedExists: number;
  skippedBefore: number;
  skippedEmpty: number;
  importedSessions: number;
  posted: number;
  deduped: number;
  failed: number;
  plannedEvents: number;
  filesHandled: number;
  interruptedSessionId: string | null;
  stopAfterCurrent: boolean;
};

function progressPrefix(indexOneBased: number, total: number): string {
  if (total <= 0) return "[100%]";
  const pct = Math.min(100, Math.round((indexOneBased / total) * 100));
  return `[${String(pct).padStart(3, " ")}%]`;
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

export async function runImportJobs(opts: ImportRunOptions): Promise<ImportRunResult> {
  const totalFiles = opts.jobs.length;
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
  let hitSoftStop = false;

  for (let i = 0; i < opts.jobs.length; i++) {
    if (opts.shouldStop() || opts.isHardStop()) {
      hitSoftStop = opts.shouldStop();
      break;
    }

    const job = opts.jobs[i];
    const prefix = progressPrefix(i + 1, totalFiles);

    if (opts.existing.has(job.sessionId)) {
      skippedExists += 1;
      filesHandled += 1;
      console.log(`${prefix} skipped(exists) ${job.sessionId} project=${job.projectHint}`);
      if (opts.shouldStop() || opts.isHardStop()) {
        hitSoftStop = opts.shouldStop();
        break;
      }
      continue;
    }

    let project = job.projectHint;
    let cwd = "";
    let events: ImportEvent[];
    try {
      const loaded = await job.load();
      project = loaded.project;
      cwd = loaded.cwd;
      events = loaded.events;
    } catch (err) {
      if (opts.isHardStop() || opts.isAbortError(err)) {
        interruptedSessionId = job.sessionId;
        console.log(`Interrupted import of session ${job.sessionId}`);
        exitCode = 130;
        break;
      }
      throw err;
    }

    if (opts.isHardStop()) {
      interruptedSessionId = job.sessionId;
      console.log(`Interrupted import of session ${job.sessionId}`);
      exitCode = 130;
      break;
    }

    if (events.length === 0) {
      skippedEmpty += 1;
      filesHandled += 1;
      console.log(`${prefix} skipped(empty) ${job.sessionId} project=${project}`);
      if (opts.shouldStop() || opts.isHardStop()) {
        hitSoftStop = opts.shouldStop();
        break;
      }
      continue;
    }

    if (opts.cutoffMs !== null) {
      const first = Date.parse(events[0].timestamp);
      if (!Number.isNaN(first) && first >= opts.cutoffMs) {
        skippedBefore += 1;
        filesHandled += 1;
        console.log(
          `${prefix} skipped(before) ${job.sessionId} project=${project} first=${events[0].timestamp}`,
        );
        if (opts.shouldStop() || opts.isHardStop()) {
          hitSoftStop = opts.shouldStop();
          break;
        }
        continue;
      }
    }

    const chunks = chunkObservations(events, OBSERVE_BULK_MAX);
    console.log(
      `${prefix} ${opts.apply ? "import" : "dry-run"} ${job.sessionId} project=${project} events=${events.length} chunks=${chunks.length} first=${events[0].timestamp}`,
    );

    if (!opts.apply) {
      plannedEvents += events.length;
      importedSessions += 1;
      filesHandled += 1;
      if (opts.shouldStop() || opts.isHardStop()) {
        hitSoftStop = opts.shouldStop();
        break;
      }
      continue;
    }

    const observations = toObservations(events, job.sessionId, project, cwd);
    const observationChunks = chunkObservations(observations, OBSERVE_BULK_MAX);
    let sessionComplete = true;

    for (const chunk of observationChunks) {
      if (opts.isHardStop()) {
        sessionComplete = false;
        break;
      }

      const abortController = new AbortController();
      opts.setAbortController(abortController);
      try {
        const result = await postObserveBulk(opts.client, chunk, abortController.signal);
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
        if (opts.isHardStop() || opts.isAbortError(err)) {
          sessionComplete = false;
          break;
        }
        throw err;
      } finally {
        opts.setAbortController(null);
      }
    }

    if (!sessionComplete || opts.isHardStop()) {
      interruptedSessionId = job.sessionId;
      console.log(`Interrupted import of session ${job.sessionId}`);
      exitCode = 130;
      break;
    }

    plannedEvents += events.length;
    importedSessions += 1;
    filesHandled += 1;

    if (opts.shouldStop()) {
      hitSoftStop = true;
      break;
    }
  }

  return {
    exitCode,
    skippedExists,
    skippedBefore,
    skippedEmpty,
    importedSessions,
    posted,
    deduped,
    failed,
    plannedEvents,
    filesHandled,
    interruptedSessionId,
    stopAfterCurrent: hitSoftStop,
  };
}

export function printImportSummary(
  result: ImportRunResult,
  opts: { apply: boolean; totalFiles: number },
): void {
  const remaining = Math.max(
    0,
    opts.totalFiles - result.filesHandled - (result.interruptedSessionId ? 1 : 0),
  );
  let stopReason = "completed";
  if (result.interruptedSessionId) stopReason = "interrupted mid-session";
  else if (result.stopAfterCurrent && result.filesHandled < opts.totalFiles)
    stopReason = "stopped after session";

  console.log("");
  console.log("Summary");
  console.log(`  status: ${stopReason}`);
  console.log(`  files total: ${opts.totalFiles}`);
  console.log(`  files handled: ${result.filesHandled}`);
  console.log(`  files remaining: ${remaining}`);
  if (result.interruptedSessionId) {
    console.log(`  partial session (forget if needed): ${result.interruptedSessionId}`);
  }
  console.log(`  sessions skipped (exists): ${result.skippedExists}`);
  console.log(`  sessions skipped (--before): ${result.skippedBefore}`);
  if (result.skippedEmpty > 0) console.log(`  sessions skipped (empty): ${result.skippedEmpty}`);
  console.log(`  sessions ${opts.apply ? "imported" : "would import"}: ${result.importedSessions}`);
  console.log(
    `  events ${opts.apply ? "posted" : "planned"}: ${opts.apply ? result.posted : result.plannedEvents}`,
  );
  if (opts.apply) {
    console.log(`  events deduplicated: ${result.deduped}`);
    console.log(`  events failed: ${result.failed}`);
  }
}
