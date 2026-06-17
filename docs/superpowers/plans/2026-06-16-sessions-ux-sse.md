# Sessions UX + SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A progressively-loaded, resizable, virtualized, live-tailing Sessions detail page (smooth on the multi-thousand-message imported sessions) plus a live-activity badge on the list.

**Architecture:** Split the detail query into `meta` (instant) + `messages` (transcript). The transcript becomes a `<SessionTranscript>` component virtualized with `@vueuse/core`'s `useVirtualList`. Live-tail piggybacks on the existing live invalidation: the meta query already refetches on SSE `session` events (default live-dispatch), so the component **watches `meta.messageCount`** and, when it grows, fetches only newer messages (`?since=`) and appends.

**Tech Stack:** Nuxt 4 / Nuxt UI v4 (`UDashboardPanel resizable`), `@tanstack/vue-query`, `@vueuse/core` (`useVirtualList`), Drizzle/Postgres.

**Spec:** `docs/superpowers/specs/2026-06-16-sessions-ux-sse-design.md`

**Correction vs spec:** the spec said live-dispatch lacks a `session` handler. It does NOT need one — `app/utils/live-dispatch.ts` already invalidates `['session', id]` + `['session', 'list']` for every resource by default, so counts already update on a transcript ship. (`lastActive` bumps on every event so it just *looks* more live.) So there is **no reactivity code fix** — Section A is the badge + a verification only.

**Conventions:** `pnpm`; gates `pnpm typecheck` (0) / `pnpm test` / `pnpm build`; lint NOT a gate. Run a single test: `node_modules/.bin/vitest run test/<file>`. Validate UI with **playwright-cli** (not MCP); local dev test login `test@example.com` / `testpassword123` (register first user if dev DB is fresh); drive Nuxt UI tabs/controls with a real `click <e-ref>`.

---

## File Structure
- **Create:** `app/utils/transcript-scroll.ts` (pure `isAtBottom`, `countNewSince`); `test/transcript-scroll.test.ts`; `app/components/sessions/SessionTranscript.vue` (virtualized transcript); `server/api/sessions/[id]/messages.get.ts`.
- **Modify:** `shared/types/session.ts` (add `SessionMeta`, `SessionMessages`); `server/services/sessions.ts` (`getSession`→`getSessionMeta` + new `getSessionMessages`); `server/api/sessions/[id].get.ts` (returns meta); `app/composables/useSessions.ts` (split queries + `since` fetch); `app/pages/sessions/[id].vue` (split-pane + wire meta + mount `<SessionTranscript>`); `app/pages/sessions/index.vue` (live badge); `docs/wiki/sessions.md`.

---

## Task 1: Pure scroll helpers (TDD)

**Files:** Create `app/utils/transcript-scroll.ts`, `test/transcript-scroll.test.ts`.

- [ ] **Step 1 — failing test** (`test/transcript-scroll.test.ts`):
```ts
import { describe, it, expect } from 'vitest'
import { isAtBottom, countNewSince } from '../app/utils/transcript-scroll'

describe('isAtBottom', () => {
  it('true within threshold of the bottom, false otherwise', () => {
    // gap = scrollHeight - scrollTop - clientHeight; at-bottom when gap <= threshold
    expect(isAtBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(true)  // gap 0
    expect(isAtBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(true)  // gap 40
    expect(isAtBottom({ scrollTop: 870, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(false) // gap 50
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 80 }, 40)).toBe(false) // gap 420
  })
})

describe('countNewSince', () => {
  it('counts items after the last-seen id (exclusive); 0 if last is newest/absent', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(countNewSince(items, 'a')).toBe(2)
    expect(countNewSince(items, 'c')).toBe(0)
    expect(countNewSince(items, null)).toBe(0)
    expect(countNewSince(items, 'zzz')).toBe(0)
  })
})
```

- [ ] **Step 2 — run, expect FAIL** (module missing): `node_modules/.bin/vitest run test/transcript-scroll.test.ts`

- [ ] **Step 3 — implement** (`app/utils/transcript-scroll.ts`):
```ts
/** True when the scroll position is within `threshold` px of the bottom. Pure. */
export function isAtBottom(s: { scrollTop: number, scrollHeight: number, clientHeight: number }, threshold = 40): boolean {
  return s.scrollHeight - s.scrollTop - s.clientHeight <= threshold
}

/** Count of items after the one with id === lastSeenId (exclusive). 0 if not found / newest / null. Pure. */
export function countNewSince<T extends { id: string }>(items: T[], lastSeenId: string | null): number {
  if (!lastSeenId) return 0
  const i = items.findIndex(x => x.id === lastSeenId)
  return i < 0 ? 0 : items.length - 1 - i
}
```

- [ ] **Step 4 — run, expect PASS.** `pnpm typecheck` → 0.
- [ ] **Step 5 — commit:** `git add app/utils/transcript-scroll.ts test/transcript-scroll.test.ts && git commit -m "feat(sessions): pure transcript scroll helpers"`

---

## Task 2: Backend — meta / messages split

**Files:** Modify `shared/types/session.ts`, `server/services/sessions.ts`, `server/api/sessions/[id].get.ts`; Create `server/api/sessions/[id]/messages.get.ts`.

Context: `getSession` (server/services/sessions.ts) currently returns the full `SessionDetail` (session row + `messages` + `toolEvents`). Split it.

- [ ] **Step 1 — types** (`shared/types/session.ts`): add (keep `SessionDetail` for now; it becomes unused after the page migrates — remove in Task 4):
```ts
export interface SessionMeta extends SessionListItem {
  cwd: string | null
  machineId: string | null
  gitBranch: string | null
  gitCommit: string | null
  gitRemote: string | null
  appVersion: string | null
  endedAt: string | null
  metadata: Record<string, unknown>
}

export interface SessionMessages {
  messages: SessionMessageDTO[]
  toolEvents: SessionToolEventDTO[]
}
```

- [ ] **Step 2 — service** (`server/services/sessions.ts`): rename `getSession` → `getSessionMeta` returning `SessionMeta` (drop the `messages`/`toolEvents` loads + the `messageDTOs`/`toolEventDTOs` mapping; return the session-row fields only). Add `getSessionMessages`:
```ts
export async function getSessionMessages(id: string, opts: { since?: string } = {}): Promise<SessionMessages> {
  const db = useDb()
  const msgs = await db.select().from(messages)
    .where(opts.since
      ? sql`${messages.sessionId} = ${id} and ${messages.createdAt} > ${opts.since}`
      : eq(messages.sessionId, id))
    .orderBy(asc(messages.createdAt))
  const messageDTOs: SessionMessageDTO[] = msgs.map(m => ({
    id: m.id, role: m.role, content: m.content, thinking: m.thinking, model: m.model,
    isSidechain: m.isSidechain, metadata: (m.metadata as Record<string, unknown>) ?? {}, createdAt: m.createdAt.toISOString()
  }))
  const tevs = await db.select().from(toolEvents).where(eq(toolEvents.sessionId, id)).orderBy(asc(toolEvents.createdAt))
  const toolEventDTOs: SessionToolEventDTO[] = tevs.map(t => ({
    id: t.id, messageId: t.messageId, toolName: t.toolName, args: t.args, result: t.result,
    exitStatus: t.exitStatus, phase: t.phase, toolUseId: t.toolUseId, isSidechain: t.isSidechain, createdAt: t.createdAt.toISOString()
  }))
  return { messages: messageDTOs, toolEvents: toolEventDTOs }
}
```
Update the import type line to include `SessionMeta`/`SessionMessages`. (The `getSession` mapping for messages/toolEvents is moved verbatim into `getSessionMessages` — copy it from the current `getSession`.)

- [ ] **Step 3 — endpoints.** `server/api/sessions/[id].get.ts`:
```ts
import { getSessionMeta } from '../../services/sessions'
export default defineEventHandler(async (event) => {
  const session = await getSessionMeta(getRouterParam(event, 'id')!)
  if (!session) throw createError({ statusCode: 404 })
  return session
})
```
Create `server/api/sessions/[id]/messages.get.ts`:
```ts
import { getSessionMessages } from '../../../services/sessions'
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const since = getQuery(event).since as string | undefined
  return getSessionMessages(id, { since })
})
```

- [ ] **Step 4 — `pnpm typecheck`** (expect errors only in `[id].vue` which still uses `useSessionDetail`/`session.messages` — that migrates in Task 4; backend + types compile). If `getSessionMeta` is referenced anywhere else, grep `getSession\b` and update.
- [ ] **Step 5 — integration check:** `node_modules/.bin/tsx --env-file=.env -e "import('./server/services/sessions.ts')"` is not meaningful without a server; instead verify in Task 7's playwright pass. Commit now:
`git add shared/types/session.ts server/services/sessions.ts server/api/sessions/ && git commit -m "feat(sessions): split detail into meta + messages(since) endpoints"`

---

## Task 3: Composables — split + since fetch

**Files:** Modify `app/composables/useSessions.ts`.

- [ ] **Step 1 — replace `useSessionDetail`** with meta + messages queries + a raw since-fetch (keep `useSessionList` unchanged):
```ts
import type { SessionListItem, SessionMeta, SessionMessages } from '~~/shared/types/session'
// ...
const getMeta = (id: string) => $fetch<SessionMeta>(`/api/sessions/${id}`)
const getMessages = (id: string, since?: string) =>
  $fetch<SessionMessages>(`/api/sessions/${id}/messages`, { query: since ? { since } : {} })

const useSessionMeta = (id: MaybeRefOrGetter<string | undefined>) => {
  const key = computed(() => toValue(id))
  return useQuery({
    queryKey: computed(() => ['session', key.value] as const),
    queryFn: () => getMeta(key.value as string),
    enabled: computed(() => !!key.value)
  })
}
const useSessionMessages = (id: MaybeRefOrGetter<string | undefined>) => {
  const key = computed(() => toValue(id))
  return useQuery({
    queryKey: computed(() => ['session', key.value, 'messages'] as const),
    queryFn: () => getMessages(key.value as string),
    enabled: computed(() => !!key.value)
  })
}
return { list, useSessionList, useSessionMeta, useSessionMessages, getMessages }
```
(Remove the old `get`/`useSessionDetail`.)

- [ ] **Step 2 — `pnpm typecheck`** (still errors in `[id].vue` until Task 4 — expected). Commit:
`git add app/composables/useSessions.ts && git commit -m "feat(sessions): useSessionMeta + useSessionMessages composables"`

---

## Task 4: Detail page — split-pane + meta panel + transcript extraction

**Files:** Create `app/components/sessions/SessionTranscript.vue` (skeleton here; virtualization in Task 5); Modify `app/pages/sessions/[id].vue`; remove `SessionDetail` from `shared/types/session.ts`.

- [ ] **Step 1 — create `app/components/sessions/SessionTranscript.vue`** as a NON-virtualized component first (move the existing markup so behaviour is unchanged, then Task 5 virtualizes). Props:
```ts
const props = defineProps<{ messages: SessionMessageDTO[], toolEvents: SessionToolEventDTO[], loading?: boolean }>()
```
Move into this component, **verbatim from the current `app/pages/sessions/[id].vue`**: the message-classification + helper functions (`msgKind`, `toolNames`, `hasMetaDetails`, `metaJson`, `exitColor`, `openMeta`/`toggleMeta`, `toolEventsByMsg` — but source `toolEventsByMsg` from `props.toolEvents`, and the `v-for` from `props.messages`) and the entire transcript markup block (current lines ~298–470: the scroll container + the three turn variants + the empty state). Wrap the scroll container in a `ref` (`scrollEl`) for Task 5.

- [ ] **Step 2 — rewrite `app/pages/sessions/[id].vue`** to: use `useSessionMeta` + `useSessionMessages`; render a resizable split-pane. Keep the existing header card markup (lines ~194–289) as the LEFT panel content (driven by `meta`), and mount `<SessionTranscript :messages :tool-events :loading>` in the RIGHT panel. Pattern (mirror `app/pages/voice.vue`'s `UDashboardPanel resizable`):
```vue
<UDashboardPanel id="session-detail" grow :ui="{ body: '!p-0' }">
  <template #header><UDashboardNavbar :title="sessionTitle || 'Session'"> … existing navbar … </UDashboardNavbar></template>
  <template #body>
    <div v-if="metaNotFound"> … existing not-found block … </div>
    <div v-else class="flex flex-1 min-w-0 h-full">
      <UDashboardPanel id="session-meta" resizable :default-size="34" :min-size="22" :max-size="55" class="border-r border-default">
        <template #body>
          <div class="p-4 overflow-y-auto">
            <USkeleton v-if="metaPending" class="h-40 w-full rounded-lg" />
            <!-- existing header CARD markup (title/stats/dates/git/machine), driven by `meta` instead of `session` -->
          </div>
        </template>
      </UDashboardPanel>
      <div class="flex-1 min-w-0 h-full">
        <SessionTranscript :messages="messages" :tool-events="toolEvents" :loading="messagesPending" />
      </div>
    </div>
  </template>
</UDashboardPanel>
```
where `const { data: meta, isPending: metaPending, error } = useSessionMeta(...)`, `const { data: msgData, isPending: messagesPending } = useSessionMessages(...)`, `const messages = computed(() => msgData.value?.messages ?? [])`, `const toolEvents = computed(() => msgData.value?.toolEvents ?? [])`, `metaNotFound`/`sessionTitle`/`gitBranch` etc. derived from `meta`. Confirm the exact `UDashboardPanel resizable` prop names against `app/pages/voice.vue` (`resizable`, `:default-size`, `:min-size`, `:max-size`) before finalizing.

- [ ] **Step 3 — remove `SessionDetail`** from `shared/types/session.ts` (now unused). Grep `SessionDetail` to confirm no remaining references.

- [ ] **Step 4 — `pnpm typecheck`** → 0 errors. **Build:** `pnpm build`.
- [ ] **Step 5 — playwright-cli smoke:** open a session detail; confirm the left meta panel paints (with a skeleton) before the transcript, the resize handle drags, and all three turn types still render. (Login: register/use `test@example.com`/`testpassword123`.)
- [ ] **Step 6 — commit:** `git add app/components/sessions/SessionTranscript.vue app/pages/sessions/[id].vue shared/types/session.ts && git commit -m "feat(sessions): resizable split-pane + progressive meta/transcript load"`

---

## Task 5: Virtualize the transcript

**Files:** Modify `app/components/sessions/SessionTranscript.vue`.

The transcript renders a heterogeneous list (each `msg` is one row; tool events render *inside* their message row via `toolEventsByMsg`). Virtualize over `props.messages`.

- [ ] **Step 1 — wire `useVirtualList`:**
```ts
import { useVirtualList } from '@vueuse/core'
const scrollEl = ref<HTMLElement | null>(null)
const { list, containerProps, wrapperProps } = useVirtualList(
  computed(() => props.messages),
  { itemHeight: 120, overscan: 8 }   // estimate; dynamic heights handled by overscan + min-height rows
)
```
- [ ] **Step 2 — restructure the template:** replace the `<template v-for="msg in props.messages">` with `useVirtualList`'s container/wrapper, iterating `list` (each entry is `{ index, data: msg }`). Bind `containerProps` to the scroll element (merge its `ref`/`onScroll` with `scrollEl`) and `wrapperProps` to the inner wrapper; render each `{ data: msg }` through the existing three-variant turn markup. Keep `toolEventsByMsg` (built from `props.toolEvents`).
  - Because tool-event detail makes rows tall/variable, give each rendered row a wrapper with `min-h-0` and let content flow; `itemHeight` is an estimate and `overscan: 8` absorbs variance. (If scroll jumpiness appears on very tall rows, switch `itemHeight` to a function returning a per-kind estimate — but try the constant first.)
- [ ] **Step 3 — `pnpm typecheck` + `pnpm build`.**
- [ ] **Step 4 — playwright-cli:** open `2d-rpg`'s largest session; confirm the DOM mounts only a bounded window of message nodes (e.g. `eval(() => document.querySelectorAll('[data-msg]').length)` stays small while total messages are thousands) and scrolling is smooth. Add a `data-msg` attr to each row for the assertion.
- [ ] **Step 5 — commit:** `git add app/components/sessions/SessionTranscript.vue && git commit -m "feat(sessions): virtualize transcript (useVirtualList)"`

---

## Task 6: Autoscroll + live-tail append

**Files:** Modify `app/components/sessions/SessionTranscript.vue`, `app/pages/sessions/[id].vue`, `app/composables/useSessions.ts` (already has `getMessages`).

- [ ] **Step 1 — autoscroll on load** (in `SessionTranscript.vue`): after the first non-empty `props.messages`, `nextTick(() => scrollToBottom())` where `scrollToBottom()` sets `scrollEl.value.scrollTop = scrollEl.value.scrollHeight`. Track `lastSeenId = ref<string|null>(null)` = id of the last message currently rendered.
- [ ] **Step 2 — "N new" affordance:** track `atBottom` via the scroll handler using `isAtBottom({scrollTop,scrollHeight,clientHeight})` (Task 1). When new messages arrive while `!atBottom`, show a floating `UButton` "↓ {{ countNewSince(props.messages, lastSeenId) }} new" (Task 1 helper) that on click scrolls to bottom and updates `lastSeenId`. When `atBottom`, auto-follow (scrollToBottom) and advance `lastSeenId`.
- [ ] **Step 3 — live-tail in the page** (`[id].vue`): the `meta` query already refetches on SSE `session` events (default live-dispatch). Watch `meta.value?.messageCount`; when it exceeds the currently-loaded message count, fetch only newer messages and append to the cache:
```ts
const { getMessages } = useSessions()
const qc = useQueryClient()
watch(() => meta.value?.messageCount, async (count, prev) => {
  if (count == null || prev == null || count <= prev) return
  const cur = messages.value
  const since = cur.length ? cur[cur.length - 1]!.createdAt : undefined
  const delta = await getMessages(route.params.id as string, since)
  if (!delta.messages.length && !delta.toolEvents.length) return
  qc.setQueryData(['session', route.params.id, 'messages'], (old: SessionMessages | undefined) => ({
    messages: [...(old?.messages ?? []), ...delta.messages],
    toolEvents: [...(old?.toolEvents ?? []), ...delta.toolEvents]
  }))
}, { flush: 'post' })
```
This appends (no full refetch) and the transcript reactively renders the new rows; autoscroll/“N new” (Step 2) handles the viewport.
- [ ] **Step 4 — `pnpm typecheck` + `pnpm build`.**
- [ ] **Step 5 — playwright-cli (best-effort):** hard to drive a real live ingest; instead verify the helpers via the unit tests (Task 1) and manually confirm autoscroll-on-load + that scrolling up shows the “↓ new” button after appending via a `setQueryData` poke in the console. Commit:
`git add app/components/sessions/SessionTranscript.vue app/pages/sessions/[id].vue && git commit -m "feat(sessions): autoscroll + live-tail append (watch messageCount, since-fetch)"`

---

## Task 7: List live-activity badge + docs

**Files:** Modify `app/pages/sessions/index.vue`, `docs/wiki/sessions.md`.

- [ ] **Step 1 — read `app/pages/sessions/index.vue`** to see how rows render the list (it uses `useSessionList`). The list already refetches on SSE (default dispatch) — confirm by playwright (trigger an event, watch a count change).
- [ ] **Step 2 — per-row pulse:** keep a `ref<Record<string, number>>` of `lastActive` seen per session id. In a `watch` on the list data, for any row whose `lastActive` increased since last seen, bump a transient `pulse[id]` (a counter or a timestamp) and render a small `UChip` (color `primary`, `inset`) or an animate-ping dot on that row for ~2s. This makes streaming activity visible. Reset the map on unmount.
```ts
const seen = new Map<string, string>()
const pulse = ref<Record<string, number>>({})
watch(() => rows.value, (list) => {
  for (const s of list ?? []) {
    const prev = seen.get(s.id)
    if (prev && s.lastActive > prev) { pulse.value[s.id] = Date.now(); setTimeout(() => { delete pulse.value[s.id] }, 2000) }
    seen.set(s.id, s.lastActive)
  }
}, { deep: true })
```
Render: `<UChip v-if="pulse[s.id]" color="primary" inset><!-- row content --></UChip>` or a `<span class="animate-ping …" />` dot next to the title.
- [ ] **Step 3 — `pnpm typecheck` + `pnpm build`.**
- [ ] **Step 4 — playwright-cli:** load `/sessions`; (optionally) curl a `POST /api/hooks/cc/Stop` on a known session with a bearer token to bump `lastActive`, confirm the row pulses.
- [ ] **Step 5 — `docs/wiki/sessions.md`:** document the meta/messages split (two endpoints), the virtualized live-tailing transcript + resizable split-pane, and the list live badge. Bump `updated`.
- [ ] **Step 6 — full gates + commit:**
`pnpm typecheck && pnpm test && pnpm build` (all green), then `git add app/pages/sessions/index.vue docs/wiki/sessions.md && git commit -m "feat(sessions): list live-activity badge + wiki"`

---

## Self-Review (run after implementation)
- **Spec coverage:** virtualize (T5) · incremental since-append (T6) · fetch-all-once (T3, full messages query) · list SSE reactivity (already works — verified T7) · live badge (T7) · progressive meta/messages split (T2,T3,T4) · resizable split-pane (T4) · autoscroll/N-new (T6). All covered.
- **Manual-verification note:** UI behaviour (split-pane, virtualization, autoscroll, badge) has no vitest — validated via playwright-cli per task; only the pure helpers (T1) are unit-tested.
- **Spec deviation:** no live-dispatch `session` handler added (already covered by the default) — see the plan header.
