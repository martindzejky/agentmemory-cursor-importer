# agentmemory-cursor-importer

Small local CLI. Reads Cursor agent transcript JSONL from disk and posts user prompts plus assistant replies into a remote agentmemory over `POST /agentmemory/observe/bulk`.

One HTTP request per session (chunked at 500 events if needed).

Also exports Cursor Cloud agent conversations via the Cloud Agents HTTP API into
`tmp/cloud-agents/<id>.json`, then imports those envelopes into agentmemory.

Needs agentmemory with the bulk observe endpoint (fork PR #19).

## Setup

Needs Node 24 and pnpm 11.

```bash
corepack enable
pnpm install
cp .env.example .env
# fill AGENTMEMORY_URL and AGENTMEMORY_SECRET
# for export-cloud, also fill CURSOR_API_KEY
```

## What it imports (local)

Walks `~/.cursor/projects/*/agent-transcripts/<uuid>/<uuid>.jsonl` (parent chats only). Skips `subagents/`.

For each line:

- `role: user` → `prompt_submit` (`data.prompt`, prefers `<user_query>` body)
- `role: assistant` → `assistant_response` (`data.assistantResponse`)
- ignores `tool_use` and `turn_ended`

Skips a file when that `sessionId` already exists on the server.

## Timestamps (local)

Each file starts a clock at birthtime, or mtime if birthtime is missing.

- A user message with `<timestamp>...</timestamp>` sets the clock to that value.
- Every other imported message uses previous timestamp + 1ms.

So older chats stay in the past instead of collapsing to "today".

## Usage

### Local import

Dry-run (default, no writes):

```bash
pnpm dev
```

Limit how many files you inspect:

```bash
pnpm start --limit 5
```

Only sessions whose first event is before a date:

```bash
pnpm start --before 2026-08-09T00:00:00.000Z
```

Actually write (review the dry-run first). Run the built file directly, not through
`pnpm`, so Ctrl+C works as described below:

```bash
pnpm build && node dist/cli.js --apply
```

### Cloud export (Phase 1)

Lists all cloud agents (`GET /v1/agents`, for `createdAt` + `updatedAt`), fetches each conversation (`GET /v0/agents/{id}/conversation`), and writes one JSON envelope per readable session:

```bash
pnpm build && node dist/cli.js export-cloud
```

Default output: `tmp/cloud-agents/<id>.json`. Override with `--out DIR`. Optional `--limit N` after the list is sorted oldest-first.

Skips deleted agents and empty conversations. Envelope shape:

```json
{
  "id": "bc-…",
  "createdAt": "…",
  "updatedAt": "…",
  "name": "…",
  "status": "…",
  "source": { "repos": [{ "url": "…" }] },
  "messages": [{ "id": "msg_…", "type": "user_message", "text": "…" }]
}
```

Needs `CURSOR_API_KEY` in `.env`. Does not call agentmemory.

### Cloud import

Reads `tmp/cloud-agents/*.json` (override with `--path DIR`) and posts to
`/agentmemory/observe/bulk` using the same path as local import.

```bash
# dry-run first
pnpm build && node dist/cli.js import-cloud --limit 5

# apply (turn OFF AGENTMEMORY_AUTO_COMPRESS on Railway first)
node dist/cli.js import-cloud --apply
```

- `sessionId` = cloud agent id (`bc-…`)
- `eventId` = `cursor-cloud:{sessionId}:{messageId}`
- Timestamps: evenly spaced from envelope `createdAt` → `updatedAt` (or +1ms if equal)
- `project` / `cwd` from the first repo URL in the envelope
- Skips sessions already present on the server (including ones captured live by hooks)

## Safety

- Imports are dry-run unless you pass `--apply`.
- Before `import-cloud --apply`, turn **off** `AGENTMEMORY_AUTO_COMPRESS` on Railway.
  Re-enable after the run finishes.
- Session-exists skip uses `GET /agentmemory/replay/sessions`. Progress lines print
  `[ 12%] skipped(exists)|skipped(before)|import|dry-run ...` as each file is handled.
- Ctrl+C once finishes the current session/agent, then stops. Ctrl+C again aborts immediately
  and prints the partial session id when importing (forget that session if you need a clean re-import).
  The summary always prints, including files remaining. This needs `node dist/cli.js`:
  under `pnpm` one Ctrl+C arrives as two SIGINTs and aborts on the spot.
- Stable per-message `eventId`s so retries dedupe on the server.
  - Local session `abc-123`: `cursor-local:abc-123:u:0`, `cursor-local:abc-123:a:1`, …
  - Cloud session `bc-…`: `cursor-cloud:bc-…:{messageId}`

Do one real import only after you are happy with a dry-run summary.
