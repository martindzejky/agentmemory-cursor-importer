#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listSessionIds, OBSERVE_BULK_MAX, type AgentmemoryClient } from "./client.js";
import { loadDotEnv, requireEnv } from "./env.js";
import { exportCloudAgents } from "./export-cloud.js";
import { printImportSummary, runImportJobs, type ImportJob } from "./import-run.js";
import { parseCloudExportFile } from "./parse-cloud.js";
import { parseTranscriptFile } from "./parse.js";
import { decodeProjectSlug } from "./project.js";
import { findCloudExportFiles } from "./walk-cloud.js";
import { findParentTranscripts } from "./walk.js";

type ImportOptions = {
  apply: boolean;
  path: string;
  before: string | null;
  limit: number | null;
};

type ExportCloudOptions = {
  outDir: string;
  limit: number | null;
};

type RunState = {
  stopAfterCurrent: boolean;
  hardStop: boolean;
  abortController: AbortController | null;
};

function printHelp(): void {
  console.log(`Import local or exported cloud Cursor transcripts into agentmemory,
or export cloud agent conversations to disk.

Usage:
  node dist/cli.js [--apply] [--path DIR] [--before ISO] [--limit N]
  node dist/cli.js export-cloud [--out DIR] [--limit N]
  node dist/cli.js import-cloud [--apply] [--path DIR] [--before ISO] [--limit N]

Local import defaults to dry-run (no writes). Pass --apply to POST
/agentmemory/observe/bulk (one request per session, chunked at ${OBSERVE_BULK_MAX}).

export-cloud lists agents via GET /v1/agents and writes readable conversations
from GET /v0/agents/{id}/conversation to tmp/cloud-agents/<id>.json
(skips deleted/empty). Does not touch agentmemory.

import-cloud reads those JSON envelopes (default tmp/cloud-agents) and posts
user/assistant messages the same way as local import. Timestamps are spread
evenly between createdAt and updatedAt. eventIds: cursor-cloud:{id}:{msgId}.
Skips sessionIds already on the server.

Ctrl+C once: finish the current session/agent, then stop.
Ctrl+C twice: abort immediately (may leave a partial session).

Env:
  AGENTMEMORY_URL / AGENTMEMORY_SECRET  (local import, import-cloud)
  CURSOR_API_KEY                        (export-cloud)

Local timestamps:
  Start from file birthtime (else mtime).
  A user <timestamp> tag sets the clock.
  Anything without a tag advances +1ms.

Before import-cloud --apply: turn OFF AGENTMEMORY_AUTO_COMPRESS on Railway.
`);
}

function parseImportArgs(argv: string[], defaults: ImportOptions): ImportOptions {
  const opts: ImportOptions = { ...defaults };

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
      opts.path = resolve(argv[++i] ?? "");
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

function parseExportCloudArgs(argv: string[]): ExportCloudOptions {
  const opts: ExportCloudOptions = {
    outDir: resolve(process.cwd(), "tmp", "cloud-agents"),
    limit: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--out") {
      opts.outDir = resolve(argv[++i] ?? "");
      if (!opts.outDir) throw new Error("--out needs a directory");
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

function installSigint(state: RunState): void {
  let count = 0;
  process.on("SIGINT", () => {
    count += 1;
    if (count === 1) {
      state.stopAfterCurrent = true;
      console.log("");
      console.log("Finishing the current item. Press Ctrl+C again to terminate immediately.");
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

function agentmemoryClient(): AgentmemoryClient {
  return {
    baseUrl: requireEnv("AGENTMEMORY_URL").replace(/\/$/, ""),
    secret: requireEnv("AGENTMEMORY_SECRET"),
  };
}

async function runExportCloud(argv: string[]): Promise<void> {
  const opts = parseExportCloudArgs(argv);
  const apiKey = requireEnv("CURSOR_API_KEY");

  const state: RunState = {
    stopAfterCurrent: false,
    hardStop: false,
    abortController: new AbortController(),
  };
  installSigint(state);

  console.log(`Mode: export-cloud`);
  console.log(`Output: ${opts.outDir}`);
  if (opts.limit !== null) console.log(`Limit: ${opts.limit}`);

  try {
    const abortController = state.abortController;
    if (!abortController) throw new Error("missing abort controller");

    const summary = await exportCloudAgents(
      { apiKey },
      {
        outDir: opts.outDir,
        limit: opts.limit,
        signal: abortController.signal,
        shouldStop: () => state.stopAfterCurrent || state.hardStop,
        onProgress: (line) => console.log(line),
      },
    );

    console.log("");
    console.log("Summary");
    console.log(`  listed: ${summary.listed}`);
    console.log(`  written: ${summary.written}`);
    console.log(`  skipped (deleted): ${summary.skippedDeleted}`);
    console.log(`  skipped (empty): ${summary.skippedEmpty}`);
    console.log(`  failed: ${summary.failed}`);
    console.log(`  out: ${summary.outDir}`);
    if (state.hardStop || state.stopAfterCurrent) {
      console.log(`  status: stopped early`);
      process.exit(130);
    }
  } catch (err) {
    if (state.hardStop || isAbortError(err)) {
      console.log("");
      console.log("Summary");
      console.log("  status: interrupted");
      process.exit(130);
    }
    throw err;
  }
}

async function runImportWithJobs(
  label: string,
  opts: ImportOptions,
  jobs: ImportJob[],
): Promise<void> {
  const cutoff = beforeCutoffMs(opts.before);
  const client = agentmemoryClient();

  console.log(
    opts.apply ? `Mode: ${label} APPLY (writes enabled)` : `Mode: ${label} dry-run (no writes)`,
  );
  console.log(`Path: ${opts.path}`);

  const existing = await listSessionIds(client);
  console.log(`Sessions already on server: ${existing.size}`);

  const totalFiles = jobs.length;
  console.log(`Files found: ${totalFiles}`);

  const state: RunState = {
    stopAfterCurrent: false,
    hardStop: false,
    abortController: null,
  };
  installSigint(state);

  const result = await runImportJobs({
    apply: opts.apply,
    cutoffMs: cutoff,
    client,
    jobs,
    existing,
    shouldStop: () => state.stopAfterCurrent,
    isHardStop: () => state.hardStop,
    setAbortController: (controller) => {
      state.abortController = controller;
    },
    isAbortError,
  });

  printImportSummary(result, { apply: opts.apply, totalFiles });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

async function runImportLocal(argv: string[]): Promise<void> {
  const opts = parseImportArgs(argv, {
    apply: false,
    path: join(homedir(), ".cursor", "projects"),
    before: null,
    limit: null,
  });

  let files = await findParentTranscripts(opts.path);
  if (opts.limit !== null) files = files.slice(0, opts.limit);

  const jobs: ImportJob[] = files.map((file) => {
    const { project, cwd } = decodeProjectSlug(file.projectSlug);
    return {
      sessionId: file.sessionId,
      projectHint: project,
      load: async () => ({
        project,
        cwd,
        events: await parseTranscriptFile(file.path, file.sessionId),
      }),
    };
  });

  await runImportWithJobs("local import", opts, jobs);
}

async function runImportCloud(argv: string[]): Promise<void> {
  const opts = parseImportArgs(argv, {
    apply: false,
    path: resolve(process.cwd(), "tmp", "cloud-agents"),
    before: null,
    limit: null,
  });

  let files = await findCloudExportFiles(opts.path);
  if (opts.limit !== null) files = files.slice(0, opts.limit);

  const jobs: ImportJob[] = files.map((file) => ({
    sessionId: file.sessionId,
    projectHint: "cloud",
    load: async () => {
      const parsed = await parseCloudExportFile(file.path);
      return {
        project: parsed.project,
        cwd: parsed.cwd,
        events: parsed.events,
      };
    },
  }));

  await runImportWithJobs("import-cloud", opts, jobs);
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "export-cloud") {
    await runExportCloud(argv.slice(1));
    return;
  }

  if (command === "import-cloud") {
    await runImportCloud(argv.slice(1));
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  await runImportLocal(argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
