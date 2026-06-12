---
name: add-live-resource
description: Use when adding or modifying a data resource that should update live across tabs/devices in MyMind (a new entity type, a new mutation endpoint, or a new background writer). Wires @tanstack/vue-query reads + publishChange writes end-to-end.
---

# Add a live resource

MyMind is live by default: a change on one device/tab shows on another with no refresh.
This is the end-to-end recipe. The transport already exists — you only wire the resource in.

## How it works (the moving parts)
- `server/utils/live-bus.ts` — `publishChange({resource, action, id})` emits a thin signal
  on one in-process channel.
- `server/api/events.get.ts` — one SSE stream per tab (auth-gated).
- `app/plugins/live.client.ts` — opens the stream (gated on `authClient.getSession()`),
  routes each event through `app/utils/live-dispatch.ts`.
- `app/utils/live-dispatch.ts` — maps `{resource, action, id}` → vue-query invalidations:
  default invalidates `[resource, id]` + `[resource, 'list']`; `OVERRIDES` adds extra keys
  (e.g. a badge count).
- `app/plugins/vue-query.ts` — the QueryClient (named plugin; the SSE plugin `dependsOn` it).

## Steps

1. **Type.** Add the name to `ResourceName` in `shared/types/live.ts` (closed union).

2. **Reads.** In the resource's composable, add `useXList` (key `[resource,'list',params]`)
   and, if there's a detail view, `useXDetail(id)` (key `[resource, id]`, with
   `enabled: computed(() => !!id)`). Use `useQuery`. For reactive params, wrap in a
   `computed` inside the hook so the key is reactive. Keep all existing exports.

3. **Pages.** Consume the hooks: `const items = computed(() => data.value ?? [])`. Delete
   the old `ref` + `loadX()` + manual-refetch-after-action. `items` is read-only — replace
   any in-place patching with `await refetch()`. Watch `error` (not `isFetching`) for toasts.

4. **Writes.** In EVERY mutation — HTTP handlers under `server/api/**` AND background
   services/tasks under `server/services|tasks/**` — call
   `publishChange({ resource, action, id })` after the DB commit. `action` is
   `created | updated | deleted`. Background loops emit per item. Emit once per logical
   write (don't double-emit across a handler + the service it calls). Import path is
   relative to `server/utils/live-bus` — count the `../` from the file's location.

5. **Dispatch (only if needed).** The default invalidation covers most resources. Add an
   `OVERRIDES` entry in `app/utils/live-dispatch.ts` only for extra keys (e.g. a sidebar
   count badge), and add a unit test in `test/live-dispatch.test.ts`.

6. **Verify.** `pnpm typecheck` + `pnpm vitest run`, then a two-context `playwright-cli`
   check: mutate in browser A, confirm browser B updates with no reload.

## Gotchas
- The tree/list query key MUST match what the dispatch invalidates (`[resource,'list']`) —
  a mismatched key silently fails to update.
- Drag-and-drop lists (`useSortable`): keep the dragged arrays mutable (not a computed) and
  guard the rebuild watcher with an `isDragging` flag so a live refetch can't yank a card
  mid-drag (see `app/pages/tasks.vue`).
- Editors with unsaved edits: gate the live-sync watcher with a dirty flag so an incoming
  refresh can't clobber in-progress typing (see `app/components/documents/Editor.vue`).

Design rationale: `docs/superpowers/specs/2026-06-12-live-reactivity-design.md`.
