# agentmemory-cursor-importer

Small local CLI. Reads Cursor agent transcript JSONL from disk and posts user prompts plus assistant replies into a remote agentmemory over `POST /agentmemory/observe/bulk`.

One HTTP request per session (chunked at 500 events if needed). Cloud transcripts are out of scope.

Needs agentmemory with the bulk observe endpoint (fork PR #19).

## Setup

Needs Node 24 and pnpm 11.

```bash
corepack enable
pnpm install
cp .env.example .env
# fill AGENTMEMORY_URL and AGENTMEMORY_SECRET
```

## What it imports

Walks `~/.cursor/projects/*/agent-transcripts/<uuid>/<uuid>.jsonl` (parent chats only). Skips `subagents/`.

For each line:

- `role: user` → `prompt_submit` (`data.prompt`, prefers `<user_query>` body)
- `role: assistant` → `assistant_response` (`data.assistantResponse`)
- ignores `tool_use` and `turn_ended`

Skips a file when that `sessionId` already exists on the server.

## Timestamps

Each file starts a clock at birthtime, or mtime if birthtime is missing.

- A user message with `<timestamp>...</timestamp>` sets the clock to that value.
- Every other imported message uses previous timestamp + 1ms.

So older chats stay in the past instead of collapsing to "today".

## Usage

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

## Safety

- Dry-run unless you pass `--apply`.
- Session-exists skip uses `GET /agentmemory/replay/sessions`. Progress lines print
  `[ 12%] skipped(exists)|skipped(before)|import|dry-run ...` as each file is handled.
- Ctrl+C once finishes the current session, then stops. Ctrl+C again aborts immediately
  and prints the partial session id (forget that session if you need a clean re-import).
  The summary always prints, including files remaining. This needs `node dist/cli.js`:
  under `pnpm` one Ctrl+C arrives as two SIGINTs and aborts on the spot.
- Stable per-message `eventId`s so retries dedupe on the server. One id per imported
  prompt or assistant reply in that session, in file order. Examples for session
  `abc-123`:
  - `cursor-local:abc-123:u:0` (first user prompt)
  - `cursor-local:abc-123:a:1` (first assistant reply)
  - `cursor-local:abc-123:u:2` (second user prompt)
  - `cursor-local:abc-123:a:3` (second assistant reply)
    Re-running the same file with the same parser yields the same ids.

Do one real import only after you are happy with a dry-run summary.
