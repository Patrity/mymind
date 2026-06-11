# Cleanup Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the clipboard layout overflow + media previews, add a per-image gallery rescan, and apply the five cycle-12 AI-config follow-ups.

**Architecture:** All changes are contained edits to existing files plus one new endpoint (`POST /api/images/[id]/rescan`) and one new tiny component (`ClipboardMessageVideo`). No DB migration. No new architecture.

**Tech Stack:** Nuxt 4, Nuxt UI v4, Drizzle/pg, the existing image OCR service (`describeImage` vision model), `playwright-cli` for E2E.

**Branch:** `master` is local-only with no upstream. Create a feature branch `feat/cleanup-batch` before starting; merge back when done (CI auto-deploys master on push, so do not push master mid-flight).

**Conventions:** Semantic color tokens only (no raw `gray-*`/`slate-*`/`zinc-*`). `.vue` uses Nuxt UI components. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`; lint is NOT a gate (red repo-wide) — commit with `--no-verify` if a lint pre-commit hook blocks. UI behavior verified with `playwright-cli` (not MCP). The dev server is typically already running on `:3000`.

**Test reality:** The repo's vitest suite is pure-logic only (no DB/endpoint harness). New endpoints are verified via typecheck + build + live E2E, consistent with how the cycle-12 settings endpoints were verified. Keep the existing 207 tests green.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/pages/clipboard.vue` | Modify | Move content into `UDashboardPanel #body` so the navbar pins and the thread scrolls |
| `app/components/clipboard/MessageBubble.vue` | Modify | Branch on `attachment.mime` (not `mimeType`); add `isVideo`; render video |
| `app/components/clipboard/Thread.vue` | Modify | Fix the attachment interface field `mimeType` → `mime` |
| `app/components/clipboard/MessageImage.vue` | Modify | Rename interface field `mimeType` → `mime` (used by Copy) |
| `app/components/clipboard/MessageFile.vue` | Modify | Rename interface field `mimeType` → `mime` (shown in caption) |
| `app/components/clipboard/MessageVideo.vue` | Create | `<video controls>` renderer for `video/*` attachments |
| `server/services/image-ocr.ts` | Modify | Add `rescanImage(id)` — clear fields + eager single-image enrich |
| `server/api/images/[id]/rescan.post.ts` | Create | `POST` endpoint calling `rescanImage`, returns `ImageDTO` |
| `app/composables/useImages.ts` | Modify | Add `rescan(id)` |
| `app/pages/gallery.vue` | Modify | Rescan button in the detail-modal footer (bottom-right, next to Close) + `onRescan` |
| `app/pages/onboarding.vue` | Modify | Wrap `finish()` in try/catch |
| `app/composables/useAiConfig.ts` | Modify | `save()` calls `useAiConfigStatus().refresh()` on success |
| `server/api/settings/import-env.post.ts` | Modify | 422 if config already has assignments |
| `server/api/settings/ai-config.put.ts` | Modify | Distinguish wrong-dims vs unreachable in the probe error |
| `app/utils/ai-config.ts` | Create | Client `EMBEDDING_DIM = 2560` constant (auto-imported) |
| `app/components/settings/ModelForm.vue` | Modify | Use `EMBEDDING_DIM` instead of literal `2560` |
| `app/components/settings/AssignmentsTab.vue` | Modify | Use `EMBEDDING_DIM` instead of literal `2560` |
| docs (wiki/handover) | Modify | Reflect clipboard preview + gallery rescan behavior |

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

Run:
```bash
cd /Users/tony/Documents/GitHub/mymind
git checkout -b feat/cleanup-batch
```
Expected: switched to a new branch off `master`.

---

### Task 1: Clipboard layout — pin navbar, scroll body

**Files:**
- Modify: `app/pages/clipboard.vue`

The page currently puts its content as the **default slot** of `UDashboardPanel`; it must go in `<template #body>` (like `settings.vue`/`tasks.vue`) so the `#header` navbar pins and the body scrolls. The main UI wrapper already has `h-full overflow-hidden` with `ClipboardThread` + `ClipboardComposer`; the Thread must own the scroll.

- [ ] **Step 1: Wrap content in `#body`**

Replace the template section (current lines 57–93) with:

```vue
<template>
  <UDashboardPanel grow>
    <template #header>
      <UDashboardNavbar title="Clipboard">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading state -->
      <div
        v-if="loading"
        class="flex-1 flex items-center justify-center text-muted"
      >
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      </div>

      <!-- Error state -->
      <div
        v-else-if="error"
        class="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8"
      >
        <UIcon name="i-lucide-alert-triangle" class="size-8 text-error" />
        <p class="text-sm text-muted">{{ error }}</p>
        <UButton size="sm" label="Retry" icon="i-lucide-refresh-cw" @click="resolveThread" />
      </div>

      <!-- Main clipboard UI: thread scrolls, composer pinned -->
      <div v-else-if="threadId" class="flex flex-col h-full min-h-0">
        <ClipboardThread :thread-id="threadId" class="flex-1 min-h-0 overflow-y-auto" />
        <ClipboardComposer :thread-id="threadId" class="shrink-0" />
      </div>
    </template>
  </UDashboardPanel>
</template>
```

Note: `min-h-0` on the flex column + the scrollable Thread is what lets the thread shrink and scroll instead of pushing the panel. If `ClipboardThread`'s root already sets its own height/scroll, keep the `flex-1 min-h-0 overflow-y-auto` on the usage here and verify in Step 3 that the inner list scrolls (if the Thread component has an inner scroll container that now double-scrolls, move the `overflow-y-auto` to the inner element instead — read `app/components/clipboard/Thread.vue` to confirm where the message list lives).

- [ ] **Step 2: Verify build**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: E2E — navbar pins while thread scrolls**

With `pnpm dev` running and logged in, use `playwright-cli`:
- `goto http://localhost:3000/clipboard`
- Confirm the "Clipboard" navbar is visible at the top.
- Scroll the message thread (or eval `document.querySelector('[class*=overflow-y-auto]')?.scrollTop`); confirm the navbar stays fixed and the composer stays pinned at the bottom.
- Capture a screenshot.

- [ ] **Step 4: Consistency check (other pages)**

Quickly confirm the other main pages put content in `#body` (grep): `grep -rL "#body" app/pages/*.vue` and manually verify any hit that uses `UDashboardPanel` (expected: only standalone `login`/`onboarding`/`share` and multi-panel `documents`/`voice` differ legitimately). Fix only genuine offenders that pin-fail the same way; do not refactor working pages. Note findings in the commit message.

- [ ] **Step 5: Commit**

```bash
git add app/pages/clipboard.vue
git commit --no-verify -m "fix(clipboard): pin navbar via #body so thread scrolls independently"
```

---

### Task 2: Clipboard image/video previews

**Files:**
- Modify: `app/components/clipboard/MessageBubble.vue`
- Modify: `app/components/clipboard/Thread.vue`
- Modify: `app/components/clipboard/MessageImage.vue`
- Modify: `app/components/clipboard/MessageFile.vue`
- Create: `app/components/clipboard/MessageVideo.vue`

Root cause: `MessageBubble.vue` reads `attachment.mimeType`, but the server DTO + DB field is `mime`, so `isImage` is always false. Align the client on `mime` and add a video branch.

- [ ] **Step 1: Create `MessageVideo.vue`**

Create `app/components/clipboard/MessageVideo.vue`:

```vue
<script setup lang="ts">
// Video attachment renderer. Mirrors MessageImage sizing. Serves the original
// from /api/clipboard/files/<storageKey> (auth-gated). Native controls; the
// hover Download button preserves the original filename.
interface AttachmentLike {
  storageKey: string
  mime: string
  originalName: string
}
const props = defineProps<{ attachment: AttachmentLike }>()
const url = computed(() => `/api/clipboard/files/${props.attachment.storageKey}`)
</script>

<template>
  <div class="group relative inline-block">
    <video
      :src="url"
      controls
      preload="metadata"
      class="rounded-md max-w-md max-h-96"
    />
    <div class="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition">
      <UButton
        :to="url"
        :download="props.attachment.originalName"
        external
        size="xs"
        variant="solid"
        color="neutral"
        icon="i-lucide-download"
      />
    </div>
  </div>
</template>
```

- [ ] **Step 2: Fix `MessageBubble.vue` — `mime` field + video branch**

In `app/components/clipboard/MessageBubble.vue`:

Change the `attachment` interface field (line 24) from `mimeType: string` to:
```ts
    mime: string
```

Change the `isImage` computed (line 39) and add `isVideo`:
```ts
const isImage = computed(() => props.message.attachment?.mime?.startsWith('image/') ?? false)
const isVideo = computed(() => props.message.attachment?.mime?.startsWith('video/') ?? false)
```

In the template, add the video branch between the image and file branches (replace the existing `ClipboardMessageImage`/`ClipboardMessageFile` block, lines 69–76):
```vue
      <ClipboardMessageImage
        v-else-if="isImage && props.message.attachment"
        :attachment="props.message.attachment"
      />
      <ClipboardMessageVideo
        v-else-if="isVideo && props.message.attachment"
        :attachment="props.message.attachment"
      />
      <ClipboardMessageFile
        v-else-if="props.message.attachment"
        :attachment="props.message.attachment"
      />
```

- [ ] **Step 3: Fix the attachment interface in `Thread.vue`**

In `app/components/clipboard/Thread.vue`, find the `AttachmentRow` interface (declares `mimeType: string`) and rename that field to `mime: string`. Then check anywhere in `Thread.vue` that reads `.mimeType` on an attachment and change it to `.mime` (the server sends `mime`). If `Thread.vue` passes the attachment object straight through to `MessageBubble` without reading `mimeType`, only the interface needs changing.

- [ ] **Step 4: Fix `MessageImage.vue` and `MessageFile.vue`**

Both declare `AttachmentLike { ... mimeType: string ... }` and read `props.attachment.mimeType`. Rename the interface field to `mime` and update the reads:
- `MessageImage.vue`: interface field → `mime`; `copyImage(url, props.attachment.mime)` (line 39).
- `MessageFile.vue`: interface field → `mime`; the caption `{{ props.attachment.mime }}` (line 33).

- [ ] **Step 5: Verify build**

Run: `pnpm typecheck`
Expected: PASS (no remaining `mimeType` references on clip attachments — `grep -rn "mimeType" app/components/clipboard` should return nothing).

- [ ] **Step 6: E2E — image + video render inline**

With `pnpm dev` + `playwright-cli` on `/clipboard`: upload/paste a PNG and an MP4 to the thread (or open a thread that already has them). Confirm the PNG shows an `<img>` preview, the MP4 shows a `<video>` player, and a non-media file still shows the file card. Eval: `document.querySelectorAll('.group img, .group video').length`. Screenshot.

- [ ] **Step 7: Commit**

```bash
git add app/components/clipboard/
git commit --no-verify -m "fix(clipboard): render image/video previews (align on mime field, add video branch)"
```

---

### Task 3: Gallery rescan — service + endpoint

**Files:**
- Modify: `server/services/image-ocr.ts`
- Create: `server/api/images/[id]/rescan.post.ts`

Add an eager single-image re-enrich that clears prior results first. Reuses `describeImage`, `splitTags`, `capTags`, `buildTagLibrary`, and the storage-read pattern already in `runImageOcr`.

- [ ] **Step 1: Add `rescanImage` to `image-ocr.ts`**

`buildTagLibrary` is currently a private (non-exported) function in this file — `rescanImage` lives in the same file so it can call it directly. Append this exported function (after `runImageOcr`):

```ts
// ---------------------------------------------------------------------------
// Single-image rescan (eager, on-demand)
// ---------------------------------------------------------------------------

/**
 * Clear an image's tags/OCR and immediately re-run the vision model for it.
 * Unsticks images that exhausted ocrAttempts. Returns the updated row (or null
 * if the image is missing/deleted). Never throws on a model failure — leaves
 * the image cleared with ocrAttempts incremented, mirroring runImageOcr.
 */
export async function rescanImage(id: string): Promise<typeof images.$inferSelect | null> {
  const db = useDb()

  // Clear prior results first (confirmed tags too — a full redo per product intent).
  const [cleared] = await db
    .update(images)
    .set({ tags: [], recommendedTags: [], ocrText: null, ocrAttempts: 0 })
    .where(and(eq(images.id, id), isNull(images.deletedAt)))
    .returning()
  if (!cleared) return null

  // Oversized images: mark attempted (empty sentinel) and return without calling the model.
  if (cleared.size > OCR_MAX_SIZE) {
    const [r] = await db.update(images).set({ ocrText: '' }).where(eq(images.id, id)).returning()
    return r ?? cleared
  }

  const library = await buildTagLibrary()

  try {
    const { stream } = await storage().get(cleared.storageKey)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    const dataUrl = `data:${cleared.mime};base64,${Buffer.concat(chunks).toString('base64')}`

    const result = await describeImage(dataUrl)

    if (!result.ocrText && result.tags.length === 0) {
      const [r] = await db
        .update(images)
        .set({ ocrAttempts: sql`${images.ocrAttempts} + 1` })
        .where(eq(images.id, id))
        .returning()
      return r ?? cleared
    }

    const { recommended } = splitTags(result.tags, library)
    const cappedRecommended = capTags(recommended, 10)
    const [r] = await db
      .update(images)
      .set({ ocrText: result.ocrText || '', recommendedTags: cappedRecommended })
      .where(eq(images.id, id))
      .returning()
    return r ?? cleared
  } catch (err) {
    console.warn(`[image-ocr] rescan failed for ${id}:`, err)
    const [r] = await db
      .update(images)
      .set({ ocrAttempts: sql`${images.ocrAttempts} + 1` })
      .where(eq(images.id, id))
      .returning()
    return r ?? cleared
  }
}
```

(All imports used — `and`, `eq`, `isNull`, `sql`, `useDb`, `images`, `storage`, `describeImage`, `splitTags`, `capTags`, `OCR_MAX_SIZE`, `buildTagLibrary` — already exist in this file.)

- [ ] **Step 2: Create the endpoint**

Create `server/api/images/[id]/rescan.post.ts`:

```ts
import { rescanImage } from '../../../services/image-ocr'
import { serveUrl } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await rescanImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ...row, url: serveUrl(row) }
})
```

(Auth is handled by the global `server/middleware/auth.ts` for all `/api/*`. The return shape `{ ...row, url: serveUrl(row) }` matches `ImageDTO`, identical to `index.patch.ts`.)

- [ ] **Step 3: Verify build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/image-ocr.ts "server/api/images/[id]/rescan.post.ts"
git commit --no-verify -m "feat(gallery): POST /api/images/[id]/rescan (clear + eager re-enrich)"
```

---

### Task 4: Gallery rescan — client wiring

**Files:**
- Modify: `app/composables/useImages.ts`
- Modify: `app/pages/gallery.vue`

- [ ] **Step 1: Add `rescan` to `useImages`**

In `app/composables/useImages.ts`, add after `remove` (line 27):

```ts
  const rescan = (id: string) => ofetch<ImageDTO>(`/api/images/${id}/rescan`, { method: 'POST' })
```

And add `rescan` to the returned object (line 43):

```ts
  return { list, upload, patch, remove, setPublic, approveTag, dismissTag, removeTag, rescan }
```

- [ ] **Step 2: Add `onRescan` handler in `gallery.vue`**

In `app/pages/gallery.vue` `<script setup>`, add next to the other handlers (after `onRemoveTag`, ~line 161). It reuses the existing `withMutate(fn: () => Promise<ImageDTO>)` helper (sets `mutating`, replaces `selected` with the result):

```ts
async function onRescan() {
  if (!selected.value) return
  await withMutate(() => images.rescan(selected.value!.id))
}
```

- [ ] **Step 3: Add the Rescan button to the modal footer (bottom-right, next to Close)**

In `app/pages/gallery.vue`, replace the footer actions block (the `<div class="flex justify-between items-center pt-1 border-t border-default">` containing Delete + Close) with a layout that keeps Delete on the left and groups Rescan + Close on the right:

```vue
            <!-- Actions -->
            <div class="flex justify-between items-center pt-1 border-t border-default">
              <UButton
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                :loading="deleting"
                @click="confirmDelete = true"
              >
                Delete
              </UButton>
              <div class="flex items-center gap-2">
                <UButton
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="mutating"
                  @click="onRescan"
                >
                  Rescan
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  @click="closeDetail"
                >
                  Close
                </UButton>
              </div>
            </div>
```

- [ ] **Step 4: Verify build**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: E2E — rescan clears + repopulates**

With `pnpm dev` + `playwright-cli` on `/gallery`: open an image that has tags/OCR, click **Rescan**, confirm the button shows a loading state, then the tags/OCR clear and repopulate (against the real vision rig). For an image with no prior tags, confirm it gains suggestions. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add app/composables/useImages.ts app/pages/gallery.vue
git commit --no-verify -m "feat(gallery): rescan button in image detail modal (eager re-enrich)"
```

---

### Task 5: AI-config client follow-ups

**Files:**
- Modify: `app/pages/onboarding.vue`
- Modify: `app/composables/useAiConfig.ts`
- Create: `app/utils/ai-config.ts`
- Modify: `app/components/settings/ModelForm.vue`
- Modify: `app/components/settings/AssignmentsTab.vue`

- [ ] **Step 1: `finish()` try/catch in `onboarding.vue`**

Replace the `finish()` function:

```ts
async function finish() {
  try {
    await config.save()
    await status.refresh()
    await navigateTo('/')
  } catch {
    // config.error is set by save() and rendered inside the AssignmentsTab on this step.
  }
}
```

- [ ] **Step 2: `save()` refreshes onboarding status in `useAiConfig.ts`**

In `app/composables/useAiConfig.ts`, inside `save()`, after the successful `await load(true)` (the re-pull), refresh the cached onboarding status so removing the last reasoning/embeddings assignment re-arms the gate:

```ts
      await load(true)  // re-pull redacted (keys collapse back to keep:true)
      useAiConfigStatus().refresh()  // re-arm the onboarding gate (fire-and-forget)
```

(`useAiConfigStatus` is auto-imported. `refresh()` is async but we don't need to await it here — the cached `needsOnboarding` updates when it resolves.)

- [ ] **Step 3: Create the client `EMBEDDING_DIM` constant**

Create `app/utils/ai-config.ts`:

```ts
// Client-side mirror of the embedding vector dimension. The server source of
// truth is server/lib/ai/registry/types.ts (server-only); this is the single
// client constant so components don't hardcode the literal. Auto-imported.
export const EMBEDDING_DIM = 2560
```

- [ ] **Step 4: Use `EMBEDDING_DIM` in `ModelForm.vue`**

In `app/components/settings/ModelForm.vue`, replace the hardcoded `2560` (the embedding toggle that sets `model.dim = 2560` and the "dimension 2560 (fixed)" note) with `EMBEDDING_DIM` (auto-imported — no import line needed). The writable computed becomes e.g. `set: on => model.dim = on ? EMBEDDING_DIM : null`, and the note text `dimension {{ EMBEDDING_DIM }} (fixed)`.

- [ ] **Step 5: Use `EMBEDDING_DIM` in `AssignmentsTab.vue`**

In `app/components/settings/AssignmentsTab.vue`, replace the `m.dim === 2560` check in `options()` with `m.dim === EMBEDDING_DIM`.

- [ ] **Step 6: Verify build**

Run: `pnpm typecheck`
Expected: PASS. (`grep -rn "2560" app/components/settings app/pages/onboarding.vue` should only show the constant usage, not bare literals.)

- [ ] **Step 7: Commit**

```bash
git add app/pages/onboarding.vue app/composables/useAiConfig.ts app/utils/ai-config.ts app/components/settings/ModelForm.vue app/components/settings/AssignmentsTab.vue
git commit --no-verify -m "fix(settings): finish() error guard, save()->status refresh, dedupe EMBEDDING_DIM"
```

---

### Task 6: AI-config server follow-ups

**Files:**
- Modify: `server/api/settings/import-env.post.ts`
- Modify: `server/api/settings/ai-config.put.ts`

- [ ] **Step 1: Guard `import-env` against overwriting an existing config**

In `server/api/settings/import-env.post.ts`, import `loadConfig` and, at the top of the handler (before building from `emptyDoc()`), refuse if a config already exists. Change the import line and handler start:

```ts
import { loadConfig, saveConfig, invalidate } from '../../lib/ai/registry/store'
```

```ts
export default defineEventHandler(async () => {
  // One-time seed only: refuse if a registry already exists (any assignments).
  const existing = await loadConfig()
  const hasAny = Object.values(existing.assignments).some(ids => ids.length > 0)
  if (hasAny || existing.providers.length > 0) {
    throw createError({ statusCode: 422, statusMessage: 'Config already exists', data: 'Import only seeds an empty registry; clear it first to re-import.' })
  }

  const doc = emptyDoc()
  // ... rest unchanged ...
```

(`loadConfig` returns `emptyDoc()` when no row exists, so a fresh install passes the guard. Keep the existing `saveConfig`/`invalidate`/`redactDoc` tail.)

- [ ] **Step 2: Clarify the dim-probe error in `ai-config.put.ts`**

In `server/api/settings/ai-config.put.ts`, the embeddings probe currently catches everything with `'Embedding probe failed (model unreachable?)'`. The inner wrong-dims case already throws its own 422 with a precise message and is re-thrown (`if ((err as { statusCode?: number }).statusCode === 422) throw err`). Make the fallback message not assert "unreachable" when it might not be — change the final catch's message to be accurate about both causes:

```ts
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 422) throw err
      throw createError({ statusCode: 422, statusMessage: 'Embedding probe failed', data: `Could not verify the embedding model's output dimensions (endpoint unreachable, timed out, or returned an unexpected response): ${(err as Error).message}` })
    }
```

(The wrong-dimensions case is the inner `throw createError(... returned ${v.length} dims ...)` which is re-thrown unchanged — that path already gives the precise dim count.)

- [ ] **Step 3: Verify build + tests**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS (207 existing tests stay green).

- [ ] **Step 4: E2E spot-check the import guard**

With `pnpm dev` + `playwright-cli` (logged in, config already present from prior use): `eval` a `fetch('/api/settings/import-env', { method:'POST' })` and confirm it now returns **422** (`Config already exists`) instead of wiping the config. (If you need a clean-state test of the success path, that's covered by the onboarding E2E on an empty DB.)

- [ ] **Step 5: Commit**

```bash
git add server/api/settings/import-env.post.ts server/api/settings/ai-config.put.ts
git commit --no-verify -m "fix(settings): guard import-env overwrite (422) + clearer dim-probe error"
```

---

### Task 7: Docs + final verification

**Files:** docs only.

- [ ] **Step 1: Update wiki**

- `docs/wiki/` clipboard page (if one exists; else skip): note image/video inline previews and the pinned-navbar/scroll layout.
- `docs/wiki/` gallery/images page: document the per-image **Rescan** (`POST /api/images/[id]/rescan`) — clears tags/OCR + resets attempts + eager re-enrich; unsticks images past the `ocrAttempts` cap.
- `docs/wiki/ai-providers.md`: note the `import-env` now 422s on a non-empty config (one-time seed only).

If a relevant wiki page doesn't exist, don't create a new system page — just ensure no page now describes the old (broken) behavior.

- [ ] **Step 2: Append to the AI-config handover**

In `docs/handovers/2026-06-10-ai-config-registry.md`, add a short "Follow-ups (2026-06-11)" note under known considerations: the five cycle-12 follow-ups landed (finish guard, save→status refresh, import-env overwrite guard, dim-probe message, EMBEDDING_DIM dedupe).

- [ ] **Step 3: Full gate run**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit --no-verify -m "docs: clipboard previews, gallery rescan, AI-config follow-ups"
```

---

## Self-Review Notes

- **Spec coverage:** Item 1 (clipboard layout) → Task 1. Item 2 (image/video previews) → Task 2. Item 3 (gallery rescan, eager) → Tasks 3–4. Item 4 (five AI-config follow-ups): finish guard + save→refresh + dedupe `2560` → Task 5; import-env guard + dim-probe message → Task 6. Docs → Task 7.
- **Type consistency:** `rescanImage` returns `typeof images.$inferSelect | null`; the endpoint maps it to `ImageDTO` via `{ ...row, url: serveUrl(row) }` (identical to `index.patch.ts`). `useImages.rescan` returns `ImageDTO`, consumed by `withMutate(fn: () => Promise<ImageDTO>)`. Clip attachment field is `mime` consistently across `MessageBubble`/`Thread`/`MessageImage`/`MessageFile`/`MessageVideo` after Task 2.
- **No DB migration:** all `images` fields (`tags`, `recommendedTags`, `ocrText`, `ocrAttempts`) already exist.
- **Test approach:** endpoints verified via typecheck/build + live E2E (the repo's vitest harness is pure-logic only; matches cycle-12 precedent). Existing 207 tests must stay green.
- **Known judgment call:** rescan clears confirmed `tags` too (full redo per product intent), not just recommended.
