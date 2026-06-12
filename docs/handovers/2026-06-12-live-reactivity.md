---
title: Live Reactivity (unified per-process event bus → SSE → vue-query cache invalidation; every Nitro write publishes, every list/detail is live)
cycle: 21
date: 2026-06-12
status: shipped
spec: ../superpowers/specs/2026-06-12-live-reactivity-design.md
plan:
  - ../superpowers/plans/2026-06-12-live-reactivity.md
wiki: ../wiki/live-reactivity.md
shipped:
  - "server/utils/live-bus.ts — publishChange({resource, action, id}) stamps {v:1, at:Date.now()} (satisfies-guarded) and emits a LiveEvent on ONE global channel ('live-change') via a module EventEmitter (setMaxListeners(0)). subscribeChanges(cb) returns an unsubscribe. Single instance, no Redis. Test: test/live-bus.test.ts."
  - "shared/types/live.ts — ResourceName closed union (document|image|memory|review|project|task|session|clipboard), LiveAction (created|updated|deleted), LiveEvent {v:1,resource,action,id,at}. The closed union is the structural backstop: a resource not wired into the dispatch registry is a type error."
  - "server/api/events.get.ts — one SSE stream per tab (text/event-stream, 25s heartbeat, x-accel-buffering:no, unsubscribe on req.close). Mirrors server/api/agent/activity.get.ts. Auth-gated by server/middleware/auth.ts (401 without session/token — verified)."
  - "app/plugins/vue-query.ts — NAMED plugin 'vue-query' (object syntax). Installs VueQueryPlugin (staleTime 30s, refetchOnReconnect true = self-healing, refetchOnWindowFocus false), SSR dehydrate→useState('vue-query')→hydrate, and exposes the client via Nuxt provide (return {provide:{queryClient}} → nuxtApp.$queryClient). @tanstack/vue-query@^5.101.0 added."
  - "app/plugins/live.client.ts — NAMED 'live-sse', dependsOn:['vue-query'] (CRITICAL: filenames sort 'live'<'vue-query' so without dependsOn it ran first and threw 'No queryClient found in Vue context' — the boot-500 the user hit). Opens ONE EventSource('/api/events') per tab, GATED on authClient.getSession() and re-checked on every router.afterEach (opens after sign-in, closes on sign-out/public routes — no stray 401 on /login). Reads client via nuxt.$queryClient (cast)."
  - "app/utils/live-dispatch.ts — dispatchLiveEvent(client, event): default invalidates [resource,id] + [resource,'list'] (vue-query partial-key match). OVERRIDES: memory & review also invalidate [resource,'count'] (sidebar badges). Pure fn, unit-tested: test/live-dispatch.test.ts (4 tests)."
  - "Emit sites (every Nitro writer publishes after commit) — images: upload.post, images/[id]/index.patch|delete, reprocess, revectorize + services/image-enrich.ts (per image, in runImageEnrich loop NOT inside enrichImage to avoid double-emit with reprocess). documents: documents/index.post, [id].put|delete, [id]/move, [id]/share + services/embedding.ts (per doc). memories: memories/index.post, [id]/review, [id]/archive + services/memory-enrich.ts (per extracted memory). review: review/[id]/approve (emits BOTH review + document) , [id]/reject + services/enrichment.ts (per inserted reviewQueue row, guarded by .returning() for onConflictDoNothing). projects: projects/index.post, [slug].patch|delete (id = SLUG). tasks: tasks/index.post, [id].patch|delete, [id]/move. sessions: services/sessions.ts ingestTranscript + api/hooks/cc/[event].post upsertSession (one emit per logical write — upsertSession itself does NOT emit, since ingestTranscript calls it internally)."
  - "Composables gained vue-query hooks (existing raw fetchers kept): useImages.useImageList/usePatchImage, useDocuments.useDocTree/useDocDetail, useMemories.useMemoryList, useProjects.useProjectList, useTasks.useTaskList, useSessions.useSessionList/useSessionDetail. List hooks wrap reactive params in a computed so the key is reactive (a raw getter never refetches — real bug caught in the images pilot)."
  - "Pages migrated to back lists/detail with the queries (read-only computed(() => data.value ?? []), refetch()/invalidation instead of in-place mutation, watch(error) not watch(isFetching) for toasts): gallery.vue, documents.vue + components/documents/{Tree.vue read-only, Editor.vue dirty-gated live-sync}, memories.vue, review.vue, projects.vue, tasks.vue (drag-guarded), sessions/index.vue + [id].vue. layouts/default.vue: 60s setInterval badge poll REMOVED — review/memory counts are vue-query (['review','count'], ['memory','count']) refreshed by the dispatch OVERRIDES; dead refreshNuxtData('*-count') calls removed from memories.vue/review.vue."
  - "Gap-fix pass (after a final completeness review): added emits to writes OUTSIDE the CRUD endpoints — server/api/capture/note.post.ts (document created) and the agent/MCP tool surface server/lib/agent/tools.ts (save_memory→memory, create_project/edit_project→project, create_task/edit_task→task, quick_capture→document, plus their undo lambdas) so voice/MCP/chat actions update the UI live. Emitted in the tool handler, not the shared service (HTTP handlers already emit there — no double-emit). Also app/pages/tasks.vue project-filter dropdown migrated off a raw onMounted ref onto useProjectList(true) so it live-updates."
  - ".claude/rules/live-data.md (paths-scoped to composables/pages/api/services/tasks) + .claude/skills/add-live-resource/SKILL.md — enforce the convention: vue-query reads with the key convention + every mutation calls publishChange. The closed ResourceName union is the type-level backstop."
deferred:
  - "Live cross-tab E2E was user-validated PASS for the images gallery (upload in tab A → appears in tab B with no reload). The other resources are verified by typecheck + build + 219 unit tests + the proven shared pattern, but NOT each individually exercised in a two-context browser test. A full two-context playwright sweep (documents move, memory extraction via /api/admin/memory-enrich-run, review via /api/admin/enrich-run, tasks drag) is the recommended next validation."
  - "Tasks same-column reorder is still visual-only (no order column persisted) — unchanged from before; a later SSE event snaps it to server order. Persisting kanban order is a separate piece of work."
  - "Document editor metadata live-sync is gated by a metaDirty flag; content by content===savedContent. Both prevent clobber but are coarse (whole-field). Fine as-is."
  - "Known minor non-emitters (from the final completeness review, left intentionally): server/api/admin/images-backfill.post.ts bulk-sets enrich_status='pending' without a per-row emit — eventually consistent because runImageEnrich emits per image as it processes (admin-only path). And `clipboard` is in the ResourceName union but never emitted — a forward declaration for the clipboard-unread-badge seam below; the clipboard thread list isn't on vue-query yet, so no stale issue today."
next_seam:
  - "Clipboard unread badge could publish a thin 'clipboard' signal (resource already in the union) — currently clipboard keeps its own thread SSE + polling, untouched."
  - "Promote hot paths to fat events (carry the new row) if refetch latency is ever felt — design notes in the spec's non-goals."
  - "Per-user scoping if the app ever goes multi-user: add a scope arg to publishChange + a topic filter in subscribeChanges (the data model has no userId today)."
---

# Live Reactivity — cycle 21 handover

## What shipped
MyMind is now **live by default**. A change made on any device/tab — by a user action or a
background enrichment task — surfaces on every other open tab without a manual refresh,
touching only the affected query. This closes the core "feels static, must refresh"
complaint that motivated the cycle.

**Architecture (thin-signal model):** every Nitro write calls `publishChange({resource,
action, id})` → one in-process `EventEmitter` → one auth-gated SSE endpoint `/api/events` →
one `EventSource` per tab → `@tanstack/vue-query` cache invalidation → targeted refetch.
No CRDT, no Redis, no DB triggers, no event replay log (reconnect self-heals via
`refetchOnReconnect`). Single global channel (the app is single-user; data rows have no
`userId`). Full rationale in the spec; current behaviour in the wiki page.

## Live surfaces
Gallery (incl. image `pending→done` enrichment), document tree + detail, memories, review
queue, projects, tasks kanban, sessions list + detail, and the sidebar Memory/Review badges.
Voice WS, agent activity/chat streams, and the clipboard thread stream stay on their own
channels by design.

## Notable decisions / things future-me should know
- **The boot-500 the user hit was real and is fixed.** `live.client.ts` sorts before
  `vue-query.ts` alphabetically, so it ran first and called the client before it existed
  (`No queryClient found in Vue context`). Fix: named plugins + `dependsOn:['vue-query']` +
  read the client via Nuxt provide (`$queryClient`), not Vue `inject` (plugins have no
  component instance). Captured as the `nuxt-plugin-load-order` memory.
- **Reactive query keys:** list hooks wrap params in a `computed` — a raw getter has stable
  identity and never refetches on filter change (caught in the images pilot).
- **No in-place mutation of query data:** the gallery/board pages used to patch `items` in
  place; that's now read-only. Use `refetch()`/invalidation. The tasks kanban keeps mutable
  arrays for `useSortable` but guards the rebuild watcher with `isDragging`.
- **Emit once per logical write:** watch for service functions that call each other
  (`ingestTranscript`→`upsertSession`, `reprocess`→`enrichImage`) — emit at one layer only.

## Verification
`pnpm typecheck` clean · `pnpm build` clean · `pnpm vitest run` **219 passing** (40 files).
Plugin init + auth-gating verified on a production preview (`node .output/server/index.mjs`
on a spare port) with playwright-cli: no `queryClient` error, zero `/api/events` requests on
the logged-out `/login` page. **User validated** the images live cross-tab flow (PASS). See
`deferred` for the remaining recommended E2E sweep.

## Where the next session should look
The `add-live-resource` skill is the end-to-end recipe; `.claude/rules/live-data.md` carries
the constraint. To make a new entity live: add it to `ResourceName`, add a `useXList`/
`useXDetail` hook, emit `publishChange` from every writer, (optionally) add a dispatch
override. The closed union makes a missed wire-up a type error.
