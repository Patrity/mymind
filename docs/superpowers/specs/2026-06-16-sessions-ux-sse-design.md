---
title: Sessions UX + SSE Overhaul
status: approved-brainstorm
cycle: 24
date: 2026-06-16
---

# Sessions UX + SSE Overhaul

**Goal:** Make the Sessions surfaces live and scalable — counts that update over SSE, a live-activity badge, and a detail page that loads progressively into a resizable split-pane with a **virtualized**, live-tailing transcript that stays smooth on the multi-thousand-message sessions the bridget import just created.

**Why:** Today the list's counts (message/tool/token) never update over SSE — `app/utils/live-dispatch.ts` has no `session` handler, so `publishChange({resource:'session'})` invalidates nothing; the timestamp only *appears* live because `useTimeAgo` re-renders on its own timer. And the detail page loads the **entire** session (metadata + every message) in one `useSessionDetail` query and mounts the whole transcript — fine for a 50-message session, janky for a 2,000+ one.

## Decisions (locked at brainstorm, 2026-06-16)
1. **Transcript = virtualized** (windowed render via `useVirtualList` from `@vueuse/core` — available, not yet used anywhere). Only visible messages mount.
2. **Live updates = incremental "since" append**, not full refetch — never re-pull a multi-MB transcript on an SSE tick.
3. **Fetch strategy = fetch-all-once + virtualize-render** (not a ranged/paginated endpoint). Simpler; snappy for sessions up to a few thousand messages. (Ranged fetching is a deliberate non-goal — revisit only if sessions grow unbounded.)

## A. Sessions list (`app/pages/sessions/index.vue`)

### SSE reactivity fix
Add a `session` case to the live-dispatch registry (`app/utils/live-dispatch.ts`) that, on a `session` change, invalidates `['session','list']` and (if open) `['session', id]` + `['session', id, 'messages']`. This is the root fix — the list query already returns the counts; it just was never being invalidated. (Confirm every transcript-ingest + event-upsert path calls `publishChange({resource:'session', action, id})` — `ingestTranscript` and `[event].post.ts` already do.)

### Live-activity badge
A small `UChip`/pill on each row that pulses and shows a count when an SSE `session` update for that row arrives since the page loaded — so streaming activity is visible. State is per-row, in-memory, resets on navigate/refresh. (A row "lights up" when its session ingests new data.)

## B. Sessions detail (`app/pages/sessions/[id].vue`)

### Progressive load — split the query
Split `useSessionDetail` (in `app/composables/useSessions.ts`) into:
- **`useSessionMeta(id)`** → `GET /api/sessions/[id]` slimmed to the session row only (title, summary, stats, git/machine, tool-name summary) — **no messages**. Key `['session', id]`. Renders the header + left panel instantly.
- **`useSessionMessages(id)`** → new `GET /api/sessions/[id]/messages` returning the ordered `messages` + `tool_events` DTOs. Key `['session', id, 'messages']`. Loads after meta; powers the transcript.

Server: slim `server/api/sessions/[id].get.ts` (drop the messages/toolEvents payload; `getSession` → a `getSessionMeta`), add `server/api/sessions/[id]/messages.get.ts` (+ a `getSessionMessages(id, {since?})` service that returns messages with `created_at > since` for incremental append).

### Resizable split-pane
Mirror the voice page's `UDashboardPanel resizable` pattern: **left** = metadata/stats/git/machine/tool-summary; **right** = the transcript. Stacks vertically on narrow (`< lg`) screens.

### Virtualized transcript
`useVirtualList` over the combined message+tool-event stream. Each row renders exactly as today (role, content, collapsible thinking, inline tool events, sidechain dimming, model label) — only the windowing is new. Variable row heights handled by `useVirtualList`'s dynamic-height support (or a measured-height wrapper).

### Autoscroll / live-tail
- On first message load → scroll to bottom.
- On incremental append (new messages for this session via SSE) → if the user is at/near the bottom, append and follow; if they've scrolled up, **don't yank** — show a "↓ N new" button that jumps to bottom on click.
- The "at bottom?" check and the "N new since last seen" count are pure helpers (unit-tested).

### Live append mechanism
On a `session` SSE signal for this `id`: fetch `GET /api/sessions/[id]/messages?since=<last loaded message createdAt>` and append the (usually few) new rows to the cached list, rather than invalidating/refetching the whole transcript. Meta is invalidated normally (cheap).

## Components / files
- New: `server/api/sessions/[id]/messages.get.ts`; `getSessionMessages` in `server/services/sessions.ts`; a `useSessionMessages` composable; a virtualized `<SessionTranscript>` component (extracted from the current detail page); small pure helpers (`isAtBottom`, `countNewSince`) in `app/utils/`.
- Modified: `server/api/sessions/[id].get.ts` (slim to meta), `getSession`→`getSessionMeta`; `app/composables/useSessions.ts` (split queries + `since` fetch); `app/pages/sessions/[id].vue` (split-pane + virtualization + autoscroll); `app/pages/sessions/index.vue` (live badge); `app/utils/live-dispatch.ts` (`session` handler).

## Testing
- **Unit (pure):** `isAtBottom(scrollTop, scrollHeight, clientHeight, threshold)`, `countNewSince(messages, lastSeenId)`, and the `since` filter in `getSessionMessages` (given messages + a timestamp → only newer).
- **Integration:** `GET /api/sessions/[id]/messages` returns ordered messages + `?since=` filters correctly; meta endpoint no longer carries messages.
- **playwright-cli (per the repo rule):** open a session → header/stats paint before transcript; transcript virtualizes (DOM node count bounded on a large session); resize handle works; autoscroll on load; "↓ N new" appears when scrolled up and a live append arrives; list row badge pulses on an SSE update.
- Gates: `pnpm typecheck` / `pnpm test` / `pnpm build`.

## Out of scope
In-transcript search, transcript export, cross-session diff, ranged/paginated message fetching, and any change to ingestion/enrichment.
