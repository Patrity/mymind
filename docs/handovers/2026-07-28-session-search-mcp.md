---
title: Session search + transcript read (MCP tools) — cycle 50
cycle: 50
date: 2026-07-28
status: SHIPPED — merged to master (ff) + pushed 2026-07-28; CD run 30382810386 green; prod /api/health 200; all 4 tools live on the prod MCP (37 total). ✅ PROD round-trip proven: a semantic search_messages("navmesh pathfinding") returned real Unity-NavMesh hits (the VECTOR lane runs on prod — dev could only exercise trigram) and chained into read_around_message (7-item chronological window, focal present). Gates green (typecheck 0 / test 861 / build); final opus review = Ready-to-merge after its applied ordering fix. No migration/UI/mutations — nothing seeded. Deferred follow-ups below remain.
branch: feat/session-search-mcp (built subagent-driven, 5 tasks + 1 mid-flight fix + 1 final-review fix; per-task reports + ledger in .superpowers/sdd/)
docs:
  - ../wiki/mcp.md (living reference — new "Session search + transcript read" section + 4 table rows; updated 2026-07-28)
  - ../superpowers/specs/2026-07-28-session-search-mcp-design.md (spec; mirrored to MyMind doc "Spec — Session search…")
  - ../superpowers/plans/2026-07-28-session-search-mcp.md (plan)
  - ../superpowers/plans/00-roadmap.md (cycle-50 row added by this handover)
related:
  - ../handovers/2026-07-15-session-project-reassignment.md (the sessions/messages ingest + project association this searches over)
  - ../handovers/2026-07-24-agent-skills-subsystem-phase2.md (the prior cycle; the agentTools→MCP auto-exposure this reuses)
problem: >
  MyMind ingests every Claude Code session (transcript messages + tool events, project-associated)
  and already ran hybrid search over sessions/messages for the web UI — but none of it was on the
  MCP tool registry, so Claude Code could not ask its own second brain "where did we discuss X" and
  then read the transcript. Two gaps: the search wasn't MCP-exposed, and there was no LLM-safe way to
  READ a transcript after a hit (`getSessionMessages` returns the entire unbounded session; sessions
  reach ~200 messages and single messages up to 280k chars).
---

# Session search + transcript read (MCP tools) — cycle 50

## What shipped (branch `feat/session-search-mcp`, `4c76f83..8601901`)

Four new `kind:read` tools on the shared `agentTools` registry (`server/lib/agent/tools.ts`),
auto-exposed over MCP by `server/lib/mcp/server.ts` (which exposes every non-`dangerous` tool) and
gained by the in-app agent. **No migration, no UI, no mutations.**

- **`search_messages(query, project?, session?, limit?)`** — the "find keyword references" tool.
  Hybrid (trigram + vector, RRF), match-centered snippet (`snippetAround`), **always excludes
  sidechain** (no `includeSidechain` param). Returns `{ messageId, sessionId, role, snippet,
  createdAt, sessionTitle, project }`.
- **`search_sessions(query, project?, limit?)`** — session-level topic search (title + summary).
- **`read_around_message(messageId, radius?, full?, includeSidechain?)`** — the message ± `radius`
  turns (default 8, max 30), chronological, tool events interleaved. 404-shaped on a bad id.
- **`read_session(sessionId, offset?, limit?, full?, includeSidechain?)`** — paged transcript
  (default 0/25, max 50) + session meta + `hasMore`.

Supporting code:
- **`server/services/session-read.ts` (new)** — a pure core (`snippetAround`, `truncate`, item
  mappers, `interleave`) that is unit-tested, plus the two bounded DB reads. Messages and tool
  events live in separate tables (`messages`, `tool_events`) and are merged chronologically so a
  transcript reads in order. Truncation: `CONTENT_CAP` 2000 / `TOOL_CAP` 600, with a `truncated`
  char-count marker; `full:true` returns everything (and `thinking`).
- **`server/services/session-search.ts` (modified)** — `searchSessions`/`searchMessages` gained
  backward-compatible `project`/`session`/`includeSidechain` filters (signature moved from a
  positional `limit` to an opts object; the only callers — two lines in `server/services/search.ts`
  — were updated), plus `searchMessagesForAgent`/`searchSessionsForAgent` hydration wrappers. The web
  DTOs in `shared/types/search.ts` are untouched.

## Verification

- Gates: **typecheck 0 · test 861 (127 files) · build clean.**
- Repo convention: pure logic → vitest (`session-read.test.ts`, 10 tests); DB-backed behavior →
  `tsx` probe against the live dev DB (463 sessions / 96,737 messages), pasted into each task report.
- **Live MCP round-trip proven:** `tools/list` shows all four; `search_messages("error")` → hits;
  a returned `messageId` chained into `read_around_message` → a real chronological interleave.
- Per-task: 5 tasks, each independently spec+quality reviewed (sonnet); reports in
  `.superpowers/sdd/task-{1..5}-report.md`, ledger at `.superpowers/sdd/progress.md`.
- Final whole-branch review (opus): Ready to merge; all wiring/backward-compat/DTO-isolation/
  filter/no-mutation checks confirmed.

## The one real bug the final review caught (fixed)

`messages.createdAt` is set to `now()` at **ingest**, not the transcript time, and a batched insert
shares one timestamp — so **~1% of messages share a `(session_id, created_at)`** (worst cluster 71
messages). With no tie-break, `read_session` paging could dup/skip at a cluster boundary, and
`read_around_message`'s strict `<`/`>` **dropped the focal message's same-timestamp siblings** — the
exact neighbors the tool exists to show. Fixed (`8601901`) with a `(createdAt, id)` composite: a
secondary `asc(messages.id)` on the page order, and a row-value tuple cursor
(`(createdAt, id) </> (focal.createdAt, focal.id)`) for the window. Caveat: `id` is a random uuid,
so this buys **determinism, not necessarily true intra-cluster order** (true order lives only in the
`parentUuid` chain) — acceptable for a best-effort read tool. Probe on the real 71-cluster: window
now includes 4/4 siblings; paging across the boundary is disjoint.

## Design notes worth carrying forward

- **Sidechain asymmetry (deliberate):** the search *services* default `includeSidechain:true` to
  preserve the existing web global-search caller; the `*ForAgent` wrappers and the read tools default
  to **excluding** sidechain; `search_messages` has no opt-in at all (a keyword hit inside subagent
  scratch is rarely what you want).
- **`read_around_message` returns the focal message even if it is sidechain** and `includeSidechain`
  is false — explicit-id-wins. Accepted.
- **`hasMore` is a `returned === limit` heuristic**, not a stored count (`messageCount` is a raw
  ingest total that may include sidechain) — consumers should page on `hasMore`.

## Deferred follow-ups (none block merge)

- `read_around_message` issues two SELECTs for the focal row (one only to get `sessionId`) — fold into one.
- `*ForAgent` wrappers have no explicit return-type annotations (shape only structurally inferred).
- Tool-event ordering within a same-millisecond cluster is not tie-broken (messages are; the finer
  `interleave` ms-precision tie for tool events is unaddressed — low impact).
- `read_session`'s summary line counts messages (`returned`), not interleaved items — cosmetic undercount.
- Minor style: `SNIPPET_RADIUS` export; duplicated `full ? … : truncate(…)` ternary; light dup
  between the two `*ForAgent` wrappers.
- **Pre-existing (not this branch):** `docs/wiki/mcp.md`'s master tool *table* is still missing rows
  for the 4 skills tools shipped in cycle 49 (`use_skill`/`create_skill`/`edit_skill`/`delete_skill`);
  the stale "29 tools" count language was corrected this branch, but the rows weren't backfilled.

## Next steps (Tony)

1. Merge + push (CD deploys). **Nothing to seed/backfill** — no migration, reuses existing tables.
2. **Acceptance:** from a Claude Code session with the MyMind connector, call `search_messages` for a
   term you know appears in a past session, then `read_around_message` on a hit — confirm you get a
   coherent windowed transcript. (Prod's reasoning rig reaches the embedding lane; the dev shell
   could only exercise the trigram lane, so the *vector* lane's runtime behavior is first proven on
   prod.)
