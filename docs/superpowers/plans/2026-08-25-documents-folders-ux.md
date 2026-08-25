# Documents — Real Folders, Colour, and a UX Pass · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make folders real data in MyMind's document tree — persistent, colourable, right-clickable, draggable — and put a UX pass over the whole documents surface.

**Architecture:** A `folders` registry table is materialized from every document write (hooked in the *service*, not the route, so MCP/triage/ShareX writers are covered by construction). `documents.path` stays the single source of truth; the tree is the union of path-derived folders and registry rows, with colour resolved server-side by a top-down inheritance walk. Folder rename/move/delete are prefix rewrites in one transaction. The UI moves to three panes (tree · editor · collapsible inspector), swaps HTML5 drag for `useSortable`, and makes mutations optimistic.

**Tech Stack:** Nuxt 4 (ssr:false SPA), Vue 3 `<script setup>`, Nuxt UI v4, Drizzle ORM + Postgres, `@tanstack/vue-query`, `@vueuse/integrations/useSortable`, vitest, playwright-cli.

**Spec:** [`docs/superpowers/specs/2026-08-25-documents-folders-ux-design.md`](../specs/2026-08-25-documents-folders-ux-design.md)

## Global Constraints

- **Package manager is `pnpm`.** Never npm or yarn.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm build` must all be clean at every commit. `pnpm test:db` must pass locally for DB tasks (CI has no Postgres — MyMind task `70bcc740`).
- **Lint is red repo-wide and is NOT a gate.** Don't chase it.
- **Nuxt UI v4 only.** Use `U*` components, never hand-rolled `<div>`+Tailwind for something a component covers. Invoke the `nuxt-ui-docs` skill before using a component you haven't used in this plan — training-data knowledge of its props is stale.
- **Semantic colour tokens only** in classes: `primary`/`success`/`error`/`neutral`, `text-default`/`text-muted`/`text-dimmed`, `bg-default`/`bg-elevated`/`bg-muted`, `border-default`. Never `text-gray-200`, `bg-purple-600`, `slate-*`, `zinc-*`. (Folder *swatches* are inline hex from the palette — that is data, not a class.)
- **Folder colour vocabulary is hex from `PROJECT_PALETTE`** (14 values), matching `projects.color`. NOT the `task_columns` semantic aliases.
- **Every successful mutation publishes `publishChange({ resource, action, id })`** after the DB commit (`server/utils/live-bus.ts`). A new resource name must be added to BOTH `shared/types/live.ts` and `app/utils/live-dispatch.ts` or it's a type error.
- **Browser validation uses `playwright-cli`, never the Playwright MCP.** Invoke the `browser-testing` skill for credentials and the snapshot→ref→click workflow.
- **Local dev DB is the `mymind-db` Docker container** (`docker start mymind-db`), Postgres on `localhost:5433`, `DATABASE_URL` in `.env`.
- **Never run `pnpm build` while `pnpm dev` is running** — they share `.nuxt` and it corrupts the dev server.

---

## File Structure

**Created**
| Path | Responsibility |
|---|---|
| `shared/types/folders.ts` | `FolderDTO`, `FOLDER_PALETTE`, `FolderColor` |
| `server/db/schema/folders.ts` | the `folders` table |
| `server/services/folders.ts` | `ancestorFolderPaths`, `ensureFolders`, create/rename/move/delete, impact |
| `server/services/folders.test.ts` | unit tests for the pure path helpers |
| `server/api/folders/index.post.ts` | create an empty folder |
| `server/api/folders/[id].patch.ts` | rename / move / colour |
| `server/api/folders/[id].delete.ts` | recursive delete |
| `server/api/folders/[id]/impact.get.ts` | counts behind the confirm dialogs |
| `app/lib/documents/view-mode.ts` (+ `.test.ts`) | `resolveViewMode` — the empty-doc preview rule |
| `app/lib/documents/folder-list.ts` (+ `.test.ts`) | `collectFolderPaths` — folder options for pickers |
| `app/components/documents/NewDocumentModal.vue` | create with a folder picker |
| `app/components/documents/RenameModal.vue` | rename a file or folder |
| `app/components/documents/MoveModal.vue` | move a file or folder |
| `app/components/documents/FolderDeleteModal.vue` | recursive delete confirm with counts |
| `app/components/documents/FolderColorPicker.vue` | swatch grid + "inherit" |
| `app/components/documents/TreeRow.vue` | one tree row: rail, icon, label, context menu |
| `app/components/documents/Inspector.vue` | metadata panel |
| `app/composables/useFolders.ts` | folder HTTP calls + optimistic vue-query mutations |
| `test/folders-materialize.db.test.ts` | materialization through the real service |
| `test/folders-cascade.db.test.ts` | cascading move/delete against a real DB |

**Modified**
| Path | Change |
|---|---|
| `server/db/schema/index.ts` | export `./folders` |
| `server/services/tree.ts` | `buildTree` takes folder rows; `applyFolderColors` |
| `server/services/tree.test.ts` | new cases (create if absent) |
| `server/services/documents.ts` | `createDoc`/`updateDoc` call `ensureFolders`; `listTree` composes colour |
| `shared/types/live.ts` | `'folder'` added to `ResourceName` |
| `app/utils/live-dispatch.ts` | `folder` override invalidating the tree |
| `app/utils/project-color.ts` | re-export the palette from `shared/types/folders.ts` |
| `app/components/documents/Tree.vue` | shrinks to render + selection + drag wiring |
| `app/components/documents/Editor.vue` | loses the metadata block; gains `resolveViewMode` |
| `app/pages/documents.vue` | three panes; modal extraction |
| `docs/wiki/document-spine.md` | folders, colour, the new tree DTO |

---

## Phase 1 — Quick wins (no dependency on folders)

### Task 1: Empty documents never open in Preview

**Files:**
- Create: `app/lib/documents/view-mode.ts`
- Create: `app/lib/documents/view-mode.test.ts`
- Modify: `app/components/documents/Editor.vue` (the `mode` cookie at :93, the `watch(isMarkdown)` at :115, and every `mode` reference in the template)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveViewMode(stored: ViewMode, doc: { content: string, isMarkdown: boolean }): ViewMode` and `type ViewMode = 'edit' | 'preview' | 'split'`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/documents/view-mode.test.ts
import { describe, it, expect } from 'vitest'
import { resolveViewMode } from './view-mode'

// The view mode is a year-long cookie (mm.documents.viewMode). Restoring it blindly meant
// opening a brand-new empty note in Preview — a blank pane with no visible way to type.
// The resolution is per-document and must NOT write back to the cookie, or opening one
// empty note would permanently reset a preference the user set deliberately.
describe('resolveViewMode', () => {
  it('forces edit when an empty markdown doc would open in preview', () => {
    expect(resolveViewMode('preview', { content: '', isMarkdown: true })).toBe('edit')
    expect(resolveViewMode('preview', { content: '   \n\t ', isMarkdown: true })).toBe('edit')
  })

  it('leaves split alone on an empty doc — half the pane is still an editor', () => {
    expect(resolveViewMode('split', { content: '', isMarkdown: true })).toBe('split')
  })

  it('keeps preview for a doc that actually has content', () => {
    expect(resolveViewMode('preview', { content: '# hi', isMarkdown: true })).toBe('preview')
  })

  it('forces edit for non-markdown regardless of stored mode', () => {
    expect(resolveViewMode('preview', { content: 'select 1', isMarkdown: false })).toBe('edit')
    expect(resolveViewMode('split', { content: 'select 1', isMarkdown: false })).toBe('edit')
  })

  it('passes edit through unchanged in every case', () => {
    expect(resolveViewMode('edit', { content: '', isMarkdown: true })).toBe('edit')
    expect(resolveViewMode('edit', { content: '# hi', isMarkdown: true })).toBe('edit')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run app/lib/documents/view-mode.test.ts`
Expected: FAIL — `Failed to resolve import "./view-mode"`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/documents/view-mode.ts
export type ViewMode = 'edit' | 'preview' | 'split'

/**
 * The view mode actually used for a document, given the user's stored preference.
 *
 * Pure and per-document by design: the caller keeps the cookie untouched, so a preference
 * of `preview` survives opening an empty note and comes back for the next document that
 * has content. `split` is deliberately left alone — it still shows a live editor pane.
 */
export function resolveViewMode(
  stored: ViewMode,
  doc: { content: string, isMarkdown: boolean }
): ViewMode {
  if (!doc.isMarkdown) return 'edit'
  if (stored === 'preview' && doc.content.trim() === '') return 'edit'
  return stored
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run app/lib/documents/view-mode.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the editor**

In `app/components/documents/Editor.vue`:

Add the import next to the existing `createAutosave` import:

```ts
import { resolveViewMode, type ViewMode } from '~/lib/documents/view-mode'
```

Replace the local `type Mode = 'edit' | 'preview' | 'split'` declaration with nothing (the imported `ViewMode` replaces it), and change the cookie declaration to use it:

```ts
// View mode preference, persisted in a cookie. This is the user's INTENT — the mode
// actually rendered is `mode` below, which can differ for one document without
// overwriting the preference.
const storedMode = useCookie<ViewMode>('mm.documents.viewMode', {
  default: () => 'edit',
  maxAge: 60 * 60 * 24 * 365
})

const mode = computed<ViewMode>(() =>
  resolveViewMode(storedMode.value, { content: content.value, isMarkdown: isMarkdown.value })
)
```

Delete the now-redundant watcher entirely — `resolveViewMode` covers non-markdown, and the watcher was silently rewriting the user's cookie:

```ts
// DELETE THIS BLOCK (was Editor.vue:115-117)
// watch(isMarkdown, (md) => {
//   if (!md && mode.value !== 'edit') mode.value = 'edit'
// })
```

In the template, the three mode buttons read `mode` (unchanged) but must now WRITE `storedMode`:

```vue
<UButton icon="i-lucide-pencil" size="xs"
  :variant="mode === 'edit' ? 'solid' : 'ghost'"
  :color="mode === 'edit' ? 'primary' : 'neutral'"
  class="rounded-none" @click="storedMode = 'edit'" />
<UButton icon="i-lucide-columns-2" size="xs"
  :variant="mode === 'split' ? 'solid' : 'ghost'"
  :color="mode === 'split' ? 'primary' : 'neutral'"
  class="rounded-none border-x border-default" @click="storedMode = 'split'" />
<UButton icon="i-lucide-eye" size="xs"
  :variant="mode === 'preview' ? 'solid' : 'ghost'"
  :color="mode === 'preview' ? 'primary' : 'neutral'"
  class="rounded-none" @click="storedMode = 'preview'" />
```

- [ ] **Step 6: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: 0 type errors; all tests pass (1222 + 5 new).

- [ ] **Step 7: Commit**

```bash
git add app/lib/documents/view-mode.ts app/lib/documents/view-mode.test.ts app/components/documents/Editor.vue
git commit -m "fix(documents): an empty document never opens in preview"
```

---

### Task 2: Folder picker on New document (and searchable Move)

**Files:**
- Create: `app/lib/documents/folder-list.ts`
- Create: `app/lib/documents/folder-list.test.ts`
- Create: `app/components/documents/NewDocumentModal.vue`
- Modify: `app/pages/documents.vue` (remove the inline modal at the end of the template, the `newPath`/`creating`/`createDocument`/`openNewModal` block at :36-86)
- Modify: `app/components/documents/Tree.vue` (`collectFolders` at :86-100 is deleted in favour of the shared helper; the Move modal's `USelect` at :580 becomes `USelectMenu`)

**Interfaces:**
- Consumes: `TreeNode` from `~~/server/services/tree`.
- Produces: `collectFolderPaths(nodes: TreeNode[]): string[]` — every folder path in the tree, root `'/'` first, depth-first, deduped. `NewDocumentModal` props `{ open: boolean, tree: TreeNode[], defaultFolder?: string }`, emits `{ 'update:open': [boolean], created: [id: string] }`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/documents/folder-list.test.ts
import { describe, it, expect } from 'vitest'
import { collectFolderPaths } from './folder-list'
import type { TreeNode } from '~~/server/services/tree'

const f = (name: string, path: string, children: TreeNode[] = []): TreeNode =>
  ({ name, path, type: 'folder', children })
const d = (name: string, path: string): TreeNode =>
  ({ name, path, type: 'file', id: `id-${name}` })

describe('collectFolderPaths', () => {
  it('always offers the root first so a doc can be created at the top level', () => {
    expect(collectFolderPaths([])).toEqual(['/'])
  })

  it('walks nested folders depth-first and ignores files', () => {
    const tree = [
      f('projects', '/projects', [
        f('mymind', '/projects/mymind', [d('auth.md', '/projects/mymind/auth.md')]),
        f('portfolio', '/projects/portfolio')
      ]),
      f('input', '/input', [d('note.md', '/input/note.md')])
    ]
    expect(collectFolderPaths(tree)).toEqual([
      '/', '/projects', '/projects/mymind', '/projects/portfolio', '/input'
    ])
  })

  it('never emits a duplicate even if the tree repeats a path', () => {
    const tree = [f('input', '/input'), f('input', '/input')]
    expect(collectFolderPaths(tree)).toEqual(['/', '/input'])
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run app/lib/documents/folder-list.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/documents/folder-list.ts
import type { TreeNode } from '~~/server/services/tree'

/**
 * Every folder path in the tree, as options for a picker. Root first — creating at the
 * top level has to be reachable, and it is not a node in the tree.
 *
 * Extracted from Tree.vue's private `collectFolders` so the New-document modal and the
 * Move modal read the same list from the same source instead of one of them making the
 * user type a path by hand.
 */
export function collectFolderPaths(nodes: TreeNode[]): string[] {
  const out: string[] = ['/']
  const seen = new Set(out)
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.type !== 'folder') continue
      const path = n.path || '/'
      if (!seen.has(path)) { seen.add(path); out.push(path) }
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run app/lib/documents/folder-list.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Build the modal**

```vue
<!-- app/components/documents/NewDocumentModal.vue -->
<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import { collectFolderPaths } from '~/lib/documents/folder-list'

const props = defineProps<{
  open: boolean
  tree: TreeNode[]
  /** Folder to preselect — the open document's folder, or the folder that was right-clicked. */
  defaultFolder?: string
}>()

const emit = defineEmits<{ 'update:open': [boolean], created: [id: string] }>()

const toast = useToast()
const { create } = useDocuments()

const folder = ref('/')
const filename = ref('untitled.md')
const creating = ref(false)

const folders = computed(() => collectFolderPaths(props.tree))

// The path the user is about to create, shown live under the fields. Typing a full path by
// hand was the whole complaint — this is the reassurance that the two fields add up.
const finalPath = computed(() => {
  const name = filename.value.trim()
  if (!name) return ''
  return folder.value === '/' ? `/${name}` : `${folder.value}/${name}`
})

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  folder.value = props.defaultFolder && folders.value.includes(props.defaultFolder)
    ? props.defaultFolder
    : '/'
  filename.value = 'untitled.md'
})

async function submit() {
  if (!finalPath.value) return
  creating.value = true
  try {
    const doc = await create({ path: finalPath.value })
    emit('created', doc.id)
    emit('update:open', false)
    toast.add({ color: 'success', title: 'Document created', description: doc.path })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Create failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-file-plus"
              class="size-5"
            />
            <span class="font-semibold">New document</span>
          </div>
        </template>

        <div class="space-y-3">
          <UFormField label="Folder">
            <USelectMenu
              v-model="folder"
              :items="folders"
              class="w-full font-mono text-sm"
              placeholder="Select a folder"
            />
          </UFormField>

          <UFormField label="Filename">
            <UInput
              v-model="filename"
              autofocus
              class="w-full font-mono text-sm"
              placeholder="untitled.md"
              @keyup.enter="submit"
            />
          </UFormField>

          <p class="text-xs text-dimmed font-mono truncate">
            {{ finalPath || '—' }}
          </p>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="emit('update:open', false)"
            >
              Cancel
            </UButton>
            <UButton
              :loading="creating"
              :disabled="!finalPath"
              @click="submit"
            >
              Create
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
```

- [ ] **Step 6: Use it from the page**

In `app/pages/documents.vue`, delete `newPath`, `creating`, `createDocument`, `openNewModal` and the whole inline `<UModal>` at the end of the template. Keep `showNewModal`. Add:

```ts
// The folder the New-document modal should preselect: the open document's folder.
const currentFolder = computed(() => {
  const path = findSelectedPathInTree(treeData.value, selectedId.value)
  if (!path) return '/'
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
})

function findSelectedPathInTree(nodes: TreeNode[], id: string | null): string | null {
  if (!id) return null
  for (const n of nodes) {
    if (n.type === 'file' && (n.id === id || n.path === id)) return n.path
    if (n.children) {
      const found = findSelectedPathInTree(n.children, id)
      if (found) return found
    }
  }
  return null
}
```

and in the template, replacing the deleted modal:

```vue
<DocumentsNewDocumentModal
  v-model:open="showNewModal"
  :tree="treeData"
  :default-folder="currentFolder"
  @created="selectedId = $event"
/>
```

Both "New" buttons now just set `showNewModal = true`.

- [ ] **Step 7: Make Move searchable and drop the duplicate helper**

In `app/components/documents/Tree.vue`: delete the private `collectFolders` function and the `allFolders` computed, and replace with the shared helper:

```ts
import { collectFolderPaths } from '~/lib/documents/folder-list'

const allFolders = computed(() => collectFolderPaths(props.tree))
```

In the Move modal template, swap the component (this finishes cycle 58's task `7be76abc`):

```vue
<USelectMenu
  v-model="moveDestFolder"
  :items="allFolders"
  class="w-full font-mono text-sm"
  placeholder="Select folder"
/>
```

- [ ] **Step 8: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 9: Browser-validate**

Start the DB and dev server, log in, and prove both pickers work:

```bash
docker start mymind-db
PORT=3000 pnpm dev   # background; wait for :3000 to answer 200
playwright-cli goto "http://localhost:3000/documents"
# log in per the browser-testing skill (test@example.com / testpassword123)
playwright-cli snapshot | grep -iE 'New|button'
# click New, pick a folder from the menu (REAL click — USelectMenu is reka-ui), type a name
playwright-cli eval "() => document.body.innerText.includes('untitled.md')"
```

Expected: the modal shows a Folder select and a Filename field; the path preview updates; Create makes the document at the composed path.

- [ ] **Step 10: Commit**

```bash
git add app/lib/documents/folder-list.ts app/lib/documents/folder-list.test.ts \
        app/components/documents/NewDocumentModal.vue app/pages/documents.vue \
        app/components/documents/Tree.vue
git commit -m "feat(documents): pick a folder when creating a document instead of typing a path"
```

---

## Phase 2 — Folders as data

### Task 3: The `folders` table + backfill migration

**Files:**
- Create: `shared/types/folders.ts`
- Create: `server/db/schema/folders.ts`
- Modify: `server/db/schema/index.ts`
- Modify: `app/utils/project-color.ts`
- Create: `server/db/migrations/00XX_*.sql` (generated, then hand-edited)

**Interfaces:**
- Produces: `folders` Drizzle table (`id`, `path`, `color`, `createdAt`, `updatedAt`); `FOLDER_PALETTE: readonly string[]`; `type FolderColor`; `interface FolderDTO { id, path, color }`.

- [ ] **Step 1: Define the shared types**

```ts
// shared/types/folders.ts

/**
 * 14 distinct hues (Tailwind 500s) that read on the dark theme. This is the SAME list
 * projects use — a folder under /projects/<slug> inherits the project's colour, so the
 * two must be drawn from one vocabulary or the inherited value could be unrepresentable
 * in the folder picker. `app/utils/project-color.ts` re-exports this; do not fork it.
 */
export const FOLDER_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
] as const

export type FolderColor = typeof FOLDER_PALETTE[number]

/** Where a rendered folder colour came from — drives the picker's "inheriting…" hint. */
export type FolderColorSource = 'own' | 'inherited' | 'project'

export interface FolderDTO {
  id: string
  path: string
  color: string | null
}
```

- [ ] **Step 2: Point the project palette at the shared list**

Replace the palette declaration in `app/utils/project-color.ts` (keep everything else in that file untouched):

```ts
// The palette lives in shared/ because folders inherit project colours and both pickers
// must offer the same values. Re-exported here so existing importers keep working.
import { FOLDER_PALETTE } from '~~/shared/types/folders'

export const PROJECT_PALETTE = FOLDER_PALETTE
```

- [ ] **Step 3: Define the table**

```ts
// server/db/schema/folders.ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * A folder in the document tree.
 *
 * Folders used to be derived entirely from `documents.path` prefixes, which meant they had
 * no identity and ceased to exist when their last document left. This table gives them one.
 * `documents.path` is still the source of truth for WHERE a document lives — a row here does
 * not own its documents, it records that the folder exists and what colour it is.
 *
 * A row is materialized (`ensureFolders`) the first time any writer puts a document under the
 * path, so the registry is complete rather than only covering folders the user hand-created.
 * No `deleted_at`: this is metadata, not content — the documents carry their own soft delete.
 */
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // Absolute, no trailing slash: '/projects/mymind/wiki'. The root is never a row.
  path: text('path').notNull(),
  // Hex from FOLDER_PALETTE, or null to inherit from the parent / owning project.
  color: text('color'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  uniqueIndex('folders_path_uidx').on(t.path)
])

export type Folder = typeof folders.$inferSelect
```

Add to `server/db/schema/index.ts`, keeping the file's existing ordering style:

```ts
export * from './folders'
```

- [ ] **Step 4: Generate the migration**

```bash
docker start mymind-db
pnpm db:generate
```

Expected: a new `server/db/migrations/00XX_<name>.sql` creating `folders` and the unique index. Note the filename — you need it in the next step.

- [ ] **Step 5: Append the backfill to the generated SQL**

Open the generated file and append (after the existing statements, separated by drizzle's breakpoint marker):

```sql
--> statement-breakpoint
-- Backfill: every ancestor folder of every live document path. Without this the registry
-- would only cover folders touched after deploy, and existing folders would still vanish
-- when emptied — the exact bug this table exists to fix.
INSERT INTO folders (path)
SELECT DISTINCT '/' || array_to_string(s.p[1:i], '/')
FROM (
  SELECT string_to_array(trim(both '/' from path), '/') AS p
  FROM documents
  WHERE deleted_at IS NULL
) s, generate_subscripts(s.p, 1) AS i
WHERE i < array_length(s.p, 1)
ON CONFLICT (path) DO NOTHING;
```

- [ ] **Step 6: Apply and verify against the real corpus**

```bash
pnpm db:migrate
docker exec mymind-db psql -U mymind -d mymind -tAc \
  "select count(*) from folders"
docker exec mymind-db psql -U mymind -d mymind -tAc \
  "select path from folders order by path limit 10"
docker exec mymind-db psql -U mymind -d mymind -tAc \
  "select count(*) from folders where path like '%/'"
```

Expected: a non-zero count; paths look like `/input`, `/projects`, `/projects/mymind`; the trailing-slash count is **0**.

- [ ] **Step 7: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add shared/types/folders.ts server/db/schema/folders.ts server/db/schema/index.ts \
        app/utils/project-color.ts server/db/migrations/
git commit -m "feat(documents): folders table + backfill from existing document paths"
```

---

### Task 4: Materialize folders on every document write

**Files:**
- Create: `server/services/folders.ts`
- Create: `server/services/folders.test.ts`
- Create: `test/folders-materialize.db.test.ts`
- Modify: `server/services/documents.ts` (`createDoc` :174, `updateDoc` :190)

**Interfaces:**
- Consumes: `folders` table from Task 3.
- Produces: `ancestorFolderPaths(docPath: string): string[]` (root-first, filename dropped) and `ensureFolders(docPath: string, tx?: Db): Promise<void>`.

- [ ] **Step 1: Write the failing unit test**

```ts
// server/services/folders.test.ts
import { describe, it, expect } from 'vitest'
import { ancestorFolderPaths } from './folders'

describe('ancestorFolderPaths', () => {
  it('returns every ancestor folder root-first, without the filename', () => {
    expect(ancestorFolderPaths('/projects/mymind/wiki/auth.md')).toEqual([
      '/projects', '/projects/mymind', '/projects/mymind/wiki'
    ])
  })

  it('returns nothing for a document at the root — the root is not a row', () => {
    expect(ancestorFolderPaths('/notes.md')).toEqual([])
  })

  it('tolerates duplicate and trailing slashes', () => {
    expect(ancestorFolderPaths('//input//note.md')).toEqual(['/input'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run server/services/folders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/services/folders.ts
import { useDb } from '../db'
import { folders } from '../db/schema'

type Db = ReturnType<typeof useDb>

/**
 * Every ancestor folder path of a document path, root-first.
 * '/projects/mymind/wiki/auth.md' → ['/projects', '/projects/mymind', '/projects/mymind/wiki']
 *
 * Pure. The root is deliberately absent — it is not a folder row.
 */
export function ancestorFolderPaths(docPath: string): string[] {
  const parts = docPath.split('/').filter(Boolean)
  parts.pop() // the filename
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push('/' + parts.slice(0, i + 1).join('/'))
  }
  return out
}

/**
 * Record every folder a document path implies.
 *
 * Called from createDoc/updateDoc — the SERVICE, not the HTTP route — because that is the
 * only choke point every writer shares: the documents UI, MCP (save_document, sync_document,
 * move_document, edit_document), capture triage's /input sweep, and ShareX transcriptions all
 * funnel through those two functions. Hooking a route would silently miss most of them.
 *
 * Idempotent: conflicts on the unique path index are ignored.
 */
export async function ensureFolders(docPath: string, tx: Db = useDb()): Promise<void> {
  const paths = ancestorFolderPaths(docPath)
  if (!paths.length) return
  await tx.insert(folders).values(paths.map(path => ({ path }))).onConflictDoNothing()
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run server/services/folders.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Hook it into the document service**

In `server/services/documents.ts`, add the import:

```ts
import { ensureFolders } from './folders'
```

In `createDoc`, after the insert and before the return:

```ts
  const doc = toDTO(rows[0]!)
  // Materialize the folders this path implies. Every writer reaches this function, so this
  // is what keeps the registry complete without touching a single route handler.
  await ensureFolders(doc.path)
  return doc
```

In `updateDoc`, after the update returns and before the `toDTO` return:

```ts
  const [r] = await useDb().update(documents).set(patch as Partial<typeof documents.$inferInsert>).where(and(eq(documents.id, id), live())).returning()
  if (!r) return null
  // A move can create folders that did not exist before — same reasoning as createDoc.
  if (patch.path) await ensureFolders(r.path)
  return toDTO(r)
```

- [ ] **Step 6: Write the DB test that proves the MCP path is covered**

```ts
// test/folders-materialize.db.test.ts
//
// The materialization hook lives in the document SERVICE, not in a route, specifically so
// that MCP writers (save_document/sync_document/move_document) and the triage sweep are
// covered without touching them. This test exercises the service directly — the same entry
// point those writers use — because a route-level test would prove nothing about them.
process.loadEnvFile('.env')
import { describe, it, expect, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { createDoc, moveDoc, deleteDoc } = await import('../server/services/documents')

const ROOT = '/zz-folders-probe'

afterEach(async () => {
  const db = useDb()
  await db.execute(sql`delete from chunks where source_id in (select id from documents where path like ${ROOT + '%'})`)
  await db.execute(sql`delete from documents where path like ${ROOT + '%'}`)
  await db.execute(sql`delete from folders where path like ${ROOT + '%'}`)
})

async function folderPaths(prefix: string): Promise<string[]> {
  const rows = await useDb().execute<{ path: string }>(
    sql`select path from folders where path like ${prefix + '%'} order by path`
  )
  return [...rows].map(r => r.path)
}

describe('folder materialization', () => {
  it('creates a row for every ancestor when a document is created', async () => {
    await createDoc({ path: `${ROOT}/a/b/note.md` })
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`])
  })

  it('creates rows for the destination when a document moves', async () => {
    const doc = await createDoc({ path: `${ROOT}/a/note.md` })
    await moveDoc(doc.id, `${ROOT}/c/d/note.md`)
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/c`, `${ROOT}/c/d`])
  })

  it('keeps the folder row after the last document in it is deleted', async () => {
    const doc = await createDoc({ path: `${ROOT}/lonely/only.md` })
    await deleteDoc(doc.id)
    expect(await folderPaths(ROOT)).toContain(`${ROOT}/lonely`)
  })

  it('is idempotent — re-creating under the same folder does not duplicate rows', async () => {
    await createDoc({ path: `${ROOT}/a/one.md` })
    await createDoc({ path: `${ROOT}/a/two.md` })
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`])
  })
})
```

- [ ] **Step 7: Run the DB test**

```bash
docker start mymind-db
pnpm test:db
```

Expected: PASS, 4 new tests in `folders-materialize.db.test.ts`, and every pre-existing DB test still green.

- [ ] **Step 8: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add server/services/folders.ts server/services/folders.test.ts \
        test/folders-materialize.db.test.ts server/services/documents.ts
git commit -m "feat(documents): materialize folder rows from every document write"
```

---

### Task 5: The tree returns folders and resolved colours

**Files:**
- Modify: `server/services/tree.ts`
- Create: `server/services/tree.test.ts`
- Modify: `server/services/documents.ts` (`listTree` :151)

**Interfaces:**
- Consumes: `folders` table; `projects` table (`slug`, `color`); `PROJECTS_ROOT` from `server/lib/projects/doc-path`.
- Produces: `TreeNode` gains `color?: string | null` and `colorSource?: FolderColorSource | null`; `buildTree(docs: DocLite[], folderRows?: FolderLite[])`; `applyFolderColors(nodes, opts)`.

- [ ] **Step 1: Write the failing test**

```ts
// server/services/tree.test.ts
import { describe, it, expect } from 'vitest'
import { buildTree, applyFolderColors, type TreeNode } from './tree'

const find = (nodes: TreeNode[], path: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.path === path) return n
    const hit = n.children ? find(n.children, path) : undefined
    if (hit) return hit
  }
  return undefined
}

describe('buildTree with folder rows', () => {
  it('keeps a folder that has no documents left in it', () => {
    const tree = buildTree(
      [{ id: 'd1', path: '/input/note.md', title: 'note' }],
      [{ path: '/input' }, { path: '/archive' }]
    )
    expect(find(tree, '/archive')).toMatchObject({ type: 'folder', children: [] })
  })

  it('does not duplicate a folder that both a document and a row imply', () => {
    const tree = buildTree(
      [{ id: 'd1', path: '/input/note.md', title: 'note' }],
      [{ path: '/input' }]
    )
    expect(tree.filter(n => n.path === '/input')).toHaveLength(1)
  })

  it('still sorts folders before files, alphabetically', () => {
    const tree = buildTree(
      [{ id: 'd1', path: '/zebra.md', title: 'zebra' }],
      [{ path: '/alpha' }]
    )
    expect(tree.map(n => n.path)).toEqual(['/alpha', '/zebra.md'])
  })
})

describe('applyFolderColors', () => {
  const tree = () => buildTree([], [
    { path: '/projects' },
    { path: '/projects/mymind' },
    { path: '/projects/mymind/wiki' },
    { path: '/projects/mymind/specs' },
    { path: '/input' }
  ])

  it('seeds a project folder from the project colour', () => {
    const out = applyFolderColors(tree(), {
      own: new Map(),
      projects: new Map([['mymind', '#3b82f6']])
    })
    expect(find(out, '/projects/mymind')).toMatchObject({ color: '#3b82f6', colorSource: 'project' })
  })

  it('cascades a project colour to descendants as inherited', () => {
    const out = applyFolderColors(tree(), {
      own: new Map(),
      projects: new Map([['mymind', '#3b82f6']])
    })
    expect(find(out, '/projects/mymind/wiki')).toMatchObject({ color: '#3b82f6', colorSource: 'inherited' })
  })

  it("lets a folder's own colour beat the inherited one and cascade in turn", () => {
    const out = applyFolderColors(tree(), {
      own: new Map([['/projects/mymind/specs', '#ef4444']]),
      projects: new Map([['mymind', '#3b82f6']])
    })
    expect(find(out, '/projects/mymind/specs')).toMatchObject({ color: '#ef4444', colorSource: 'own' })
  })

  it('leaves a folder with no colour and no ancestor colour plain', () => {
    const out = applyFolderColors(tree(), { own: new Map(), projects: new Map() })
    expect(find(out, '/input')).toMatchObject({ color: null, colorSource: null })
  })

  it('does not colour files', () => {
    const out = applyFolderColors(
      buildTree([{ id: 'd1', path: '/projects/mymind/auth.md', title: 'auth' }], []),
      { own: new Map(), projects: new Map([['mymind', '#3b82f6']]) }
    )
    expect(find(out, '/projects/mymind/auth.md')?.color).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run server/services/tree.test.ts`
Expected: FAIL — `applyFolderColors` is not exported and `buildTree` takes one argument.

- [ ] **Step 3: Rewrite `server/services/tree.ts`**

```ts
import type { FolderColorSource } from '../../shared/types/folders'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  id?: string
  title?: string | null
  children?: TreeNode[]
  /** Folders only: the colour to render, after inheritance. */
  color?: string | null
  /** Folders only: where that colour came from, for the picker's hint. */
  colorSource?: FolderColorSource | null
}

interface DocLite { id: string, path: string, title?: string | null }
interface FolderLite { path: string }

/**
 * Build the document tree from document paths, unioned with the folder registry.
 *
 * The registry is what makes an empty folder survive: a folder with no documents left has
 * no path to derive it from, so without `folderRows` it would simply disappear from the
 * tree — which is exactly the bug the folders table exists to fix.
 */
export function buildTree(docs: DocLite[], folderRows: FolderLite[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'folder', children: [] }

  /** Walk to a folder path, creating any missing folder nodes on the way. */
  const folderAt = (parts: string[]): TreeNode => {
    let cur = root
    parts.forEach((part, i) => {
      const path = '/' + parts.slice(0, i + 1).join('/')
      let next = cur.children!.find(c => c.name === part && c.type === 'folder')
      if (!next) {
        next = { name: part, path, type: 'folder', children: [] }
        cur.children!.push(next)
      }
      cur = next
    })
    return cur
  }

  for (const doc of docs) {
    const parts = doc.path.split('/').filter(Boolean)
    const name = parts.pop()!
    const parent = folderAt(parts)
    if (!parent.children!.some(c => c.type === 'file' && c.path === doc.path)) {
      parent.children!.push({ name, path: doc.path, type: 'file', id: doc.id, title: doc.title })
    }
  }

  // Registry rows second: any folder a document already implied is found, not duplicated.
  for (const f of folderRows) {
    folderAt(f.path.split('/').filter(Boolean))
  }

  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
      .map(n => (n.children ? { ...n, children: sort(n.children) } : n))
  return sort(root.children!)
}

/** '/projects/mymind/wiki' → 'mymind'; anything not exactly two levels under /projects → null. */
function projectSlugOfFolder(path: string): string | null {
  const parts = path.split('/').filter(Boolean)
  return parts.length === 2 && parts[0] === 'projects' ? parts[1]! : null
}

/**
 * Resolve each folder's rendered colour, top-down.
 *
 * Precedence: the folder's own colour, else the owning project's colour when the folder IS
 * the project root, else whatever cascaded from an ancestor, else nothing. An override
 * cascades in turn, so a colour set deep in a tree colours everything below it.
 *
 * Pure, and resolved on the server so the client never has to know the precedence rules.
 */
export function applyFolderColors(
  nodes: TreeNode[],
  opts: { own: Map<string, string | null>, projects: Map<string, string> },
  inherited: string | null = null
): TreeNode[] {
  return nodes.map((n) => {
    if (n.type !== 'folder') return n

    const ownColor = opts.own.get(n.path) ?? null
    const slug = projectSlugOfFolder(n.path)
    const projectColor = slug ? opts.projects.get(slug) ?? null : null

    let color: string | null = null
    let colorSource: FolderColorSource | null = null
    if (ownColor) { color = ownColor; colorSource = 'own' }
    else if (projectColor) { color = projectColor; colorSource = 'project' }
    else if (inherited) { color = inherited; colorSource = 'inherited' }

    return {
      ...n,
      color,
      colorSource,
      children: n.children ? applyFolderColors(n.children, opts, color) : n.children
    }
  })
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run server/services/tree.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Compose it in `listTree`**

In `server/services/documents.ts`, replace `listTree`:

```ts
export async function listTree(): Promise<TreeNode[]> {
  const db = useDb()
  const [docRows, folderRows, projectRows] = await Promise.all([
    db.select({ id: documents.id, path: documents.path, title: documents.title })
      .from(documents).where(live()),
    db.select({ path: folders.path, color: folders.color }).from(folders),
    db.select({ slug: projects.slug, color: projects.color }).from(projects)
  ])

  const tree = buildTree(docRows, folderRows)
  return applyFolderColors(tree, {
    own: new Map(folderRows.map(f => [f.path, f.color])),
    projects: new Map(
      projectRows.filter(p => p.color).map(p => [p.slug, p.color as string])
    )
  })
}
```

Update the imports at the top of the file:

```ts
import { documents, chunks, folders, projects } from '../db/schema'
import { buildTree, applyFolderColors, type TreeNode } from './tree'
```

- [ ] **Step 6: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 7: Verify against the real tree**

```bash
docker start mymind-db
PORT=3000 pnpm dev   # background
# authenticated fetch via playwright-cli after logging in:
playwright-cli eval "async () => {
  const t = await fetch('/api/documents/tree').then(r => r.json());
  const proj = t.find(n => n.path === '/projects');
  return { topLevel: t.map(n => n.path), mymind: proj?.children?.find(c => c.path === '/projects/mymind') };
}"
```

Expected: folders present with `color` and `colorSource` fields; a project folder shows `colorSource: 'project'` if that project has a colour set, and its children show `'inherited'`.

- [ ] **Step 8: Commit**

```bash
git add server/services/tree.ts server/services/tree.test.ts server/services/documents.ts
git commit -m "feat(documents): tree carries registry folders and resolved colours"
```

---

### Task 6: Folder operations — create, rename/move, delete, impact

**Files:**
- Modify: `server/services/folders.ts`
- Modify: `server/services/folders.test.ts`
- Create: `test/folders-cascade.db.test.ts`

**Interfaces:**
- Consumes: `ancestorFolderPaths`/`ensureFolders` (Task 4); `resolveDocProjectFromPath` from `server/services/documents.ts:70`.
- Produces:
  - `rewritePrefix(path: string, from: string, to: string): string`
  - `isUnder(path: string, folderPath: string): boolean`
  - `createFolder(path: string): Promise<FolderDTO>`
  - `moveFolder(id: string, toPath: string): Promise<{ ok: true, moved: number } | { ok: false, conflict: string }>`
  - `deleteFolder(id: string): Promise<{ documents: number, folders: number }>`
  - `setFolderColor(id: string, color: string | null): Promise<FolderDTO | null>`
  - `folderImpact(id: string, toPath?: string): Promise<{ documents: number, folders: number, projectChanges: { from: string | null, to: string | null, count: number }[] }>`

- [ ] **Step 1: Write the failing unit tests for the pure helpers**

Append to `server/services/folders.test.ts`:

```ts
import { rewritePrefix, isUnder } from './folders'

describe('isUnder', () => {
  it('matches descendants at any depth', () => {
    expect(isUnder('/a/b/c.md', '/a')).toBe(true)
    expect(isUnder('/a/b', '/a')).toBe(true)
  })

  it('does not match the folder itself', () => {
    expect(isUnder('/a', '/a')).toBe(false)
  })

  it('does not match a sibling with a shared prefix', () => {
    // The bug a naive startsWith() would have: '/archive' is not under '/arch'.
    expect(isUnder('/archive/x.md', '/arch')).toBe(false)
  })
})

describe('rewritePrefix', () => {
  it('swaps the leading folder and leaves the rest alone', () => {
    expect(rewritePrefix('/a/b/c.md', '/a', '/z')).toBe('/z/b/c.md')
  })

  it('rewrites the folder path itself', () => {
    expect(rewritePrefix('/a', '/a', '/z/a')).toBe('/z/a')
  })

  it('leaves an unrelated path untouched', () => {
    expect(rewritePrefix('/other/x.md', '/a', '/z')).toBe('/other/x.md')
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run server/services/folders.test.ts`
Expected: FAIL — `rewritePrefix` / `isUnder` not exported.

- [ ] **Step 3: Implement the operations**

Append to `server/services/folders.ts`:

```ts
import { and, eq, isNull, like, sql } from 'drizzle-orm'
import { documents } from '../db/schema'
import { resolveDocProjectFromPath } from './documents'
import { getLanguageFromPath } from '../../shared/utils/languages'
import type { FolderDTO } from '../../shared/types/folders'

const toFolderDTO = (r: { id: string, path: string, color: string | null }): FolderDTO =>
  ({ id: r.id, path: r.path, color: r.color })

/**
 * Is `path` strictly inside `folderPath`?
 *
 * The separator is part of the comparison on purpose: a bare startsWith() would treat
 * '/archive/x.md' as living under '/arch', and a folder rename would then rewrite every
 * sibling whose name merely begins with the same letters.
 */
export function isUnder(path: string, folderPath: string): boolean {
  return path.startsWith(folderPath + '/')
}

/** Replace a leading folder prefix. Returns `path` unchanged when it isn't under `from`. */
export function rewritePrefix(path: string, from: string, to: string): string {
  if (path === from) return to
  if (!isUnder(path, from)) return path
  return to + path.slice(from.length)
}

export async function createFolder(path: string): Promise<FolderDTO> {
  const db = useDb()
  // Creating /a/b/c implies /a and /b exist too.
  const parents = ancestorFolderPaths(path + '/x')
  await db.insert(folders).values(parents.map(p => ({ path: p }))).onConflictDoNothing()
  const [row] = await db.insert(folders).values({ path })
    .onConflictDoNothing().returning()
  if (row) return toFolderDTO(row)
  const [existing] = await db.select().from(folders).where(eq(folders.path, path)).limit(1)
  return toFolderDTO(existing!)
}

export async function setFolderColor(id: string, color: string | null): Promise<FolderDTO | null> {
  const [row] = await useDb().update(folders)
    .set({ color, updatedAt: new Date() })
    .where(eq(folders.id, id)).returning()
  return row ? toFolderDTO(row) : null
}

async function getFolder(id: string) {
  const [row] = await useDb().select().from(folders).where(eq(folders.id, id)).limit(1)
  return row ?? null
}

/**
 * Rename or move a folder — the same operation; a rename is a move within the same parent.
 *
 * Everything happens in one transaction because a partial rewrite leaves documents pointing
 * at a folder that no longer exists. Documents are re-associated to their new project as they
 * move: `documents.path` is the source of truth for project membership (cycle 26), so a folder
 * crossing a /projects/<slug>/ boundary genuinely changes who owns its contents. The UI warns
 * about this before calling; the service performs it without further ceremony.
 */
export async function moveFolder(
  id: string,
  toPath: string
): Promise<{ ok: true, moved: number } | { ok: false, conflict: string }> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { ok: false, conflict: 'folder not found' }
  const fromPath = folder.path
  if (toPath === fromPath) return { ok: true, moved: 0 }
  if (isUnder(toPath, fromPath)) return { ok: false, conflict: 'cannot move a folder into itself' }

  const docs = await db.select({ id: documents.id, path: documents.path, title: documents.title })
    .from(documents)
    .where(and(isNull(documents.deletedAt), like(documents.path, fromPath + '/%')))

  // Pre-flight collision check. documents_path_live_uidx would reject the write anyway, but
  // its error names a constraint, not the file the user has to deal with.
  const destinations = docs.map(d => rewritePrefix(d.path, fromPath, toPath))
  const existing = await db.select({ path: documents.path }).from(documents)
    .where(and(isNull(documents.deletedAt), like(documents.path, toPath + '/%')))
  const taken = new Set(existing.map(e => e.path))
  const collision = destinations.find(p => taken.has(p))
  if (collision) return { ok: false, conflict: collision }

  await db.transaction(async (tx) => {
    for (const doc of docs) {
      const newPath = rewritePrefix(doc.path, fromPath, toPath)
      const { projectId, project } = await resolveDocProjectFromPath(newPath)
      await tx.update(documents).set({
        path: newPath, project, projectId,
        language: getLanguageFromPath(newPath), updatedAt: new Date()
      }).where(eq(documents.id, doc.id))
    }
    // The folder row and every descendant folder row.
    await tx.update(folders)
      .set({ path: sql`${toPath} || substring(${folders.path} from ${fromPath.length + 1})`, updatedAt: new Date() })
      .where(like(folders.path, fromPath + '/%'))
    await tx.update(folders).set({ path: toPath, updatedAt: new Date() }).where(eq(folders.id, id))
    await ensureFolders(toPath + '/x', tx)
  })

  return { ok: true, moved: docs.length }
}

/** Recursive delete: descendant documents are soft-deleted, folder rows are removed outright. */
export async function deleteFolder(id: string): Promise<{ documents: number, folders: number }> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { documents: 0, folders: 0 }
  const prefix = folder.path + '/'

  return db.transaction(async (tx) => {
    const docs = await tx.update(documents)
      .set({ deletedAt: new Date() })
      .where(and(isNull(documents.deletedAt), like(documents.path, prefix + '%')))
      .returning({ id: documents.id })
    const subs = await tx.delete(folders)
      .where(like(folders.path, prefix + '%'))
      .returning({ id: folders.id })
    await tx.delete(folders).where(eq(folders.id, id))
    return { documents: docs.length, folders: subs.length + 1 }
  })
}

/**
 * What a delete would destroy, or what a move would re-associate. Powers both confirm
 * dialogs — the numbers a user is asked to approve must come from the same predicates the
 * operation itself uses, not from a second implementation that can drift.
 */
export async function folderImpact(id: string, toPath?: string): Promise<{
  documents: number
  folders: number
  projectChanges: { from: string | null, to: string | null, count: number }[]
}> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { documents: 0, folders: 0, projectChanges: [] }
  const prefix = folder.path + '/'

  const docs = await db.select({ path: documents.path, project: documents.project })
    .from(documents)
    .where(and(isNull(documents.deletedAt), like(documents.path, prefix + '%')))
  const subs = await db.select({ id: folders.id }).from(folders)
    .where(like(folders.path, prefix + '%'))

  const projectChanges: { from: string | null, to: string | null, count: number }[] = []
  if (toPath) {
    const counts = new Map<string, { from: string | null, to: string | null, count: number }>()
    for (const doc of docs) {
      const { project: to } = await resolveDocProjectFromPath(
        rewritePrefix(doc.path, folder.path, toPath)
      )
      if (to === doc.project) continue
      const key = `${doc.project}→${to}`
      const entry = counts.get(key) ?? { from: doc.project, to, count: 0 }
      entry.count++
      counts.set(key, entry)
    }
    projectChanges.push(...counts.values())
  }

  return { documents: docs.length, folders: subs.length, projectChanges }
}
```

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: `pnpm vitest run server/services/folders.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the DB test for the cascade**

```ts
// test/folders-cascade.db.test.ts
//
// The cascading move is the one operation in this cycle that can do real damage: it rewrites
// N document paths, and because documents.path determines project membership (cycle 26), a
// move across a /projects/<slug>/ boundary re-associates everything inside it. These tests
// pin both halves against a real database.
process.loadEnvFile('.env')
import { describe, it, expect, afterEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { createDoc, getDoc } = await import('../server/services/documents')
const { createFolder, moveFolder, deleteFolder, folderImpact } = await import('../server/services/folders')

const ROOT = '/zz-cascade-probe'

afterEach(async () => {
  const db = useDb()
  await db.execute(sql`delete from chunks where source_id in (select id from documents where path like ${ROOT + '%'})`)
  await db.execute(sql`delete from documents where path like ${ROOT + '%'}`)
  await db.execute(sql`delete from folders where path like ${ROOT + '%'}`)
})

describe('moveFolder', () => {
  it('rewrites every descendant document path', async () => {
    const a = await createDoc({ path: `${ROOT}/src/one.md` })
    const b = await createDoc({ path: `${ROOT}/src/deep/two.md` })
    const [folder] = await useDb().execute<{ id: string }>(
      sql`select id from folders where path = ${ROOT + '/src'}`
    )
    const result = await moveFolder(folder!.id, `${ROOT}/dest`)

    expect(result).toEqual({ ok: true, moved: 2 })
    expect((await getDoc(a.id))?.path).toBe(`${ROOT}/dest/one.md`)
    expect((await getDoc(b.id))?.path).toBe(`${ROOT}/dest/deep/two.md`)
  })

  it('refuses when a destination path is already taken, naming the file', async () => {
    await createDoc({ path: `${ROOT}/src/dup.md` })
    await createDoc({ path: `${ROOT}/dest/dup.md` })
    const [folder] = await useDb().execute<{ id: string }>(
      sql`select id from folders where path = ${ROOT + '/src'}`
    )
    expect(await moveFolder(folder!.id, `${ROOT}/dest`))
      .toEqual({ ok: false, conflict: `${ROOT}/dest/dup.md` })
  })

  it('refuses to move a folder into itself', async () => {
    const folder = await createFolder(`${ROOT}/self`)
    expect(await moveFolder(folder.id, `${ROOT}/self/inner`))
      .toEqual({ ok: false, conflict: 'cannot move a folder into itself' })
  })

  it('moves descendant folder rows, including empty ones', async () => {
    await createFolder(`${ROOT}/src/empty`)
    const [folder] = await useDb().execute<{ id: string }>(
      sql`select id from folders where path = ${ROOT + '/src'}`
    )
    await moveFolder(folder!.id, `${ROOT}/dest`)
    const rows = await useDb().execute<{ path: string }>(
      sql`select path from folders where path like ${ROOT + '%'} order by path`
    )
    expect([...rows].map(r => r.path)).toContain(`${ROOT}/dest/empty`)
  })
})

describe('deleteFolder', () => {
  it('soft-deletes descendants and reports the counts', async () => {
    const doc = await createDoc({ path: `${ROOT}/gone/one.md` })
    await createFolder(`${ROOT}/gone/sub`)
    const [folder] = await useDb().execute<{ id: string }>(
      sql`select id from folders where path = ${ROOT + '/gone'}`
    )
    const result = await deleteFolder(folder!.id)

    expect(result).toEqual({ documents: 1, folders: 2 })
    expect(await getDoc(doc.id)).toBeNull()
  })
})

describe('folderImpact', () => {
  it('counts documents and sub-folders for a delete', async () => {
    await createDoc({ path: `${ROOT}/count/one.md` })
    await createDoc({ path: `${ROOT}/count/sub/two.md` })
    const [folder] = await useDb().execute<{ id: string }>(
      sql`select id from folders where path = ${ROOT + '/count'}`
    )
    expect(await folderImpact(folder!.id)).toMatchObject({ documents: 2, folders: 1 })
  })
})
```

- [ ] **Step 6: Run the DB tests**

```bash
docker start mymind-db
pnpm test:db
```

Expected: PASS — 6 new tests, everything pre-existing still green.

- [ ] **Step 7: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add server/services/folders.ts server/services/folders.test.ts test/folders-cascade.db.test.ts
git commit -m "feat(documents): folder create/move/delete with cascading path rewrite"
```

---

### Task 7: Folder HTTP endpoints and live reactivity

**Files:**
- Create: `server/api/folders/index.post.ts`
- Create: `server/api/folders/[id].patch.ts`
- Create: `server/api/folders/[id].delete.ts`
- Create: `server/api/folders/[id]/impact.get.ts`
- Modify: `shared/types/live.ts`
- Modify: `app/utils/live-dispatch.ts`

**Interfaces:**
- Consumes: everything from Task 6.
- Produces: the four routes above; `'folder'` as a `ResourceName`.

- [ ] **Step 1: Add the live resource**

In `shared/types/live.ts`, add to the union (keeping alphabetical-ish grouping with the others):

```ts
  | 'folder'
```

In `app/utils/live-dispatch.ts`, add an override — a folder mutation changes the *tree*, which is keyed `['document', 'list']`, so the default `['folder', 'list']` invalidation alone would leave the tree stale:

```ts
  // A folder mutation rewrites document paths, and the tree the user is looking at is keyed
  // ['document','list'] — invalidating only ['folder',*] would leave the tree stale.
  folder: (c) => { c.invalidateQueries({ queryKey: ['document', 'list'] }); invalidateGraph(c); invalidateHome(c) },
```

- [ ] **Step 2: Write the create route**

```ts
// server/api/folders/index.post.ts
import { z } from 'zod'
import { createFolder } from '../../services/folders'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const { path } = z.object({
    path: z.string().regex(/^\/(?!.*\/$).+/, 'path must be absolute and have no trailing slash')
  }).parse(await readBody(event))

  const folder = await createFolder(path)
  publishChange({ resource: 'folder', action: 'created', id: folder.id })
  return folder
})
```

- [ ] **Step 3: Write the patch route**

```ts
// server/api/folders/[id].patch.ts
import { z } from 'zod'
import { moveFolder, setFolderColor } from '../../services/folders'
import { FOLDER_PALETTE } from '../../../shared/types/folders'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  path: z.string().regex(/^\/(?!.*\/$).+/).optional(),
  // null clears the override and returns the folder to inheriting.
  color: z.union([z.enum(FOLDER_PALETTE), z.null()]).optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))

  if (body.path !== undefined) {
    const result = await moveFolder(id, body.path)
    if (!result.ok) {
      // 409 with the conflicting path — the raw unique-index error names a constraint, which
      // is useless to the person deciding what to rename.
      throw createError({ statusCode: 409, statusMessage: `Path already taken: ${result.conflict}` })
    }
  }

  if (body.color !== undefined) {
    const updated = await setFolderColor(id, body.color)
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }

  publishChange({ resource: 'folder', action: 'updated', id })
  return { ok: true }
})
```

- [ ] **Step 4: Write the delete and impact routes**

```ts
// server/api/folders/[id].delete.ts
import { deleteFolder } from '../../services/folders'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const counts = await deleteFolder(id)
  publishChange({ resource: 'folder', action: 'deleted', id })
  return counts
})
```

```ts
// server/api/folders/[id]/impact.get.ts
import { z } from 'zod'
import { folderImpact } from '../../../services/folders'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { to } = z.object({ to: z.string().optional() }).parse(getQuery(event))
  return folderImpact(id, to)
})
```

- [ ] **Step 5: Verify the gates**

Run: `pnpm typecheck && pnpm test`
Expected: clean. If `live-dispatch.ts` was missed, typecheck fails here — that is the guard working.

- [ ] **Step 6: Exercise the endpoints for real**

With dev running and logged in:

```bash
playwright-cli eval "async () => {
  const j = r => r.json();
  const post = (u,b) => fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(j);
  const created = await post('/api/folders', { path: '/zz-probe/empty' });
  const tree = await fetch('/api/documents/tree').then(j);
  const probe = tree.find(n => n.path === '/zz-probe');
  const impact = await fetch(`/api/folders/${created.id}/impact`).then(j);
  await fetch(`/api/folders/${created.id}`, { method: 'DELETE' });
  return { created, inTree: !!probe, impact };
}"
```

Expected: the folder is created, appears in the tree with **no documents in it**, impact reports zeros, and the delete succeeds. Then clean up the leftover `/zz-probe` row:

```bash
docker exec mymind-db psql -U mymind -d mymind -c "delete from folders where path like '/zz-probe%'"
```

- [ ] **Step 7: Commit**

```bash
git add server/api/folders/ shared/types/live.ts app/utils/live-dispatch.ts
git commit -m "feat(documents): folder endpoints + folder live resource"
```

---

## Phase 3 — UI: menus, colour, drag

### Task 8: Split Tree.vue (no behaviour change)

**Files:**
- Create: `app/components/documents/RenameModal.vue`, `MoveModal.vue`
- Create: `app/composables/useDocumentTree.ts`
- Modify: `app/components/documents/Tree.vue`

**Interfaces:**
- Produces: `useDocumentTree()` returning `{ promptRename, promptMove, promptDelete, shareDoc, retriageDoc, renameState, moveState, deleteState }` where each `*State` is a reactive object `{ open: boolean, target: { id, path, label } | null }`. `RenameModal` props `{ target, open }`, emits `{ 'update:open', done }`. `MoveModal` same plus `folders: string[]`.

This task is a pure refactor: no user-visible change, so its test is that the existing suite and a browser smoke check both stay green.

- [ ] **Step 1: Extract the actions composable**

Move `promptRename`/`confirmRename`, `promptMove`/`confirmMove`, `promptDelete`/`confirmDelete`, `shareDoc`, `retriageDoc`, `dirOf`, `basenameOf` and `copyText` out of `Tree.vue` into `app/composables/useDocumentTree.ts` verbatim, wrapping the modal open flags and targets in the `*State` objects named above. Keep every existing comment — particularly the long note above `retriageDoc` explaining why re-triage is `/input`-only; it documents a non-obvious triage rule.

- [ ] **Step 2: Extract the two modals**

Move the Rename and Move `<UModal>` blocks from `Tree.vue`'s template into `RenameModal.vue` and `MoveModal.vue`, each owning its own input state and emitting `done` on success so the caller can refresh.

- [ ] **Step 3: Verify nothing changed**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

Then browser-smoke the three flows that just moved:

```bash
# with dev running and logged in
playwright-cli goto "http://localhost:3000/documents"
playwright-cli snapshot | head -40   # right-click a file row, confirm Rename/Move/Delete still appear
```

Expected: the file context menu still offers Rename · Move · Share · Delete, and rename still works.

- [ ] **Step 4: Commit**

```bash
git add app/components/documents/RenameModal.vue app/components/documents/MoveModal.vue \
        app/composables/useDocumentTree.ts app/components/documents/Tree.vue
git commit -m "refactor(documents): split Tree.vue into a composable plus one modal per dialog"
```

---

### Task 9: TreeRow with colour rails, and folders that render from the DTO

**Files:**
- Create: `app/components/documents/TreeRow.vue`
- Modify: `app/components/documents/Tree.vue`

**Interfaces:**
- Consumes: `TreeNode` with `color`/`colorSource` (Task 5).
- Produces: `TreeRow` props `{ item: TreeItem, expanded: boolean, selected: boolean }`, emits `{ contextAction: [action: string] }`. `TreeItem` gains `color?: string | null`, `colorSource?: FolderColorSource | null`.

- [ ] **Step 1: Carry colour through `toTreeItems`**

In `Tree.vue`, extend the `TreeItem` interface and the folder branch of `toTreeItems`:

```ts
interface TreeItem {
  id: string
  label: string
  path: string
  nodeType: 'file' | 'folder'
  icon?: string
  defaultExpanded?: boolean
  children?: TreeItem[]
  color?: string | null
  colorSource?: FolderColorSource | null
}
```

```ts
    if (n.type === 'folder') {
      return {
        id: n.path,
        label: n.name,
        path: n.path,
        nodeType: 'folder',
        defaultExpanded: true,
        color: n.color ?? null,
        colorSource: n.colorSource ?? null,
        children: n.children ? toTreeItems(n.children) : []
      }
    }
```

- [ ] **Step 2: Build the row component**

```vue
<!-- app/components/documents/TreeRow.vue -->
<script setup lang="ts">
import type { FolderColorSource } from '~~/shared/types/folders'

defineProps<{
  item: {
    id: string
    label: string
    path: string
    nodeType: 'file' | 'folder'
    icon?: string
    color?: string | null
    colorSource?: FolderColorSource | null
  }
  expanded: boolean
  selected: boolean
}>()
</script>

<template>
  <div
    class="flex items-center gap-2 w-full rounded px-1 -mx-1 py-0.5 transition-colors group"
    :class="selected ? 'bg-primary/10 text-default' : 'text-muted'"
  >
    <!-- Colour rail. Inline style because the value is palette DATA (hex), not a theme token —
         it comes from the folder row or the project it inherits from. -->
    <span
      v-if="item.nodeType === 'folder'"
      class="w-0.5 h-4 rounded-full shrink-0"
      :style="item.color ? { backgroundColor: item.color } : undefined"
      :class="item.color ? '' : 'bg-transparent'"
    />

    <UIcon
      :name="item.nodeType === 'folder'
        ? (expanded ? 'i-lucide-folder-open' : 'i-lucide-folder')
        : (item.icon ?? 'i-lucide-file')"
      class="size-4 shrink-0"
      :class="item.nodeType === 'folder' && item.color ? '' : 'text-dimmed'"
      :style="item.nodeType === 'folder' && item.color ? { color: item.color } : undefined"
    />

    <span class="truncate text-sm flex-1">{{ item.label }}</span>

    <!-- Drag affordance. Hidden until hover so a static tree stays quiet. -->
    <UIcon
      name="i-lucide-grip-vertical"
      class="drag-handle size-3.5 shrink-0 text-dimmed opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
    />
  </div>
</template>
```

- [ ] **Step 3: Use it for both node types in `Tree.vue`**

Replace the `#item` template body so files and folders both render `TreeRow`, each wrapped in its own `UContextMenu` (the folder menu arrives in Task 10 — for now pass the existing file items for files and an empty array for folders).

- [ ] **Step 4: Verify the gates and the render**

Run: `pnpm typecheck && pnpm test` → clean.

```bash
playwright-cli goto "http://localhost:3000/documents"
playwright-cli eval "() => {
  const rails = [...document.querySelectorAll('span')].filter(s => s.style.backgroundColor);
  return { railCount: rails.length, sample: rails.slice(0,3).map(r => r.style.backgroundColor) };
}"
playwright-cli screenshot --filename=/tmp/tree-rails.png
```

Expected: rails render with real hex colours on project folders; read the screenshot to confirm the tree still looks right.

- [ ] **Step 5: Commit**

```bash
git add app/components/documents/TreeRow.vue app/components/documents/Tree.vue
git commit -m "feat(documents): tree rows render folder colour rails"
```

---

### Task 10: Three context menus

**Files:**
- Modify: `app/components/documents/Tree.vue`
- Modify: `app/composables/useDocumentTree.ts`

**Interfaces:**
- Consumes: `useDocumentTree` (Task 8), folder endpoints (Task 7).
- Produces: `fileMenuItems(item)`, `folderMenuItems(item)`, `rootMenuItems()` — each `ContextMenuItem[][]`.

- [ ] **Step 1: Write the menus**

In `Tree.vue`, keep the existing `contextMenuItems` as `fileMenuItems` (adding Open, Duplicate and Copy path), and add the two new builders:

```ts
function folderMenuItems(item: TreeItem): ContextMenuItem[][] {
  return [
    [
      { label: 'New document here', icon: 'i-lucide-file-plus', onSelect: () => emit('newDocument', item.path) },
      { label: 'New subfolder', icon: 'i-lucide-folder-plus', onSelect: () => promptNewFolder(item.path) }
    ],
    [
      { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => promptRename(item.id, item.path, item.label) },
      { label: 'Move', icon: 'i-lucide-folder-input', onSelect: () => promptMove(item.id, item.path, item.label) },
      { label: 'Colour', icon: 'i-lucide-palette', onSelect: () => promptColor(item) }
    ],
    [
      { label: 'Copy path', icon: 'i-lucide-clipboard', onSelect: () => copyText(item.path) },
      { label: 'Collapse all', icon: 'i-lucide-chevrons-down-up', onSelect: () => collapseUnder(item.path) }
    ],
    [
      { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => promptFolderDelete(item) }
    ]
  ]
}

function rootMenuItems(): ContextMenuItem[][] {
  return [
    [
      { label: 'New document', icon: 'i-lucide-file-plus', onSelect: () => emit('newDocument', '/') },
      { label: 'New folder', icon: 'i-lucide-folder-plus', onSelect: () => promptNewFolder('/') }
    ],
    [
      { label: 'Expand all', icon: 'i-lucide-chevrons-up-down', onSelect: expandAll },
      { label: 'Collapse all', icon: 'i-lucide-chevrons-down-up', onSelect: collapseAll }
    ]
  ]
}
```

Wrap the whole scroll container in a root `UContextMenu` so right-clicking empty space works, and give the folder rows their own.

- [ ] **Step 2: Verify in the browser — this is the complaint being fixed**

```bash
playwright-cli goto "http://localhost:3000/documents"
# right-click a FOLDER row by ref (real click; reka-ui context menus don't respond to el.click())
playwright-cli snapshot | grep -iE 'folder|projects'
playwright-cli rightclick <folderRef>
playwright-cli eval "() => document.body.innerText.match(/New document here|New subfolder|Colour/g)"
```

Expected: the folder menu appears with all four groups. Repeat for empty space below the tree.

- [ ] **Step 3: Prove the fix is the cause**

```bash
git stash push -- app/components/documents/Tree.vue
# wait for HMR, repeat the right-click probe — expect NO menu on a folder
git stash pop
```

Expected: with the change stashed, right-clicking a folder produces nothing; restored, it produces the menu.

- [ ] **Step 4: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/Tree.vue app/composables/useDocumentTree.ts
git commit -m "feat(documents): context menus for folders and empty space"
```

---

### Task 11: Folder colour picker

**Files:**
- Create: `app/components/documents/FolderColorPicker.vue`
- Create: `app/composables/useFolders.ts`
- Modify: `app/components/documents/Tree.vue`

**Interfaces:**
- Consumes: `PATCH /api/folders/[id]`; `FOLDER_PALETTE`, `FolderColorSource`.
- Produces: `useFolders()` → `{ create, patch, remove, impact }`; `FolderColorPicker` props `{ open, folderId, folderPath, current, source }`, emits `{ 'update:open' }`.

- [ ] **Step 1: Write the composable**

```ts
// app/composables/useFolders.ts
import { $fetch as ofetch } from 'ofetch'
import type { FolderDTO } from '~~/shared/types/folders'

export interface FolderImpact {
  documents: number
  folders: number
  projectChanges: { from: string | null, to: string | null, count: number }[]
}

export function useFolders() {
  const create = (path: string) =>
    ofetch<FolderDTO>('/api/folders', { method: 'POST', body: { path } })
  const patch = (id: string, body: { path?: string, color?: string | null }) =>
    ofetch<{ ok: true }>(`/api/folders/${id}`, { method: 'PATCH', body })
  const remove = (id: string) =>
    ofetch<{ documents: number, folders: number }>(`/api/folders/${id}`, { method: 'DELETE' })
  const impact = (id: string, to?: string) =>
    ofetch<FolderImpact>(`/api/folders/${id}/impact`, { query: to ? { to } : undefined })

  return { create, patch, remove, impact }
}
```

- [ ] **Step 2: Build the picker**

The swatch grid uses `FOLDER_PALETTE`, plus an explicit **Inherit** option that sends `color: null`. When `source` is `'inherited'` or `'project'`, show the hint that tells the user why a colour is already showing:

```vue
<p v-if="source && source !== 'own'" class="text-xs text-dimmed">
  Currently inheriting {{ source === 'project' ? 'this project’s colour' : 'the parent folder’s colour' }}.
</p>
```

Each swatch is a `UButton` with `:style="{ backgroundColor: hex }"` and an `aria-label` of the hex value so the browser test can select it.

- [ ] **Step 3: Verify colour and inheritance in the browser**

```bash
playwright-cli goto "http://localhost:3000/documents"
# right-click a folder → Colour → pick a swatch by its aria-label
playwright-cli eval "async () => {
  const t = await fetch('/api/documents/tree').then(r => r.json());
  const walk = (ns) => ns.flatMap(n => [n, ...(n.children ? walk(n.children) : [])]);
  return walk(t).filter(n => n.type === 'folder' && n.color)
    .map(n => ({ path: n.path, color: n.color, source: n.colorSource }));
}"
```

Expected: the folder you coloured reports `colorSource: 'own'`, and its child folders report the same colour with `colorSource: 'inherited'`.

- [ ] **Step 4: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/FolderColorPicker.vue app/composables/useFolders.ts app/components/documents/Tree.vue
git commit -m "feat(documents): assign colours to folders, inherited down the tree"
```

---

### Task 12: Folder create / rename / move / delete in the UI

**Files:**
- Create: `app/components/documents/FolderDeleteModal.vue`
- Modify: `app/components/documents/RenameModal.vue`, `MoveModal.vue` (accept folders, not just files)
- Modify: `app/composables/useDocumentTree.ts`

**Interfaces:**
- Consumes: `useFolders()` (Task 11).
- Produces: `FolderDeleteModal` props `{ open, folder: { id, path, label } | null }`, emits `{ 'update:open', deleted }`.

- [ ] **Step 1: Make Rename and Move folder-aware**

Both modals take a `kind: 'file' | 'folder'`. For a folder they call `patch(id, { path })` from `useFolders`; for a file they keep calling the document endpoints. Before submitting a folder **move**, fetch `impact(id, destination)` and, when `projectChanges` is non-empty, render the warning inline in the modal:

```vue
<UAlert
  v-if="impact?.projectChanges.length"
  color="warning"
  icon="i-lucide-triangle-alert"
  title="This changes project membership"
>
  <template #description>
    <ul class="text-xs space-y-0.5">
      <li v-for="c in impact.projectChanges" :key="`${c.from}-${c.to}`">
        {{ c.count }} document{{ c.count === 1 ? '' : 's' }}:
        {{ c.from ?? 'no project' }} → {{ c.to ?? 'no project' }}
      </li>
    </ul>
  </template>
</UAlert>
```

- [ ] **Step 2: Build the delete confirm**

`FolderDeleteModal` fetches `impact(id)` when it opens and states the exact counts, with the reassurance that documents are recoverable:

```vue
<p class="text-sm">
  Delete <strong class="font-mono">{{ folder?.path }}</strong>?
</p>
<p v-if="impact && impact.documents > 0" class="text-sm text-warning mt-2">
  {{ impact.documents }} document{{ impact.documents === 1 ? '' : 's' }}
  and {{ impact.folders }} sub-folder{{ impact.folders === 1 ? '' : 's' }} will be deleted.
  Documents are soft-deleted and can be restored.
</p>
<p v-else class="text-sm text-muted mt-2">This folder is empty.</p>
```

The confirm button label carries the count — `Delete 14 documents` — so the number is on the button the user actually presses.

- [ ] **Step 3: Verify the whole folder lifecycle in the browser**

```bash
# create an empty folder via the root context menu, then:
playwright-cli eval "async () => {
  const t = await fetch('/api/documents/tree').then(r => r.json());
  return t.filter(n => n.type === 'folder').map(n => ({ path: n.path, kids: n.children?.length ?? 0 }));
}"
# create a doc in it, delete that doc, and confirm the folder is STILL in the tree
```

Expected: the empty folder appears, survives its only document being deleted, and disappears only when deleted explicitly — the third complaint, proven end to end.

- [ ] **Step 4: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/FolderDeleteModal.vue app/components/documents/RenameModal.vue \
        app/components/documents/MoveModal.vue app/composables/useDocumentTree.ts
git commit -m "feat(documents): create, rename, move and delete folders from the tree"
```

---

### Task 13: Drag with useSortable (files and folders)

**Files:**
- Modify: `app/components/documents/Tree.vue`

**Interfaces:**
- Consumes: `patch`/document `move` from earlier tasks.
- Produces: nothing new — this replaces the HTML5 handlers (`onDragStart`, `onFolderDragOver`, `onFolderDragLeave`, `onFolderDrop`, `draggedFile`, `dropTargetPath`), which are all deleted.

**Read before starting:** `app/pages/tasks.vue:60-150` and `app/components/settings/AssignmentChain.vue:9-40`. They contain the canonical write-up of the snap-back trap and the cross-list splice pattern this task needs. Do not re-derive it.

- [ ] **Step 1: Delete the HTML5 implementation**

Remove the six drag functions and two refs listed above, plus the `draggable`, `@dragstart`, `@dragend`, `@dragover`, `@dragleave` and `@drop` attributes from the template.

- [ ] **Step 2: Wire one sortable per folder, all in one group**

Each folder's children list gets its own `useSortable` bound to its own array, all with `group: 'documents'` so items drag between folders. Persistence is driven by a **deep watch on the bound list, never from `onEnd`** — reading list state inside `onEnd` races the splice and persists the pre-drop order, which is exactly the "rows snap back" bug already recorded in the `usesortable-onend-snapback` memory. `onEnd` is used only to read stable DOM attributes (`evt.item.dataset.path`, `evt.to.dataset.folderPath`) and to perform the cross-list splice that vueuse does not wire for you.

Configure `Sortable` with `fallbackOnBody: true`, `invertSwap: true`, and `emptyInsertThreshold: 8` so dropping onto a folder with no children works at all.

- [ ] **Step 3: Add hover-to-expand and the root drop target**

A collapsed folder expands after the pointer rests on it for 600ms during a drag (`onMove` starts the timer, `onEnd`/leave clears it). The tree's scroll container is itself a sortable list with `folderPath="/"` so a document can be dropped at the root.

- [ ] **Step 4: Persist the move**

The deep watch resolves what moved to a destination path and calls the document `move` for a file, or `patch(id, { path })` for a folder. A folder move first fetches `impact` and, when `projectChanges` is non-empty, opens the same confirm the Move modal uses rather than performing it silently — a drag must not be able to re-associate 14 documents with no dialog.

- [ ] **Step 5: Verify with real mouse events**

SortableJS ignores a single synthetic jump. Step the pointer with real delays (this is in the browser-testing skill):

```bash
playwright-cli mousemove <sx> <sy>; sleep 0.2
playwright-cli mousedown; sleep 0.3
playwright-cli mousemove <x1> <y1>; sleep 0.15   # 4-6 intermediate points
playwright-cli mousemove <dx> <dy>; sleep 0.4
playwright-cli mouseup
playwright-cli eval "async () => (await fetch('/api/documents/tree').then(r=>r.json()))"
```

Verify the DOM order **and** the persisted tree — then reload the page and confirm it stuck. Test all four: file→folder, folder→folder, file→root, and a cross-project folder move showing the warning.

- [ ] **Step 6: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/Tree.vue
git commit -m "feat(documents): useSortable drag for files and folders"
```

---

## Phase 4 — The UX pass

### Task 14: Inspector panel, three-pane layout

**Files:**
- Create: `app/components/documents/Inspector.vue`
- Modify: `app/components/documents/Editor.vue` (remove the metadata `<details>` block and the meta* state)
- Modify: `app/pages/documents.vue`

**Interfaces:**
- Produces: `Inspector` props `{ documentId: string | null }`. It owns the metadata fields and the 800ms `scheduleMetaSave` debounce moved out of `Editor.vue` verbatim, including the `metaDirty` guard that stops an SSE refresh clobbering a field mid-edit.

- [ ] **Step 1: Move the metadata block**

Move `metaPath`, `metaTitle`, `metaProject`, `metaDomain`, `metaType`, `metaTags`, `metaSaveTimer`, `metaDirty`, `saveMetadata` and `scheduleMetaSave` from `Editor.vue` into `Inspector.vue`, along with the `<details>` markup — which becomes the panel body, no longer an accordion. Keep the comment explaining why `saveMetadata` takes an explicit `id`; that reasoning (a document switch fires it while `props.documentId` already points at the incoming document) still applies.

`Editor.vue`'s live-detail watcher keeps syncing content; the metadata half of that watcher moves to `Inspector.vue` with its `metaDirty` guard intact.

- [ ] **Step 2: Add the third panel**

```vue
<UDashboardPanel
  id="documents-inspector"
  collapsible
  resizable
  :default-size="20"
  :min-size="14"
  :max-size="32"
  class="hidden lg:flex"
>
  <template #header>
    <UDashboardNavbar>
      <template #title>
        <span class="text-sm font-medium">Inspector</span>
      </template>
    </UDashboardNavbar>
  </template>
  <template #body>
    <DocumentsInspector :document-id="selectedId" />
  </template>
</UDashboardPanel>
```

Persist collapse state in a `mm.documents.inspector` cookie, matching how `mm.documents.viewMode` and `mm.documents.expanded` are already declared.

- [ ] **Step 3: Verify metadata editing still saves**

```bash
playwright-cli eval "async () => {
  const t = await fetch('/api/documents/tree').then(r => r.json());
  return t;
}"
# edit the Title field in the inspector, wait >800ms, then re-read the document
playwright-cli eval "async () => (await fetch('/api/documents/<id>').then(r=>r.json())).title"
```

Expected: the edited title persists — the debounce moved without losing its behaviour.

- [ ] **Step 4: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/Inspector.vue app/components/documents/Editor.vue app/pages/documents.vue
git commit -m "feat(documents): metadata moves into a collapsible inspector panel"
```

---

### Task 15: Optimistic mutations

**Files:**
- Modify: `app/composables/useFolders.ts`, `app/composables/useDocumentTree.ts`
- Modify: `app/components/documents/Tree.vue`

- [ ] **Step 1: Replace refetch-after-mutate with optimistic cache writes**

Every action currently ends in `emit('refresh')` → a full `refetchTree()`. Convert move, rename, colour and delete to `useMutation` with `onMutate` writing the expected tree into `['document', 'list']`, `onError` restoring the snapshot, and `onSettled` invalidating. The SSE `folder`/`document` events already invalidate the same key, so the server remains the final word.

- [ ] **Step 2: Verify a failed mutation rolls back**

Force a collision (rename a file to a name that already exists) and confirm the row returns to its original position and an error toast appears — the optimistic write must not survive a 409.

- [ ] **Step 3: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/composables/useFolders.ts app/composables/useDocumentTree.ts app/components/documents/Tree.vue
git commit -m "perf(documents): optimistic tree mutations instead of full refetch"
```

---

### Task 16: Loading states

**Files:**
- Modify: `app/components/documents/Editor.vue`, `app/components/documents/Inspector.vue`, `app/components/documents/Tree.vue`

- [ ] **Step 1: Stop blanking the editor on document switch**

Replace the centered spinner (`Editor.vue:340`) with: keep the outgoing document rendered, apply `opacity-60 pointer-events-none transition-opacity` while loading, and show a slim `UProgress` bar under the toolbar. Only a cold load with no previous document shows a skeleton.

- [ ] **Step 2: Skeleton the inspector and keep the tree's**

`Inspector.vue` renders `USkeleton` rows at the same heights as its fields while the detail query is pending.

- [ ] **Step 3: Verify with a throttled network**

```bash
playwright-cli eval "() => performance.now()"
# switch documents and screenshot mid-load
playwright-cli screenshot --filename=/tmp/doc-switch.png
```

Expected: the previous document stays visible and dimmed; no blank pane at any point. Read the screenshot to confirm.

- [ ] **Step 4: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/Editor.vue app/components/documents/Inspector.vue app/components/documents/Tree.vue
git commit -m "feat(documents): loading states that never blank the editor"
```

---

### Task 17: Feel — breadcrumb, keyboard, empty states, toast discipline

**Files:**
- Modify: `app/components/documents/Editor.vue`, `Tree.vue`, `TreeRow.vue`, `app/composables/useDocumentTree.ts`

- [ ] **Step 1: Breadcrumb instead of the raw path**

Replace the `<span class="font-mono">{{ doc.path }}</span>` in the editor toolbar with `UBreadcrumb` built from the path segments; clicking a segment selects and expands that folder in the tree.

- [ ] **Step 2: Keyboard navigation**

Arrow up/down move selection, left/right collapse/expand a folder, Enter opens, F2 renames, Delete prompts delete. Add `focus-visible` rings to `TreeRow` so keyboard focus is visible.

- [ ] **Step 3: Empty states told apart**

An empty folder renders "This folder is empty" with a **New document here** action. A search with no hits renders "No documents match *<query>*" — distinct from the existing "No documents yet" cold state.

- [ ] **Step 4: Toast discipline**

Remove success toasts for actions with visible results (move, rename, colour, create). Keep every error toast. The folder-move toast keeps a success toast *because* it carries the **Undo** action, which calls `patch(id, { path: originalPath })`.

- [ ] **Step 5: Verify and screenshot the finished surface**

```bash
playwright-cli goto "http://localhost:3000/documents"
playwright-cli screenshot --filename=/tmp/documents-final.png
```

Read the screenshot; confirm the three panes, rails, breadcrumb and inspector all read as one surface.

- [ ] **Step 6: Verify the gates and commit**

```bash
pnpm typecheck && pnpm test
git add app/components/documents/ app/composables/useDocumentTree.ts
git commit -m "feat(documents): breadcrumb, keyboard nav, empty states, quieter toasts"
```

---

### Task 18: Full validation sweep, wiki, handover

**Files:**
- Modify: `docs/wiki/document-spine.md`
- Create: `docs/handovers/2026-08-25-documents-folders-ux.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`

- [ ] **Step 1: Run every gate fresh**

```bash
pkill -f "nuxt.mjs dev"          # never build while dev is running
docker start mymind-db
pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Record the exact numbers — the handover must quote measured results, not estimates.

- [ ] **Step 2: Browser-validate all six original complaints**

With dev running and logged in, prove each one and note the evidence:
1. Right-click a folder → full menu appears.
2. Drag a folder into another folder → it moves and survives reload.
3. Delete a folder's last document → the folder remains.
4. New-document modal offers a folder picker → no path typing.
5. Open an empty document → lands in Edit, not Preview.
6. Colour a folder → the rail changes and children inherit.

- [ ] **Step 3: Update the wiki in the same change**

Rewrite the tree/folder sections of `docs/wiki/document-spine.md`: the `folders` table, materialization, colour inheritance and precedence, the new `TreeNode` fields, the four endpoints, folder move/delete semantics including project re-association. Bump `updated:`. Then mirror to MyMind with `sync_document` using the file's `mymind_id`/`mymind_hash`, and write the returned hash back into the frontmatter.

- [ ] **Step 4: Write the handover**

`docs/handovers/2026-08-25-documents-folders-ux.md` with accurate frontmatter (`title`, `cycle: 59`, `date`, `status`, `branch`, `spec`, `plan`, `docs`, `tasks`), the measured gate numbers, what shipped, what was deferred, and the prod-deploy note that the migration backfills `folders` on first run.

- [ ] **Step 5: Reconcile the tracking docs**

Add the cycle-59 row to `docs/superpowers/plans/00-roadmap.md`; in `docs/BACKLOG.md`, strike the six complaints and note that `7be76abc`'s `USelectMenu` sweep is now complete. Close MyMind task `f7d4ed33` and open a follow-ups task for anything deferred.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs(cycle-59): wiki, handover, roadmap and backlog for documents folders"
```

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — data model → 3; materialization → 4; colour resolution → 5; folder operations → 6; endpoints + live reactivity → 7; layout → 14; component split → 8; context menus → 10; drag → 13; new-document modal → 2; empty-document view mode → 1; UX pass → 15/16/17; testing → distributed, with the sweep in 18; migration/rollout → 3 and 18. Out-of-scope items appear in no task, as intended.

**Placeholder scan:** No TBDs. Tasks 13 and 15–17 describe behaviour with configuration values and named references rather than full component listings — they modify large existing files whose current contents the implementer must read anyway, and each carries the exact file, the exact prior art to copy (`tasks.vue:60-150`), and a browser probe that fails if the behaviour is absent.

**Type consistency:** `TreeNode.color`/`colorSource` are introduced in Task 5 and consumed under those names in 9 and 11. `FolderDTO` (Task 3) is what `createFolder`/`setFolderColor` return (6) and what `useFolders.create` types (11). `FolderImpact` matches `folderImpact`'s return shape exactly. `ViewMode` replaces the local `Mode` alias in Task 1 and is not referenced elsewhere. `ensureFolders(docPath, tx?)` is called with a transaction only inside `moveFolder`, matching its signature.
