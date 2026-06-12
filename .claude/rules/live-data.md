---
paths:
  - "app/composables/**"
  - "app/pages/**"
  - "server/api/**"
  - "server/services/**"
  - "server/tasks/**"
---

# Live data conventions

This app is **live by default** — data updates across devices/tabs without a manual
refresh. Follow BOTH halves or the UI goes stale on other devices.

**Client (reads):** Fetch data with `@tanstack/vue-query` (`useQuery`/`useMutation`).
Key detail queries `[resource, id]` and list queries `[resource, 'list', params]`. When a
list hook takes reactive params, wrap them in a `computed` inside the hook so the key is
reactive (a raw getter has stable identity and never refetches). The query's `data` is
**read-only** — iterate `computed(() => data.value ?? [])`; never mutate it, never keep a
parallel hand-rolled `ref` + `loadX()` + manual refetch-after-action (that pattern was
removed). Surface load errors by watching the query's `error` ref, not `isFetching`.

**Server (writes):** Every successful mutation — HTTP handler under `server/api/**` AND
background task/service under `server/services|tasks/**` — MUST call
`publishChange({ resource, action, id })` (`server/utils/live-bus.ts`) after the DB commit.
`action` is `created | updated | deleted`. Background loops emit per item, not once per
batch. Don't double-emit (if a handler calls a service that already emits, emit in one
place only).

`resource` must be a member of `ResourceName` (`shared/types/live.ts`). The client dispatch
registry (`app/utils/live-dispatch.ts`) is keyed by that union, so a new resource that
isn't wired up is a **type error** — keep the union, the emit sites, and the registry in
sync.

How-to (the full end-to-end recipe): use the **add-live-resource** skill.
Design rationale: `docs/superpowers/specs/2026-06-12-live-reactivity-design.md`.
Plugin gotcha: see the `nuxt-plugin-load-order` memory — the SSE plugin uses `dependsOn`.
