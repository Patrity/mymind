# Live Reactivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frontend update live across devices/tabs — when any Nitro write (user action or background task) changes data, the relevant view refreshes without a manual reload, touching only what changed.

**Architecture:** A single in-process `EventEmitter` ("live-bus") carries thin `{resource, action, id}` signals on one global channel. Every Nitro mutation calls `publishChange` after commit. One auth-gated SSE endpoint (`/api/events`) fans the channel out to each tab. On the client, `@tanstack/vue-query` is the cache; a dispatch registry maps each signal to `invalidateQueries`, so the affected query refetches. Reconnect self-heals via `refetchOnReconnect`.

**Tech Stack:** Nuxt 4.4.6 / Nitro, Node `EventEmitter`, SSE, `@tanstack/vue-query` (+ `@tanstack/vue-query-devtools` optional), vitest 4, Drizzle/Postgres, better-auth, playwright-cli for E2E.

**Scope note (single-user):** The data model has no `userId` on rows; events use one global channel. Per-user scoping is a documented future seam, not built here. See `docs/superpowers/specs/2026-06-12-live-reactivity-design.md`.

---

## File Structure

**New files**
- `server/utils/live-bus.ts` — typed global event bus (`publishChange`, `subscribeChanges`, types).
- `server/api/events.get.ts` — SSE endpoint streaming the bus to one connection per tab.
- `app/plugins/vue-query.ts` — installs `VueQueryPlugin` + SSR hydration; exports nothing.
- `app/utils/live-dispatch.ts` — pure function mapping a `LiveEvent` to query invalidations (unit-testable).
- `app/plugins/live.client.ts` — boots the single `EventSource`, calls the dispatch registry.
- `shared/types/live.ts` — shared `ResourceName` / `LiveEvent` types (server + client).
- `.claude/rules/live-data.md` — the standing convention (vue-query keys + always-emit).
- `.claude/skills/add-live-resource/SKILL.md` — recipe for adding a new live resource.
- Tests: `test/live-bus.test.ts`, `test/live-dispatch.test.ts`.

**Modified files**
- `app/composables/useImages.ts` (+ `useDocuments`, `useMemories`, `useReview`/review usage, `useProjects`, `useTasks`, `useSessions`) — migrate to vue-query.
- Image mutation handlers: `server/api/upload.post.ts`, `server/api/images/[id].patch.ts`, `server/api/images/[id].delete.ts`, `server/api/images/[id]/reprocess.post.ts`, `server/api/images/[id]/revectorize.post.ts`.
- Background services/tasks: `server/services/image-enrich.ts`, `server/services/enrichment.ts`, `server/services/memory-enrich.ts`, `server/services/embedding.ts` (emit after per-item commit).
- Document/memory/project/task/session mutation handlers under `server/api/**`.
- `app/layouts/default.vue` — drop the 60s `setInterval`; counts become event-driven.

---

## Task 1: Shared types + the live-bus (server)

**Files:**
- Create: `shared/types/live.ts`
- Create: `server/utils/live-bus.ts`
- Test: `test/live-bus.test.ts`

- [ ] **Step 1: Write the shared types**

Create `shared/types/live.ts`:

```ts
// Thin change signals broadcast to all connected tabs. One global channel
// (single-user app — see docs/superpowers/specs/2026-06-12-live-reactivity-design.md).
export type ResourceName =
  | 'document'
  | 'image'
  | 'memory'
  | 'review'
  | 'project'
  | 'task'
  | 'session'
  | 'clipboard'

export type LiveAction = 'created' | 'updated' | 'deleted'

export interface LiveEvent {
  v: 1
  resource: ResourceName
  action: LiveAction
  id: string
  at: number
}
```

- [ ] **Step 2: Write the failing test**

Create `test/live-bus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { publishChange, subscribeChanges } from '../server/utils/live-bus'
import type { LiveEvent } from '../shared/types/live'

describe('live-bus', () => {
  it('delivers a published change to a subscriber as a versioned, timestamped event', async () => {
    const received: LiveEvent[] = []
    const unsub = subscribeChanges(e => received.push(e))

    publishChange({ resource: 'image', action: 'updated', id: 'img-123' })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ v: 1, resource: 'image', action: 'updated', id: 'img-123' })
    expect(typeof received[0]!.at).toBe('number')
    unsub()
  })

  it('stops delivering after unsubscribe', () => {
    const received: LiveEvent[] = []
    const unsub = subscribeChanges(e => received.push(e))
    unsub()
    publishChange({ resource: 'document', action: 'created', id: 'doc-1' })
    expect(received).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/live-bus.test.ts`
Expected: FAIL — cannot find module `../server/utils/live-bus`.

- [ ] **Step 4: Implement the bus**

Create `server/utils/live-bus.ts`:

```ts
import { EventEmitter } from 'node:events'
import type { LiveEvent } from '../../shared/types/live'

// Single in-process global channel for data-change signals. Same pattern as
// server/lib/agent/bus.ts. setMaxListeners(0) removes the 10-listener cap —
// one listener per open SSE connection (tab/device). Single-instance (no Redis)
// is correct for this homelab app. Future multi-user: add a `scope` arg here and
// a topic filter in subscribeChanges; nothing else changes.
const emitter = new EventEmitter()
emitter.setMaxListeners(0)
const CHANNEL = 'live-change'

export function publishChange(e: Pick<LiveEvent, 'resource' | 'action' | 'id'>): void {
  const event: LiveEvent = { v: 1, at: Date.now(), ...e }
  emitter.emit(CHANNEL, event)
}

export function subscribeChanges(cb: (e: LiveEvent) => void): () => void {
  emitter.on(CHANNEL, cb)
  return () => emitter.off(CHANNEL, cb)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/live-bus.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add shared/types/live.ts server/utils/live-bus.ts test/live-bus.test.ts
git commit -m "feat(live): add global live-bus + thin change-event types"
```

---

## Task 2: SSE endpoint `/api/events`

**Files:**
- Create: `server/api/events.get.ts`

This mirrors the proven SSE plumbing in `server/api/agent/activity.get.ts`. No unit test (it's an I/O shell exercised by the E2E in Task 5); correctness lives in the bus (Task 1) and dispatch (Task 4).

- [ ] **Step 1: Implement the endpoint**

Create `server/api/events.get.ts`:

```ts
// One SSE connection per tab. Streams every live-bus change to the client.
// Auth-gated by server/middleware/auth.ts (only logged-in sessions/tokens reach here).
import { subscribeChanges } from '../utils/live-bus'

export default defineEventHandler(async (event) => {
  const res = event.node.res
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders()
  res.write(': ping\n\n')

  const unsubscribe = subscribeChanges(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)

  return new Promise<void>((resolve) => {
    event.node.req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      resolve()
    })
  })
})
```

- [ ] **Step 2: Smoke-test the stream manually**

Run the dev server (`pnpm dev`) in one terminal. In another, with an authenticated session cookie available, confirm the stream stays open and emits a heartbeat. Quick check without auth wiring:

Run: `curl -N -s localhost:3000/api/events`
Expected: a `401` (auth middleware) OR, when called with a valid session cookie, an immediate `: ping` line then `: heartbeat` every 25s. A 401 here is correct proof the route is auth-gated.

- [ ] **Step 3: Commit**

```bash
git add server/api/events.get.ts
git commit -m "feat(live): SSE endpoint /api/events streaming the live-bus"
```

---

## Task 3: vue-query plugin (client cache + SSR hydration)

**Files:**
- Create: `app/plugins/vue-query.ts`
- Modify: `package.json` (add dependency)

- [ ] **Step 1: Install the dependency**

Run: `pnpm add @tanstack/vue-query`
Expected: `@tanstack/vue-query` appears in `package.json` dependencies.

- [ ] **Step 2: Create the plugin with SSR hydration**

Create `app/plugins/vue-query.ts` (canonical Nuxt + vue-query setup — dehydrates server cache into the Nuxt payload, hydrates on client):

```ts
import { VueQueryPlugin, QueryClient, hydrate, dehydrate } from '@tanstack/vue-query'

export default defineNuxtPlugin((nuxt) => {
  const vueQueryState = useState<unknown>('vue-query')

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,        // live events drive freshness; this just debounces refetches
        refetchOnReconnect: true, // self-heals missed invalidations after an SSE/network gap
        refetchOnWindowFocus: false
      }
    }
  })

  nuxt.vueApp.use(VueQueryPlugin, { queryClient })

  if (import.meta.server) {
    nuxt.hooks.hook('app:rendered', () => { vueQueryState.value = dehydrate(queryClient) })
  }
  if (import.meta.client) {
    hydrate(queryClient, vueQueryState.value)
  }
})
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS (no errors from the new plugin).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml app/plugins/vue-query.ts
git commit -m "feat(live): add @tanstack/vue-query with SSR hydration plugin"
```

---

## Task 4: Client dispatch registry (signal → invalidation)

**Files:**
- Create: `app/utils/live-dispatch.ts`
- Test: `test/live-dispatch.test.ts`

The registry is a **pure function** over a `QueryClient`-like object, so it is unit-testable with a mock — no browser needed. The default rule: invalidate `[resource, id]` (detail) and `[resource, 'list']` (all list variants — vue-query matches partial keys).

- [ ] **Step 1: Write the failing test**

Create `test/live-dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { dispatchLiveEvent } from '../app/utils/live-dispatch'
import type { LiveEvent } from '../shared/types/live'

function fakeClient() {
  const calls: unknown[][] = []
  return {
    calls,
    invalidateQueries: (arg: unknown) => { calls.push([arg]) }
  }
}

const ev = (over: Partial<LiveEvent> = {}): LiveEvent =>
  ({ v: 1, resource: 'image', action: 'updated', id: 'img-1', at: 0, ...over })

describe('dispatchLiveEvent', () => {
  it('invalidates the detail key and the list key for the resource', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev())
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'img-1'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'list'] }])
  })

  it('on delete, still invalidates list and detail', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ action: 'deleted' }))
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'list'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['image', 'img-1'] }])
  })

  it('maps a different resource to its own keys', () => {
    const c = fakeClient()
    dispatchLiveEvent(c as never, ev({ resource: 'memory', id: 'm-9' }))
    expect(c.calls).toContainEqual([{ queryKey: ['memory', 'm-9'] }])
    expect(c.calls).toContainEqual([{ queryKey: ['memory', 'list'] }])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/live-dispatch.test.ts`
Expected: FAIL — cannot find module `../app/utils/live-dispatch`.

- [ ] **Step 3: Implement the dispatch registry**

Create `app/utils/live-dispatch.ts`:

```ts
import type { QueryClient } from '@tanstack/vue-query'
import type { LiveEvent, ResourceName } from '../../shared/types/live'

// Minimal surface we use — keeps the function unit-testable with a fake client.
type Invalidator = Pick<QueryClient, 'invalidateQueries'>

// Per-resource override hook. Default behaviour (invalidate detail + list) covers
// every resource today; add an entry here only when a resource needs extra keys
// (e.g. 'memory' also bumping the count badge — added in Task 8's rollout).
const OVERRIDES: Partial<Record<ResourceName, (c: Invalidator, e: LiveEvent) => void>> = {}

export function dispatchLiveEvent(client: Invalidator, e: LiveEvent): void {
  client.invalidateQueries({ queryKey: [e.resource, e.id] })
  client.invalidateQueries({ queryKey: [e.resource, 'list'] })
  OVERRIDES[e.resource]?.(client, e)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/live-dispatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/utils/live-dispatch.ts test/live-dispatch.test.ts
git commit -m "feat(live): client dispatch registry mapping signals to invalidations"
```

---

## Task 5: Wire the EventSource (client boot)

**Files:**
- Create: `app/plugins/live.client.ts`

- [ ] **Step 1: Implement the client boot plugin**

Create `app/plugins/live.client.ts` (one `EventSource` per tab; the browser auto-reconnects, and `refetchOnReconnect` heals the gap):

```ts
import { useQueryClient } from '@tanstack/vue-query'
import { dispatchLiveEvent } from '../utils/live-dispatch'
import type { LiveEvent } from '../../shared/types/live'

export default defineNuxtPlugin(() => {
  const queryClient = useQueryClient()
  let es: EventSource | null = null

  function connect() {
    es = new EventSource('/api/events')
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as LiveEvent
        if (data?.resource && data?.id) dispatchLiveEvent(queryClient, data)
      } catch { /* ignore heartbeat/comment frames */ }
    }
    // EventSource reconnects automatically on transient errors; no manual loop needed.
  }

  connect()

  if (import.meta.hot) import.meta.hot.dispose(() => es?.close())
})
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/plugins/live.client.ts
git commit -m "feat(live): boot single EventSource and route events to vue-query"
```

---

## Task 6: Pilot — migrate `useImages` to vue-query + emit on image writes

This is the proof: upload on one device, watch the gallery tile flip `pending → done` live on another. It exercises every layer (list query, detail query, mutation, HTTP-handler emit, background-task emit).

**Files:**
- Modify: `app/composables/useImages.ts`
- Modify: `server/api/upload.post.ts`, `server/api/images/[id].patch.ts`, `server/api/images/[id].delete.ts`, `server/api/images/[id]/reprocess.post.ts`, `server/api/images/[id]/revectorize.post.ts`
- Modify: `server/services/image-enrich.ts`

- [ ] **Step 1: Add the vue-query image composable (list + detail + mutations)**

Edit `app/composables/useImages.ts` to add query/mutation hooks alongside the existing raw functions (coexistence — pages migrate to these; old functions stay until callers move). Add at the top of `useImages()`'s returned object:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import type { MaybeRefOrGetter } from 'vue'
// ...existing imports...

export function useImages() {
  const qc = useQueryClient()

  // ---- raw fetchers (existing) ----
  const list = (params?: ListImagesParams) => { /* unchanged */ }
  const patch = (id: string, body: Record<string, unknown>) =>
    ofetch<ImageDTO>(`/api/images/${id}`, { method: 'PATCH', body })
  // ...keep upload, remove, reprocess, revectorize, updateMeta, addTag, etc. unchanged...

  // ---- vue-query layer ----
  // List key: ['image','list', <normalized params>]. partial-key invalidation on
  // ['image','list'] refetches every variant.
  const useImageList = (params?: MaybeRefOrGetter<ListImagesParams | undefined>) =>
    useQuery({
      queryKey: ['image', 'list', params],
      queryFn: () => list(toValue(params))
    })

  const useImageDetail = (id: MaybeRefOrGetter<string>) =>
    useQuery({
      queryKey: ['image', toValue(id)],
      queryFn: () => ofetch<ImageDTO>(`/api/images/${toValue(id)}`)
    })

  // Mutations invalidate locally for the acting tab; the SSE event covers other tabs.
  const usePatchImage = () =>
    useMutation({
      mutationFn: (vars: { id: string, body: Record<string, unknown> }) => patch(vars.id, vars.body),
      onSuccess: (_d, vars) => {
        qc.invalidateQueries({ queryKey: ['image', vars.id] })
        qc.invalidateQueries({ queryKey: ['image', 'list'] })
      }
    })

  return {
    list, upload, patch, remove, setPublic, approveTag, dismissTag, removeTag, reprocess, revectorize, updateMeta, addTag,
    useImageList, useImageDetail, usePatchImage
  }
}
```

> Note for the executor: keep all existing exported functions; this task only **adds** the `useImageList`/`useImageDetail`/`usePatchImage` hooks. Migrating the gallery page's `loadImages()` to `useImageList` happens in Step 4.

- [ ] **Step 2: Emit from the image HTTP handlers**

In each handler below, add `import { publishChange } from '../utils/live-bus'` (adjust the relative depth — handlers in `server/api/images/[id]/` use `'../../../utils/live-bus'`) and call `publishChange` **after** the DB write returns, before the response.

`server/api/upload.post.ts` — after the image row is created (and made public if requested), before building the response:

```ts
publishChange({ resource: 'image', action: 'created', id: row.id })
```

`server/api/images/[id].patch.ts` — after the patch persists, using the route id:

```ts
publishChange({ resource: 'image', action: 'updated', id })
```

`server/api/images/[id].delete.ts` — after the delete succeeds:

```ts
publishChange({ resource: 'image', action: 'deleted', id })
```

`server/api/images/[id]/reprocess.post.ts` and `server/api/images/[id]/revectorize.post.ts` — after the row update returns:

```ts
publishChange({ resource: 'image', action: 'updated', id })
```

- [ ] **Step 3: Emit from the background enrichment service**

In `server/services/image-enrich.ts`, locate the point where a single image's enrichment is persisted (the commit that sets `enrichStatus` to `done`/`failed`). Add `import { publishChange } from '../utils/live-bus'` and, immediately after that per-image commit:

```ts
publishChange({ resource: 'image', action: 'updated', id })
```

(One emit per image, inside the loop — not once for the whole batch — so each tile updates as its image finishes.)

- [ ] **Step 4: Migrate the gallery page to the live query**

In the gallery page/component that currently calls `useImages().list()` via a manual `loadImages()` + `ref`, replace that with `const { data: images, isPending } = useImageList(() => ({ q: query.value, tags: tags.value }))`. Remove the manual `loadImages()` calls after upload/patch (the mutation + SSE now drive refresh). Render from `images` (a vue-query ref).

- [ ] **Step 5: Typecheck + unit tests**

Run: `pnpm typecheck && pnpm vitest run test/live-bus.test.ts test/live-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: E2E — cross-context live update (the core proof)**

Using `playwright-cli`, with a test account (create one if needed):
1. Open two browser contexts (A and B), both authenticated, both on the gallery.
2. In context A, upload an image.
3. Assert — **without reloading** — that context B shows the new tile (created event), and that its status transitions `pending → done` after the `enrich-images` task runs (trigger it via `POST /api/admin/ocr-run` to avoid waiting for cron).

Expected: B reflects both the new image and the enrich completion with no manual refresh.

- [ ] **Step 7: Commit**

```bash
git add app/composables/useImages.ts server/api/upload.post.ts "server/api/images/[id].patch.ts" "server/api/images/[id].delete.ts" "server/api/images/[id]/reprocess.post.ts" "server/api/images/[id]/revectorize.post.ts" server/services/image-enrich.ts app/pages
git commit -m "feat(live): images go live — vue-query + emit on writes and enrichment"
```

---

## Task 7: Roll out to the remaining resources

Apply the **exact same recipe** as Task 6 to each resource below, one resource per commit. Recipe per resource:

1. Add `useXList` / `useXDetail` (+ a mutation hook if the page mutates) to its composable, keyed `[resource, 'list', params]` and `[resource, id]`.
2. Migrate the page(s) off manual `loadX()`/`ref` onto the query hook; drop manual refetch-after-action.
3. Add `publishChange({ resource, action, id })` after **every** mutation commit — both HTTP handlers and the background service/task that writes that resource.

Concrete per-resource emit map (find each mutation handler under the listed path with `grep -rn "defineEventHandler" <path>` and add the matching emit; add task emits inside the per-item commit loop):

- [ ] **`document`** — composable `useDocuments.ts` (tree + detail). Handlers under `server/api/documents/**` (create → `created`; update/move → `updated`; delete → `deleted`). Background: `server/services/embedding.ts` after each doc's embedding commit → `updated`. Commit: `feat(live): documents go live`.

- [ ] **`memory`** — composable `useMemories.ts`. Handlers under `server/api/memories/**` (create → `created`; review/archive → `updated`). Background: `server/services/memory-enrich.ts` after each extracted memory commit → `created`. Commit: `feat(live): memories go live`.

- [ ] **`review`** — review queue (`/api/review/**` + count). Background: `server/services/enrichment.ts` (`enrich-input`) emits `review` `created` when a `/input/*` doc lands in the queue. Commit: `feat(live): review queue goes live`.

- [ ] **`project`** — composable `useProjects.ts`, handlers under `server/api/projects/**`. Commit: `feat(live): projects go live`.

- [ ] **`task`** — composable `useTasks.ts`, handlers under `server/api/tasks/**`. Commit: `feat(live): tasks go live`.

- [ ] **`session`** — composable `useSessions.ts`, handlers under `server/api/sessions/**`. Commit: `feat(live): sessions go live`.

For each resource: after wiring, run `pnpm typecheck` and the unit suite, then a quick two-context `playwright-cli` check on that resource's main screen (mutate in A → appears in B without reload). Commit per resource.

---

## Task 8: Replace the 60s badge poll with event-driven counts

**Files:**
- Modify: `app/layouts/default.vue`
- Modify: `app/utils/live-dispatch.ts` (add count-invalidation override)

- [ ] **Step 1: Make the count queries vue-query-backed**

In `app/layouts/default.vue`, replace the two `useFetch('/api/review/count')` / `useFetch('/api/memories/count')` + `setInterval` block with vue-query:

```ts
const { data: reviewCount } = useQuery({ queryKey: ['review', 'count'], queryFn: () => $fetch<number>('/api/review/count') })
const { data: memoryCount } = useQuery({ queryKey: ['memory', 'count'], queryFn: () => $fetch<number>('/api/memories/count') })
// NOTE: delete `countTimer`, the setInterval, and the onUnmounted clearInterval — events drive these now.
```

- [ ] **Step 2: Invalidate counts from the dispatch override**

In `app/utils/live-dispatch.ts`, register overrides so memory/review change events also refresh their badge counts:

```ts
const OVERRIDES: Partial<Record<ResourceName, (c: Invalidator, e: LiveEvent) => void>> = {
  memory: (c) => c.invalidateQueries({ queryKey: ['memory', 'count'] }),
  review: (c) => c.invalidateQueries({ queryKey: ['review', 'count'] })
}
```

- [ ] **Step 3: Add a dispatch test for the override**

Append to `test/live-dispatch.test.ts`:

```ts
it('memory events also invalidate the badge count', () => {
  const c = fakeClient()
  dispatchLiveEvent(c as never, ev({ resource: 'memory', id: 'm-1' }))
  expect(c.calls).toContainEqual([{ queryKey: ['memory', 'count'] }])
})
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/live-dispatch.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/layouts/default.vue app/utils/live-dispatch.ts test/live-dispatch.test.ts
git commit -m "feat(live): badges update from events; remove 60s poll"
```

---

## Task 9: Enforcement — rule + skill

**Files:**
- Create: `.claude/rules/live-data.md`
- Create: `.claude/skills/add-live-resource/SKILL.md`

- [ ] **Step 1: Write the path-scoped rule**

Create `.claude/rules/live-data.md`:

```markdown
---
globs:
  - "app/composables/**"
  - "app/pages/**"
  - "server/api/**"
  - "server/services/**"
  - "server/tasks/**"
description: Live-reactivity conventions — vue-query cache + always-emit on writes.
---

# Live data conventions

This app is live by default. Follow both halves or the UI goes stale on other devices.

**Client (reads):** Fetch data with `@tanstack/vue-query`. Key detail queries `[resource, id]`
and list queries `[resource, 'list', params]`. Never hand-roll `loadX()` + `ref` + manual
refetch-after-action — that pattern is being removed.

**Server (writes):** Every successful mutation — HTTP handler AND background task/service —
MUST call `publishChange({ resource, action, id })` (`server/utils/live-bus.ts`) after the
DB commit. Background tasks emit per item inside the loop, not once per batch.

`resource` must be a member of `ResourceName` (`shared/types/live.ts`). Adding a new resource
that isn't wired into the dispatch registry (`app/utils/live-dispatch.ts`) is a type error —
keep that union and the registry in sync.

How-to: see the `add-live-resource` skill.
Design: `docs/superpowers/specs/2026-06-12-live-reactivity-design.md`.
```

- [ ] **Step 2: Write the skill**

Create `.claude/skills/add-live-resource/SKILL.md`:

```markdown
---
name: add-live-resource
description: Use when adding or modifying a data resource that should update live across tabs/devices (new entity type, new mutation endpoint, or new background writer). Wires vue-query reads + publishChange writes end-to-end.
---

# Add a live resource

End-to-end recipe so a resource updates on every device without a manual refresh.

1. **Type** — add the name to `ResourceName` in `shared/types/live.ts`.
2. **Reads** — in the resource's composable, expose `useXList` (key `[resource,'list',params]`)
   and `useXDetail` (key `[resource, id]`) via `useQuery`. Pages consume these, not manual fetches.
3. **Writes** — in EVERY mutation (HTTP handler under `server/api/**` and any background
   service/task under `server/services|tasks/**`), call
   `publishChange({ resource, action, id })` after the DB commit. `action` is
   `created | updated | deleted`. Background loops emit per item.
4. **Dispatch** — the default invalidates `[resource, id]` + `[resource, 'list']`. Add an
   entry to `OVERRIDES` in `app/utils/live-dispatch.ts` only for extra keys (e.g. a badge count).
5. **Verify** — `pnpm typecheck`, unit-test any new dispatch override, and run a two-context
   `playwright-cli` check: mutate in A, see it in B with no reload.

See the design: `docs/superpowers/specs/2026-06-12-live-reactivity-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/live-data.md .claude/skills/add-live-resource/SKILL.md
git commit -m "docs(live): rule + skill enforcing live-data conventions"
```

---

## Task 10: Final verification + handover

- [ ] **Step 1: Full gate**

Run: `pnpm typecheck && pnpm vitest run && pnpm build`
Expected: all PASS. (Per project memory: lint is red repo-wide and is NOT a gate; test/typecheck/build are.)

- [ ] **Step 2: Live E2E sweep**

With `playwright-cli` and two authenticated contexts, confirm no-reload propagation for: images (upload + enrich), documents (create/move), memories (create + background extraction via `POST /api/admin/memory-enrich-run`), review badge (via `POST /api/admin/enrich-run`). Capture a short note of each PASS.

- [ ] **Step 3: Wiki + handover**

- Add `docs/wiki/live-reactivity.md` describing the shipped system (bus, `/api/events`, dispatch registry, key convention, enforcement) with `status` set to shipped.
- Write `docs/handovers/<date>-live-reactivity.md` with accurate frontmatter: what shipped, the global-channel decision (and the per-user seam), which resources are live, and the next seam (e.g. clipboard unread badge, fat-event promotion for hot paths).
- Update `docs/superpowers/plans/00-roadmap.md` and `docs/BACKLOG.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/live-reactivity.md docs/handovers docs/superpowers/plans/00-roadmap.md docs/BACKLOG.md
git commit -m "docs(live): wiki + handover + roadmap for live reactivity"
```

---

## Self-Review (author check)

- **Spec coverage:** live-bus (T1), `/api/events` (T2), vue-query cache + SSR (T3), dispatch registry / thin-signal→invalidation (T4), client boot + reconnect (T5), emit at HTTP + background writers (T6/T7), full composable migration (T6/T7), badge-poll removal (T8), enforcement rule+skill + typed-union backstop (T9), testing unit/integration/E2E (T1/T4/T6/T10), non-goals respected — no Redis/CRDT/replay/triggers. ✓
- **Global-channel correction** from the spec is honored throughout (`publishChange` takes no userId). ✓
- **Type consistency:** `publishChange`, `subscribeChanges`, `dispatchLiveEvent`, `LiveEvent`, `ResourceName` used identically across tasks. ✓
- **Placeholders:** none — every code step shows real code; emit sites enumerated by file. The one intentional discovery step (T6/T7) is "locate the per-item commit," which is genuine codebase navigation, not a placeholder.
