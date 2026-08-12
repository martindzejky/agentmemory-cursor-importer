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

Actually write (review the dry-run first):

```bash
pnpm start --apply
```

## Safety

- Dry-run unless you pass `--apply`.
- Session-exists skip uses `GET /agentmemory/replay/sessions`. Progress lines print
  `skipped(exists)` / `skipped(before)` / `import` as each file is handled.
- Stable per-message `eventId`s so retries dedupe on the server. One id per imported
  prompt or assistant reply in that session, in file order. Examples for session
  `abc-123`:
  - `cursor-local:abc-123:u:0` (first user prompt)
  - `cursor-local:abc-123:a:1` (first assistant reply)
  - `cursor-local:abc-123:u:2` (second user prompt)
  - `cursor-local:abc-123:a:3` (second assistant reply)
    Re-running the same file with the same parser yields the same ids.

Do one real import only after you are happy with a dry-run summary.
