---
title: Sessions UX + SSE — virtualized live-tailing transcript, split-pane, progressive load
cycle: 24
date: 2026-06-16
status: shipped
branch: feat/sessions-ux
spec: ../superpowers/specs/2026-06-16-sessions-ux-sse-design.md
plans:
  - ../superpowers/plans/2026-06-16-sessions-ux-sse.md
wiki:
  - ../wiki/sessions.md
shipped:
  - "**Endpoint split** — `GET /api/sessions/[id]` now returns **meta only** (`getSessionMeta`); new `GET /api/sessions/[id]/messages?since=<iso>` (`getSessionMessages`) returns `messages` + `toolEvents`, with `since` filtering MESSAGES by `created_at > since` for incremental append. `SessionMeta`/`SessionMessages` types; `SessionDetail` removed."
  - "**Composables** — `useSessionMeta` (key `['session', id]`) + `useSessionMessages` (key `['session', id, 'messages']`) + raw `getMessages(id, since)`, replacing `useSessionDetail`."
  - "**Detail page** — resizable split-pane (`UDashboardPanel resizable`, mirroring voice.vue): metadata left (instant, gated on `metaPending`), transcript right. `<SessionTranscript>` (explicit-imported — auto-import would be `SessionsSessionTranscript`) holds the moved-verbatim turn markup."
  - "**Virtualized transcript** — `@vueuse/core` `useVirtualList` (itemHeight 140 ≈ measured avg, overscan 10): a 497-msg session mounts ~16 DOM rows. Rows are internally height-bounded (existing `max-h-*` scrolls), so the fixed estimate works; minor scrollHeight drift is inherent + negligible."
  - "**Autoscroll / live-tail** — scrolls to bottom on load (via `useVirtualList.scrollTo`), auto-follows when at bottom, shows a floating '↓ N new' button when scrolled up. `atBottom` uses a **viewport-sized threshold** (`clientHeight + itemHeight`), not 40px, because `scrollTo` settles ~a viewport short under estimated heights. Live append: page watches `meta.messageCount` (refetched on SSE via the DEFAULT live-dispatch), fetches `?since=` deltas, `qc.setQueryData` appends — **de-duping tool events by id** (the `since` filter is messages-only, so the endpoint returns all tool events)."
  - "**List** — per-row pulse (`animate-ping` dot) when a session's `lastActive` advances. Pure helpers `app/utils/transcript-scroll.ts` (`isAtBottom`, `countNewSince`) unit-tested (test 315→322). Gates green (typecheck 0 / test 322 / build). Final integration review: READY TO MERGE."
corrections:
  - "Spec claimed live-dispatch lacked a `session` handler. It does NOT — the default already invalidates `['session', id]` + `['session', 'list']` for every resource, so counts already update on a transcript ship. The perceived 'only timestamp updates' was just `lastActive` bumping on every event + the `useTimeAgo` ticker. No live-dispatch change was made."
---

# Sessions UX + SSE (Cycle 24)

Built subagent-driven (7 tasks, two-stage review + final integration review) on `feat/sessions-ux`, merged to local master. Full behaviour: [wiki/sessions.md](../wiki/sessions.md).

## Where the next seam is
1. **Push** — UI-only, no migration/prod-DB step; pushing master ships it via the normal homelab deploy. (Master also carries the `--projects` import tooling + cycle-23/24 docs — all already merged locally.)
2. **Validate on prod** after deploy — open a big imported session (e.g. a `2d-rpg` one) and confirm the split-pane + virtualized transcript + autoscroll feel right on real data; watch an active session live-tail.

## Watch-outs
- **Fixed-estimate virtualization:** `useVirtualList` predicts offsets from a constant `itemHeight` (140). Rows are height-bounded so it's fine, but a session of unusually tall rows could show minor scroll-position imprecision. If it ever matters, switch to a measuring scroller — out of scope here.
- **Tool-event-only ingest (theoretical):** the live-tail watcher fires on `meta.messageCount` growth. An ingest adding only tool events (no message rows) wouldn't trigger a delta until the next message — not practical (tool_use/result ship in the same Stop batch as their parent message).
