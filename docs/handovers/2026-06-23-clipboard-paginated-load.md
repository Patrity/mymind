---
title: Clipboard — paginated load + reverse infinite scroll (prod data-volume fix)
cycle: maintenance (post Cycle 6 clipboard)
date: 2026-06-23
status: shipped + browser-verified (local dev), NOT yet deployed
branch: feat/generate-image-tool (committed alongside cycle-36 prep)
spec: none (small bugfix — driven directly from the request)
docs:
  - ../wiki/clipboard.md (updated: listMessages paging modes + Thread loading section)
problem: >
  The clipboard Thread loaded the whole history every visit (`messages.get` with no
  cursor returned `asc + limit 100` = the OLDEST 100, and the live-poll fallback could
  re-pull a full page). As prod data grows this got heavy and showed ancient entries
  instead of the latest.
shipped:
  - "**Server `listMessages` (server/services/clipboard.ts)** — two modes. `since` → forward catch-up (`gt(createdAt, cursor)`, ascending; unchanged, used by the stream poll). No `since` → history mode: newest `limit` messages older than `before` (when given) via `desc + limit` reversed to ascending. So the DB only ever pulls one page. Shared `parseCursor` nudges cursors +1ms (DTO ISO is ms-truncated, PG stores µs) — required so the `lt(before)` path never SKIPS a sub-ms-older row; the re-included boundary row is de-duped client-side by id."
  - "**N+1 fix** — per-page attachments now fetched in one `inArray` query (was one SELECT per file message)."
  - "**Endpoint** — `messages.get.ts` passes the new `before` query param through."
  - "**`useThreadStream.ts`** — added optional `initialCursor` ref; the polling fallback now starts from `lastCreatedAt ?? initialCursor ?? ''`, so when SSE is down the first poll asks only for messages *newer* than what the page already rendered (previously `since=''` → a whole newest page replayed into onMessage)."
  - "**`Thread.vue` (rewritten)** — onMounted loads newest `PAGE_SIZE=10`, snaps to bottom; scroll within `TOP_THRESHOLD_PX` of the top loads the next older page with `USkeleton` placeholders. A ResizeObserver-driven scroll controller (modes `bottom`/`anchor`/`none`) keeps position correct as MDC markdown grows the DOM after mount — `bottom` pins newest (live arrivals stick only when already at bottom = no yank while reading), `anchor` holds the top message fixed while older content prepends (0px jump). `suppressScrollUntil` window stops the controller's own scrollTop writes from being read as user-scroll. `mt-auto` + `fillViewport()` make short threads sit at the bottom and stay scroll-up-reachable."
verified:
  - "typecheck ✅, build ✅, `pnpm test` ✅ (593/593, 89 files — no clipboard unit tests exist; service is DB-backed)."
  - "playwright-cli on local dev (seeded 25 msgs into the existing thread, then deleted only the TESTMSG/LIVE_ rows): initial = newest 10 ascending, atBottom/distFromBottom=0; scroll-up prepends 9, anchorMovedPx=0; 3 skeletons render mid-load (proved via injected fetch latency); live arrival auto-scrolls at bottom, no-yank when scrolled up; API contract (newest page + before cursor + ascending) asserted directly."
follow-ups:
  - "Deploy to prod (LXC 114) — this is the box where the data-volume problem actually bites; verify against the real corpus."
  - "fillViewport over-loads ~1 page on threads of very short messages (loads until scrollable; bounded, harmless) — measurement races MDC; could tighten with a settle delay if it ever matters."
  - "Still no clipboard unit tests; the cursor/ordering logic is covered only by the browser run. A DB-backed service test would lock in the paging contract."
---

# Clipboard — paginated load + reverse infinite scroll

## Why
Prod loads "a ton of data" on the clipboard page as the thread grows. Root cause:
`Thread.vue` fetched `/messages` with no cursor, and `listMessages` defaulted to
`asc + limit 100` — i.e. the **oldest** 100 messages, with an N+1 attachment query,
and the SSE polling fallback could re-pull a full page on `since=''`.

## What changed
See frontmatter `shipped`. The seam: `listMessages` now has an explicit **history
mode** (newest-first, `before` cursor) distinct from the **forward catch-up** the live
poll uses (`since`). The client (`Thread.vue`) drives reverse infinite scroll off the
`before` cursor and keeps the scroll position correct through async MDC rendering via a
single ResizeObserver scroll controller.

## Key gotchas (for the next session)
- **MDC renders async.** Message bodies go through `MdView` (MDC), so bubble heights
  grow *after* mount. Any `scrollHeight`-based math at render time is stale — that's why
  the scroll position is driven by a ResizeObserver re-applying the desired position as
  content settles, not a one-shot `scrollTo`.
- **Cursor ±1ms is deliberate.** DTO ISO strings are millisecond-truncated; Postgres
  stores microseconds. The `before` cursor is `lt(createdAt, cursor+1ms)` so a sub-ms
  *older* sibling is never skipped; the boundary row gets re-fetched and the client
  de-dupes by `id`. Don't "optimize" this to an exact `lt` — it will silently drop rows.
- **Two `.vue` HMR / dev-server traps hit during this work** (both in the
  `browser-testing` skill): a long-running dev server can serve a stale compiled
  component, and on this machine other Nuxt dev servers (2d-rpg) contend for :3000 — a
  mymind dev restart let another grab the port and dropped the auth session. Restart
  `pnpm dev` cleanly and re-auth if the browser lands on the wrong app.
