---
title: Session search + transcript read (MCP tools)
date: 2026-07-28
status: draft
supersedes: []
related:
  - server/services/session-search.ts
  - server/services/sessions.ts
  - server/db/schema/messages.ts
  - server/db/schema/tool-events.ts
  - server/lib/agent/tools.ts
  - server/lib/mcp/server.ts
  - docs/handovers/2026-07-15-session-project-reassignment.md
---

# Session search + transcript read (MCP tools)

## Problem

MyMind ingests every Claude Code session (transcript messages + tool events, project-associated) and
already runs **hybrid search** over sessions and messages (`server/services/session-search.ts` —
trigram + vector, RRF-fused). But none of it is reachable from an MCP client: the tool registry
(`server/lib/agent/tools.ts`, exposed over MCP by `server/lib/mcp/server.ts`) has `search_docs`,
`search_passages`, `search_memories`, `search_tasks`, `search_projects` — but **nothing for
sessions**. So Claude Code cannot ask its own second brain "where did we discuss X" and then read the
relevant transcript.

Two halves are missing:

1. **Search exposure** — wrap the existing session/message search as MCP tools.
2. **Transcript reading** — there is no LLM-safe way to *read* a transcript after a hit.
   `getSessionMessages(id)` (`server/services/sessions.ts`) returns the session's **entire** message
   list + **all** tool events with no bound. Sessions are large (see Evidence), so that is unusable
   for an LLM consumer — it would dump millions of tokens.

## Evidence (dev DB, 2026-07-28)

- 463 sessions, **96,737 messages**, 8,460 sidechain (subagent) messages.
- Roles are only `user` / `assistant`. **Tool calls/outputs are NOT messages** — they live in a
  separate `tool_events` table (`toolName`, `args`, `result`, `exitStatus`, `phase`, `messageId`).
  So the message stream is relatively clean prose; tool noise is separable.
- Message sizes: assistant avg 110 chars, user avg 615 — but a single message reaches **279,751
  chars** (pasted content / large tool results in a user turn).
- ~28% of messages are embedded. This is **by design**: `server/services/message-embedding.ts` gates
  on `length(content) >= MIN_CHARS`, so short stubs are deliberately skipped. The vector lane covers
  substantive messages; the trigram lane covers 100% for exact-keyword hits.

## Goals

1. Claude Code (and the in-app agent) can **search sessions and messages** over MCP with the existing
   hybrid quality.
2. After a hit, it can **read the conversation around that message** and **page through the whole
   transcript** — both bounded so a single call is context-safe.
3. Reads surface **what actually ran** (tool events interleaved), with **noise controls** (sidechain
   excluded by default, huge content truncated, `full` opt-out).
4. Zero new UI, zero migration — reuse the existing search services, tables, and MCP exposure.

## Non-goals

- **No reranker.** The hybrid RRF is enough for v1. (The repo's `mxbai-rerank-large-v2` is not wired
  into session search and stays that way here.)
- **No message-embedding backfill.** The `MIN_CHARS` skip is intentional, not a gap.
- **No new UI.** The web already has global session search + `/sessions/[id]`. This is purely the
  MCP/agent tool surface.
- **No write/mutation tools.** All four tools are `kind: 'read'`.

## Design

Four tools on the shared `agentTools` registry (`server/lib/agent/tools.ts`), all `kind: 'read'`,
none `dangerous` — so `server/lib/mcp/server.ts` (`agentTools.filter(t => !t.dangerous)`) exposes
them over MCP automatically, and the in-app agent gains them too. Search reuses the existing
services; reads use a new bounded service.

### 1. `search_messages` — the primary "find keyword references" tool

```
schema: {
  query: z.string().describe('What to find in session transcripts'),
  project?: z.string().describe('Restrict to a project slug'),
  session?: z.string().describe('Restrict to one session id'),
  limit?: z.number().int().min(1).max(25).default(8)
}
```
Reuses `searchMessages` (hybrid). Returns:
```
{ results: [{ messageId, sessionId, role, snippet, createdAt, sessionTitle, project }] }
```
- **Snippet is match-centered** (enhancement — see §5), not the first 160 chars.
- `project`/`session` are **new optional filters** added to `searchMessages` (both lanes filter by
  the denormalized `messages`/`sessions` columns; `session` filters `messages.sessionId`).
- Sidechain excluded by default (a `messages.isSidechain = false` predicate in both lanes).
- `summary`: `"searched messages (N hits)"`.

### 2. `search_sessions` — session-level topic search

```
schema: {
  query: z.string(),
  project?: z.string(),
  limit?: z.number().int().min(1).max(25).default(8)
}
```
Reuses `searchSessions` (hybrid over title + summary). Returns:
```
{ results: [{ sessionId, title, snippet, project, startedAt, messageCount }] }
```
`project` is a new optional filter on `searchSessions`. For "which session was about X" when there is
no exact keyword to grep for.

### 3. `read_around_message` — zoom on a hit

```
schema: {
  messageId: z.string().describe('A message id, e.g. from search_messages'),
  radius?: z.number().int().min(0).max(30).default(8).describe('Messages before/after to include'),
  full?: z.boolean().default(false).describe('Return untruncated content'),
  includeSidechain?: z.boolean().default(false)
}
```
Backed by new `readAroundMessage(messageId, opts)`:
1. Load the focal message → its `sessionId` + `createdAt`. (404-shaped result if missing.)
2. Select the `radius` messages strictly **before** (by `createdAt`, desc, limit radius) and `radius`
   **after** (asc, limit radius) in the same session, plus the focal message.
3. Merge with the `tool_events` for those messages, ordered chronologically by `createdAt`.
4. Apply truncation (§4) unless `full`.
Returns:
```
{ sessionId, sessionTitle, project, focalMessageId,
  items: [ MessageItem | ToolEventItem, ... ] }  // chronological
```

### 4. `read_session` — page through the transcript

```
schema: {
  sessionId: z.string(),
  offset?: z.number().int().min(0).default(0),
  limit?: z.number().int().min(1).max(50).default(25),
  full?: z.boolean().default(false),
  includeSidechain?: z.boolean().default(false)
}
```
Backed by new `readSessionPage(sessionId, opts)`: session meta + one page of messages (chronological,
`offset`/`limit`) with their tool events interleaved, truncation applied unless `full`.
Returns:
```
{ session: { id, title, project, startedAt, endedAt, messageCount },
  offset, limit, returned, hasMore,
  items: [ MessageItem | ToolEventItem, ... ] }
```
`messageCount` + `hasMore` let the consumer decide whether to page further.

### 5. Shared item shapes, truncation, and the match-centered snippet

New `server/services/session-read.ts` owns the read logic and these shapes:
```
MessageItem   = { kind: 'message', id, role, content, thinking?, createdAt, truncated?: number }
ToolEventItem = { kind: 'tool', id, toolName, exitStatus, phase, argsSnippet, resultSnippet,
                  createdAt, truncated?: number }
```
- **Truncation (default, `full=false`):** message `content` capped at `CONTENT_CAP` (2000 chars),
  `thinking` dropped unless `full`; tool `args`/`result` stringified + capped at `TOOL_CAP` (600
  chars). Every cap sets `truncated` to the number of chars omitted so the consumer knows to
  `read_around_message(..., full: true)` if it needs the rest.
- **Interleave:** messages and tool events are merged by `createdAt` into one chronological array —
  the transcript reads in order, with each tool event sitting after the assistant turn that issued it.
- **Match-centered snippet** (`search_messages`): a small `snippetAround(content, query)` helper —
  find the first case-insensitive occurrence of `query`, return a ±120-char window around it (with
  `…` elision); fall back to the head when there is no literal match (a pure vector hit). Lives in
  `session-read.ts`, reused by the search tool handler.

### 6. Wiring

- `session-search.ts`: add **backward-compatible optional** `project` (both) + `session` (messages)
  filter params and the sidechain-exclusion predicate to `searchSessions`/`searchMessages` (existing
  callers pass nothing → unchanged behavior). The extra display fields the tools need
  (`sessionTitle`, `createdAt`, `messageCount`) are **hydrated in the tool handler** with a light
  select keyed on the returned ids — so the web DTOs in `shared/types/search.ts` and their consumers
  stay untouched.
- `session-read.ts` (new): `readAroundMessage`, `readSessionPage`, `snippetAround`, the item mappers,
  the caps.
- `server/lib/agent/tools.ts`: the four tool objects (`kind: 'read'`), near the other `search_*` /
  `read_*` tools. Handlers return `{ result, summary }`.
- `test/agent-tools.test.ts`: bump the registry-guard tool list (33 → 37) + names.

## Edge cases

- **Unknown `messageId`/`sessionId`** → `{ result: { error: '… not found' }, summary }`, never throw.
- **Focal message at the start/end of a session** → fewer than `radius` neighbors on that side; no
  error, no cross-session bleed (all queries scope by `sessionId`).
- **`offset` past the end** in `read_session` → `items: []`, `hasMore: false`, `returned: 0`.
- **Empty `query`** → `{ results: [] }` (the services already short-circuit `!q.trim()`).
- **Vector lane down** (embedding rig unreachable) → search degrades to trigram-only (the services
  already `try/catch` the vector lane); reads are unaffected (no embeddings involved).
- **Huge single message even after cap** → capped to `CONTENT_CAP` with `truncated`; `full: true`
  returns it whole (consumer's explicit token choice).
- **Sidechain** — excluded by default in both search and read; `includeSidechain: true` surfaces
  subagent/Task threads.

## Testing

Unit tests (real dev DB, as the repo does for DB-backed services):
- `readSessionPage`: page bounds (offset/limit, `hasMore`/`returned`), chronological message+tool
  interleave, truncation markers + `full` disables them, sidechain excluded by default / included on
  opt-in, session-meta fields present.
- `readAroundMessage`: correct neighborhood window, fewer neighbors at session edges, no cross-session
  bleed, 404-shaped result for a bad id.
- `snippetAround`: centers on the match, elides with `…`, falls back to head with no literal match.
- `searchMessages`/`searchSessions` filters: `project`/`session` narrow results; sidechain excluded.
- `test/agent-tools.test.ts`: registry guard lists the four new tools with `kind: 'read'`.

## Rollout

No migration, no UI, no kill-switch. Ship on `feat/session-search-mcp`; gates (typecheck / test /
build). Verify over the **public MCP** after deploy (the tools list gains the four; a real
`search_messages` → `read_around_message` round-trip returns a coherent windowed transcript). New
`docs/wiki/mcp.md` section (the tool surface) + roadmap row + handover.

## Open questions

1. **`role` filter on `search_messages`?** Deferred — v1 searches all non-sidechain roles; add
   `role?: 'user' | 'assistant'` later if assistant-turn noise proves a problem.
2. **Default `CONTENT_CAP`/`TOOL_CAP` values** (2000 / 600) — starting points; tune against real MCP
   usage, not guessed further here.
