# Live Reactivity

**status: shipped** (cycle 21)

How MyMind stays live across devices and tabs: a single per-process event bus pushes thin
change signals over one SSE stream to every open tab, and the client turns each signal into
a `@tanstack/vue-query` cache invalidation. No manual refresh; no Redis; no polling.

## Pipeline (today)

```
any Nitro write (HTTP handler OR background task)
  → publishChange({ resource, action, id })            server/utils/live-bus.ts
  → in-process EventEmitter (one global channel)
  → GET /api/events (SSE, auth-gated, 25s heartbeat)    server/api/events.get.ts
  → app/plugins/live.client.ts (one EventSource/tab, session-gated)
  → dispatchLiveEvent → queryClient.invalidateQueries    app/utils/live-dispatch.ts
  → affected useQuery refetches → UI updates, no reload
```

## Server

- **`server/utils/live-bus.ts`** — `publishChange(e: {resource, action, id})` stamps
  `{v:1, at}` and emits a `LiveEvent` on one global channel (`live-change`) via a module
  `EventEmitter` (`setMaxListeners(0)`). `subscribeChanges(cb)` returns an unsubscribe.
  Single instance, no broker (correct for this homelab deploy).
- **`shared/types/live.ts`** — `ResourceName` (closed union:
  `document | image | memory | review | project | task | session | clipboard | activity | apiToken`),
  `LiveAction` (`created | updated | deleted`), `LiveEvent` (`{v:1, resource, action, id, at}`).
- **`server/api/events.get.ts`** — one SSE connection per tab. `text/event-stream`, 25s
  heartbeat comments, `x-accel-buffering: no`, unsubscribe on `req.close`. Auth-gated by
  `server/middleware/auth.ts` (401 without a session/token).

### Emit sites (every Nitro writer publishes)
| Resource | HTTP handlers | Background writer |
|---|---|---|
| image | `upload.post`, `images/[id]/index.patch\|delete`, `reprocess`, `revectorize` | `services/image-enrich.ts` (per image in `runImageEnrich`) |
| document | `documents/index.post`, `[id].put\|delete`, `[id]/move`, `[id]/share` | `services/embedding.ts` (per doc) |
| memory | `memories/index.post`, `[id]/review`, `[id]/archive` | `services/memory-enrich.ts` (per extracted memory) |
| review | `review/[id]/approve` (also emits `document`), `[id]/reject` | `services/enrichment.ts` (per inserted queue item, guarded by `.returning()`) |
| project | `projects/index.post`, `[slug].patch\|delete` (id = **slug**) | — |
| task | `tasks/index.post`, `[id].patch\|delete`, `[id]/move` | — |
| session | — | `services/sessions.ts` `ingestTranscript` + `api/hooks/cc/[event].post` `upsertSession` (one emit per write; not double-emitted) |

Also emitting (writes outside the CRUD endpoints): `api/capture/note.post.ts` (document created) and the **agent/MCP tool surface** `server/lib/agent/tools.ts` — `save_memory`, `create_project`/`edit_project`, `create_task`/`edit_task`, `quick_capture` all `publishChange` after their write (and in their undo lambdas), so voice/MCP/chat actions update the UI live too. These emit in the tool handler, not the shared service (the HTTP handlers already emit there — no double-emit).

## Client

- **`app/plugins/vue-query.ts`** — named (`vue-query`) plugin. Installs `VueQueryPlugin`
  with `staleTime: 30_000`, `refetchOnReconnect: true` (self-heals invalidations missed
  during an SSE/network gap — no replay log needed), `refetchOnWindowFocus: false`.
  Dehydrates SSR cache into `useState('vue-query')`, hydrates on client. Exposes the client
  via Nuxt provide (`nuxtApp.$queryClient`).
- **`app/plugins/live.client.ts`** — named `live-sse`, `dependsOn: ['vue-query']` (filenames
  sort `live` < `vue-query`, so without this it would run before the client exists — see the
  `nuxt-plugin-load-order` memory). Opens **one** `EventSource('/api/events')` per tab, gated
  on `authClient.getSession()` and re-evaluated on each navigation (opens after sign-in,
  closes on sign-out / public routes — no stray 401 on `/login`).
- **`app/utils/live-dispatch.ts`** — `dispatchLiveEvent(client, event)`: default invalidates
  `[resource, id]` + `[resource, 'list']` (vue-query partial-key match hits every filtered
  list variant). `OVERRIDES` adds extra keys: `memory`/`review` also invalidate
  `[resource, 'count']` (the sidebar badges).

### Query-key convention (enforced by `.claude/rules/live-data.md`)
- List: `[resource, 'list', params]` — params wrapped in a `computed` inside the hook so the
  key is reactive.
- Detail: `[resource, id]`.
- Count: `[resource, 'count']` (badges).
The query `data` is read-only — pages iterate `computed(() => data.value ?? [])` and refresh
via `refetch()`/invalidation, never by mutating a hand-rolled ref.

## What's live
Gallery (images, incl. `pending→done` enrich), document tree + detail, memories, review
queue, projects, tasks kanban, sessions list + detail, and the sidebar Memory/Review badges
(the old 60s `setInterval` poll in `default.vue` is gone).

## Deliberately NOT on this channel
- **Voice WS** (`/api/voice/ws`) — bidirectional STT/TTS.
- **Agent activity SSE** (`/api/agent/activity`) and **agent chat** token streaming —
  ephemeral interaction streams, not data-cache events.
- **Clipboard thread stream** — already had its own SSE + polling fallback; unchanged.

## Edge cases handled
- **Tasks kanban** (`useSortable`): dragged column arrays stay mutable; a `isDragging` flag
  pauses the rebuild watcher so a live refetch can't yank a card mid-drag.
- **Document editor**: content and metadata live-sync are each gated by a dirty check so an
  incoming refresh can't clobber in-progress typing.
- **Reconnect**: thin signals + `refetchOnReconnect` self-heal; no durable event log.

## Not built (YAGNI / future seams)
- Per-user event scoping (single-user app; data rows have no `userId`). One-line seam: add a
  `scope` arg to `publishChange` + a topic filter.
- Postgres `LISTEN/NOTIFY` (all writes go through Nitro, so app-level emit has full coverage).
- Fat events (events carry only `{resource, action, id}`; client refetches). Promote hot
  paths later if latency demands.

Spec: [`../superpowers/specs/2026-06-12-live-reactivity-design.md`](../superpowers/specs/2026-06-12-live-reactivity-design.md) ·
Plan: [`../superpowers/plans/2026-06-12-live-reactivity.md`](../superpowers/plans/2026-06-12-live-reactivity.md) ·
Add a resource: the `add-live-resource` skill.
