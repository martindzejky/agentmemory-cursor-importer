# in agentmemory-cursor-importer

Local CLI that imports Cursor agent conversations into agentmemory over
`POST /agentmemory/observe/bulk` (one HTTP request per session, chunked at 500
events).

It supports two sources:

1. **Local transcripts** — Cursor desktop JSONL under `~/.cursor/projects/…`
2. **Cloud agents** — fetch conversations via the Cloud Agents HTTP API, store
   them under `tmp/cloud-agents/<id>.json`, then import those files the same way

Needs agentmemory with the bulk observe endpoint ([fork PR #19](https://github.com/martindzejky/agentmemory/pull/19)).

## Setup

Needs Node 24 and pnpm 11.

```bash
corepack enable
pnpm install
cp .env.example .env
# AGENTMEMORY_URL + AGENTMEMORY_SECRET  (imports)
# CURSOR_API_KEY                        (export-cloud only)
```

## Commands

```bash
# Local desktop transcripts → agentmemory (dry-run by default)
node dist/cli.js [--apply] [--path DIR] [--before ISO] [--limit N]

# Download cloud agent conversations to disk
node dist/cli.js export-cloud [--out DIR] [--limit N]

# Exported cloud JSON → agentmemory (dry-run by default)
node dist/cli.js import-cloud [--apply] [--path DIR] [--before ISO] [--limit N]
```

Run the built binary with `node dist/cli.js …` (not `pnpm start`) so Ctrl+C soft-stop works.

## Local import

Walks `~/.cursor/projects/*/agent-transcripts/<uuid>/<uuid>.jsonl` (parent chats
only; skips `subagents/`).

| JSONL role                | Observation                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `user`                    | `prompt_submit` (`data.prompt`, prefers `<user_query>` body) |
| `assistant`               | `assistant_response` (`data.assistantResponse`)              |
| `tool_use` / `turn_ended` | ignored                                                      |

Skips a file when that `sessionId` already exists on the server.

**Timestamps:** clock starts at file birthtime (else mtime). A user
`<timestamp>…</timestamp>` tag sets the clock; every other message advances +1ms.

```bash
pnpm build && node dist/cli.js              # dry-run
node dist/cli.js --apply                    # write
node dist/cli.js --before 2026-08-09T00:00:00.000Z
```

## Cloud export

Uses `CURSOR_API_KEY` (Basic auth against `https://api.cursor.com`):

1. `GET /v1/agents` — list all agents (includes `createdAt` + `updatedAt`)
2. `GET /v0/agents/{id}/conversation` — user/assistant text

Writes one envelope per readable session to `tmp/cloud-agents/<id>.json`
(override with `--out`). Skips deleted agents and empty conversations. Does not
call agentmemory.

```bash
pnpm build && node dist/cli.js export-cloud
```

Envelope shape:

```json
{
  "id": "bc-…",
  "createdAt": "…",
  "updatedAt": "…",
  "name": "…",
  "status": "…",
  "source": { "repos": [{ "url": "…" }] },
  "messages": [{ "id": "…", "type": "user_message", "text": "…" }]
}
```

## Cloud import

Reads `tmp/cloud-agents/*.json` by default (override with `--path`) and posts
through the same bulk observe path as local import.

| Field             | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| `sessionId`       | cloud agent id (`bc-…`)                                 |
| `eventId`         | `cursor-cloud:{sessionId}:{messageId}`                  |
| timestamps        | evenly spaced `createdAt` → `updatedAt` (+1ms if equal) |
| `project` / `cwd` | from the first repo URL in the envelope                 |

Skips sessions already on the server (including ones captured live by hooks).

```bash
pnpm build && node dist/cli.js import-cloud           # dry-run
node dist/cli.js import-cloud --apply                 # write
node dist/cli.js import-cloud --before 2026-08-08
```

## Safety

- Imports are dry-run unless you pass `--apply`.
- For large historical imports, turn **off** `AGENTMEMORY_AUTO_COMPRESS`
  first (each event otherwise triggers LLM compression). Re-enable when the run finishes.
- Session-exists skip: `GET /agentmemory/replay/sessions`.
- Ctrl+C once finishes the current session/agent, then stops. Ctrl+C again aborts
  immediately (may leave a partial session — forget it if you need a clean re-import).
- Stable `eventId`s for dedupe:
  - Local: `cursor-local:{sessionId}:u|a:{n}`
  - Cloud: `cursor-cloud:{sessionId}:{messageId}`

Do a dry-run and check the summary before `--apply`.
