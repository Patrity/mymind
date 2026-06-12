---
title: Live Reactivity — Unified Per-User Event Channel
date: 2026-06-12
status: spec
supersedes: null
related:
  - docs/superpowers/specs/2026-06-03-clipboard.md
  - docs/superpowers/specs/2026-06-03-ai-enrichment.md
  - docs/superpowers/specs/2026-06-11-image-pipeline-design.md
---

# Live Reactivity — Unified Per-User Event Channel

## Problem

MyMind is a single user's documentation workspace accessed from multiple devices and
multiple open sessions at once. Most data is mutated **out of band** — background cron
tasks (`enrich-images`, `embed-documents`, `enrich-input`, `enrich-memories`) write to
Postgres on a 5–15 minute cadence, and actions taken on one device don't surface on
another. Today the frontend only learns about changes by:

- a 60s `setInterval` badge poll in `app/layouts/default.vue` (memory + review counts), and
- manual `loadX()` / refetch-after-action calls inside per-page composables.

The result: the app feels static/prerendered. You must refresh to see new documents,
gallery images, enrichment status (`pending → done`), extracted memories, or review
items. This defeats the purpose of a centralized, multi-device workspace.

## Goal

Make the frontend reactive: when any data changes — via a user action on another device
or a background task — the relevant view updates **without a manual refresh**, touching
only what changed.

## Non-Goals (deliberately out of scope)

- **No CRDT / shared-state sync** (Replicache, ElectricSQL, Yjs). This is a single user
  reading data a worker mutated, not multiplayer collaborative editing. There are no
  write-write conflicts to resolve.
- **No Redis / NATS / external broker.** The app is a single Nitro instance; the
  in-process `EventEmitter` is the fan-out hub.
- **No event replay log / durable buffer.** Reconnect is self-healing (see below).
- **No Postgres `LISTEN/NOTIFY` / DB triggers.** All DB writes go through Nitro, so
  app-level emit has full coverage. (Revisit only if a writer ever lives outside Nitro.)

## Locked Decisions

1. **Thin signals**, not fat events. An event carries `{resource, action, id}` only; the
   client reacts by invalidating and refetching just the affected query. One code path,
   always correct.
2. **Client cache = `@tanstack/vue-query`.** Query keys *are* the event addresses; a thin
   signal becomes a query invalidation. **All** data-fetching composables migrate to it,
   and it becomes the standing convention for future work.
3. **Server emit = app-level `publishChange`.** Every Nitro mutation (HTTP handler +
   background task) publishes after a successful commit. Enforced by convention + a typed
   closed union (a missing wire-up is a type error).

## Architecture

One per-user event channel. Every Nitro write publishes a thin signal to it. The client
turns each signal into a vue-query invalidation.

### Server components

**`server/utils/live-bus.ts`** — a single in-process `EventEmitter` (same pattern as
`server/lib/agent/bus.ts`) plus a typed publisher:

```ts
type ResourceName =
  | 'document' | 'image' | 'memory' | 'review'
  | 'project'  | 'task'  | 'session' | 'clipboard'

type LiveEvent = {
  v: 1
  resource: ResourceName
  action: 'created' | 'updated' | 'deleted'
  id: string
  at: number
}

function publishChange(userId: string, e: Pick<LiveEvent, 'resource' | 'action' | 'id'>): void
```

Events are emitted on a per-user topic `u:<userId>`. Single-user today, but scoping is
free and future-proof. `ResourceName` is a **closed union** — the structural backstop
behind the convention.

**`server/api/events.get.ts`** — one authenticated SSE endpoint, one connection per tab.
Reuses the project's proven SSE plumbing: `text/event-stream`, 25s heartbeat comments,
`x-accel-buffering: no` (reverse-proxy safe), subscription stored in a WeakMap and cleaned
up on `req.close`. Subscribes **only** to the caller's `u:<userId>` topic (auth via the
existing `event.context.user`).

**Emit at the write sites** — every mutation handler and every background task calls
`publishChange` after a successful commit:

- HTTP handlers under `server/api/**` (documents create/update/delete/move, image
  upload/patch/reprocess, memory create/review/archive, projects, tasks, etc.).
- Background tasks: `enrich-images`, `enrich-input`, `enrich-memories`, `embed-documents`.
  These run without a session; since it's single-user they resolve the owner directly.

### Client components

**`app/plugins/vue-query.client.ts`** — installs `QueryClientProvider` with
`refetchOnReconnect: true` (the self-healing reconnect) and a sane `staleTime`.

**`app/plugins/live.client.ts`** — boots one `EventSource('/api/events')` per tab with
built-in reconnect. On each event it calls a **dispatch registry** keyed by `ResourceName`
that maps the event to query keys to invalidate.

**Query-key convention:**

- Detail: `[resource, id]`
- Lists: `[resource, 'list', ...filters]`

Default dispatch for `{resource, action, id}`: invalidate `[resource, id]` **and**
`[resource, 'list']`. vue-query does partial-key matching, so one `invalidateQueries`
call drops every filtered list variant of that resource.

### Data flow (end to end)

```
enrich-images finishes image 123
  → publishChange(userId, { resource:'image', action:'updated', id:'123' })
  → live-bus emits on topic u:<userId>
  → /api/events pushes { v:1, resource:'image', action:'updated', id:'123', at }
  → live.client.ts dispatch → invalidateQueries(['image','123']) + (['image','list'])
  → any tab showing that image/gallery refetches only what's affected
```

### Reconnect (self-healing)

Thin signals + `refetchOnReconnect` means a slept tab or dropped SSE needs **no** durable
event log. On reconnect, vue-query refetches the *active* queries; any invalidations missed
during the gap resolve themselves. This is why the non-goals exclude a replay buffer.

### What stays as-is (off the unified channel)

- **Voice WS** (`/api/voice/ws`) — genuinely bidirectional STT/TTS.
- **Agent activity SSE** (`/api/agent/activity`) and **agent chat** token streaming —
  ephemeral *interaction* streams, not data-cache events.
- **Clipboard thread stream** — already works (SSE + polling fallback). May *optionally*
  publish a thin `clipboard` signal for unread badges later; not required here.

## Migration Plan

Incremental — vue-query and raw `$fetch` coexist, so nothing breaks mid-flight.

1. **Foundation** — add `@tanstack/vue-query`, the QueryClient plugin, `live-bus.ts`,
   `/api/events`, and `live.client.ts` with the dispatch registry. No behavior change yet.
2. **Pilot: images** — migrate `useImages` to `useQuery`/`useMutation`; make
   `enrich-images` + upload/patch handlers `publishChange`. Highest-value proof: upload on
   one device, watch the gallery tile flip `pending → done` live on another.
3. **Roll across resources** — `documents` (tree + detail), `memories`, `review`,
   `projects`, `tasks`, `sessions`, one composable at a time, each landing with its emit
   sites. Delete the 60s badge `setInterval` in `default.vue` once memory/review counts are
   event-driven.
4. **Cleanup** — remove now-dead manual `loadX()` / refetch-after-action wiring that
   vue-query + events replace.

## Enforcement ("done the same way, forever")

- **`.claude/rules/` entry**, glob-scoped to `app/composables/**` and `server/api/**`:
  client data fetching uses vue-query with the `[resource, id]` / `[resource,'list']` key
  convention; every Nitro mutation calls `publishChange` after commit. The rule carries the
  *constraint* and points at the skill for the *how*.
- **Skill** — the end-to-end recipe for adding a new live resource: query keys → emit site
  → dispatch registry entry.
- **Typed seam** — `ResourceName` is a closed union and the dispatch registry is keyed by
  it, so adding a resource nobody wired up is a **type error**, not a silent gap.

## Testing

- **Unit** — `publishChange` emits on the correct `u:<userId>` topic; the dispatch registry
  maps each resource to the correct invalidations.
- **Integration** — hit a mutation endpoint, assert an event arrives on `/api/events` for
  that user and **not** for a different user.
- **E2E** (`playwright-cli`) — two browser contexts: mutate in A, assert B updates with no
  reload. Headline case: image enrich `pending → done` propagating across contexts.

## Affected / Reference Files

- SSE pattern: `server/api/agent/activity.get.ts`, `server/lib/agent/bus.ts`
- SSE consumer w/ fallback: `app/composables/useThreadStream.ts`
- Background tasks: `server/tasks/*.ts`, `server/services/{image-enrich,embedding,memory-enrich,enrichment}.ts`
- Badge poll to remove: `app/layouts/default.vue`
- Composables to migrate: `useImages`, `useDocuments`, `useMemories`, `useProjects`,
  `useSessions`, `useTasks`, `useClipboard`
- Config: `nuxt.config.ts` (cron schedules), `app/plugins/` (new plugins)
