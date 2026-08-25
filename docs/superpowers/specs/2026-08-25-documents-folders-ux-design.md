---
title: Documents — real folders, colour, and a UX pass on the whole surface
cycle: 59
date: 2026-08-25
mymind_id: e86c4eea-131e-4332-9f5f-805e505be47f
mymind_hash: 709d12e402733e46e6079f39ebe0776305481be39ed1ee9e7a53b83148bc86aa
status: spec — approved in brainstorm, not yet planned
related:
  - ../../wiki/document-spine.md (the document model and tree this rewrites)
  - ../../wiki/projects.md (cycle 26 — the `/projects/<slug>/` path invariant a folder move must respect)
  - ../../wiki/mcp.md (save_document / sync_document / move_document — writers that must materialize folders)
  - ../specs/2026-06-12-live-reactivity-design.md (the publishChange contract every mutation rides)
  - ../../handovers/2026-08-18-dynamic-board-columns.md (cycle 58 — most recent; colour + useSortable precedent)
  - ../../explorations/2026-08-15-ux-audit-product.md (the audit that flagged this surface)
closes:
  - "Six documents-page complaints raised 2026-08-25 (folder context menu, folder drag, vanishing folders, path typing on New, preview-on-empty, folder colour)"
---

# Documents — real folders, colour, and a UX pass (cycle 59)

## Why

`server/services/tree.ts` builds the entire document tree by splitting `documents.path` strings. A
folder is a prefix shared by one or more documents — nothing more. It has no row, no id, and no
properties, and it ceases to exist the moment its last document leaves.

That single fact is the root of most of what's wrong with the page:

- **Folders vanish.** Delete the last document in `/projects/old/` and the folder is gone, because it
  was never anything but those documents' shared prefix.
- **Folders can't be coloured.** There is nowhere to put a colour. Projects have had one since cycle
  25 and board columns since cycle 58; the documents tree is the odd surface out.
- **Folders can't be right-clicked or dragged.** `Tree.vue:426` puts the context menu behind
  `v-if="item.nodeType === 'file'"`, and only files carry `draggable`. Even if they were wired up,
  there would be little for the menu to act on: renaming or moving a folder means rewriting every
  descendant path, which no endpoint does today.

Two more complaints are unrelated to folders and simply overdue: the New-document modal makes you
type a full path by hand (`documents.vue:38`) even though the Move modal three components away
already renders a folder picker, and an empty document opens in Preview mode — a blank pane — because
the view-mode cookie is restored without regard to whether there is anything to preview.

Underneath all six is the thing the 2026-08-15 UX audit kept circling: this surface has accreted
without a pass for feel. Every mutation is a full `refetchTree()` round-trip, the editor blanks to a
spinner on every document switch, drag-and-drop is raw HTML5 (the last surface in the app not on
`useSortable`), and metadata hides in a `<details>` accordion at the bottom of the editor.

## What this builds

Folders become real, minimally: a registry table that records only the folders you have *touched* —
created empty, renamed, moved, or coloured — unioned with the folders still derived from document
paths. `documents.path` stays the single source of truth, so nothing downstream changes: MCP tools,
the `/projects/<slug>/` invariant, capture-triage routing, share links and search all keep working
untouched.

On top of that: folder context menus, folder drag, colour with inheritance, an inspector panel, and a
polish pass across loading, drag and toasts.

### Decisions locked in the brainstorm

| Decision | Choice |
|---|---|
| Folder model | Registry table; tree = derived-from-paths ∪ registry rows. Not a `folder_id` FK. |
| Empty folders | Persist. A row is materialized the first time a folder is seen, so implicit folders survive emptying too. |
| Folder move across projects | Cascades, and the confirm dialog states the project re-association explicitly. |
| Colour | Inherits from the project at `/projects/<slug>`, cascades to children, overridable at any level. |
| Folder delete with contents | Recursive, with an exact count in the confirm. Documents are soft-deleted. |
| MCP | Auto-materialization only. No new folder tools this cycle. |
| Drag | `useSortable`, files and folders. No manual sort order — folders first, then alphabetical. |
| Layout | Three-pane: tree · editor · collapsible inspector. |

## Data model

```sql
create table folders (
  id         uuid primary key default gen_random_uuid(),
  path       text not null,              -- '/projects/mymind/wiki', no trailing slash
  color      text,                       -- null = inherit from parent, or from project at /projects/<slug>
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index folders_path_uidx on folders (path);
```

The root is not a row. There is no `deleted_at`: a registry row is metadata, not content, so deleting
it is immediate — the documents it contained carry their own soft delete.

`color` stores the same token vocabulary `projects.color` uses, so the two surfaces render the same
project in the same colour.

### Materialization

```
ensureFolders(path)  -- '/projects/mymind/wiki/auth.md'
  → derives '/projects', '/projects/mymind', '/projects/mymind/wiki'
  → insert … on conflict (path) do nothing
```

It hooks into exactly two functions in `server/services/documents.ts`: `createDoc` (:174) and
`updateDoc` (:190), which `moveDoc` (:262) already delegates to. Hooking the **service** rather than
the HTTP route is what makes this complete — every writer is covered by construction:

| Writer | Path |
|---|---|
| Documents UI | `POST /api/documents`, `POST /api/documents/[id]/move`, `PUT /api/documents/[id]` |
| MCP agents | `save_document`, `sync_document`, `move_document`, `edit_document` |
| Capture triage | the `/input/` sweep and its auto-apply relocations |
| ShareX / CleanShot | transcription documents written under `/input/` |

A backfill in the same migration derives rows from every existing live document path, so the registry
is complete from the moment it ships rather than filling in gradually.

### Colour resolution

Resolved server-side in `listTree()`, never in the client. The walk carries an inherited colour
top-down and seeds `/projects/<slug>` from `projects.color` when that folder's own `color` is null.
Every folder node in the tree DTO gains:

```ts
color: string | null
colorSource: 'own' | 'inherited' | 'project' | null
```

`colorSource` exists so the picker can say *"inheriting mymind's gold"* rather than showing an empty
swatch that looks like a bug. Setting a colour on a folder cascades to its descendants until one of
them sets its own.

## Folder operations

All three live in a new `server/services/folders.ts` and run in one transaction each.

**Move / rename** (they are the same operation — a rename is a move within the same parent):

1. Pre-check destination collisions against `documents_path_live_uidx` and return **409 naming the
   conflicting path**. The raw constraint error is unreadable and would surface as "Name collision?"
   the way the current drag handler already does.
2. Prefix-rewrite descendant folder rows and descendant document paths.
3. Re-run the existing `resolveDocProjectFromPath` (`documents.ts:70`) per moved document, so
   `project` / `project_id` follow the path invariant. **This is the re-association the confirm
   dialog warns about** — it is deliberate, not incidental.
4. Publish `document:updated` per document plus `folder:updated`.

**Delete:** soft-delete descendant documents, hard-delete descendant folder rows and self.

**Create:** insert one row. Creating `/a/b/c` materializes `/a` and `/a/b` too.

### Endpoints

| Route | Purpose |
|---|---|
| `POST /api/folders` | create an empty folder |
| `PATCH /api/folders/[id]` | rename, move, or set colour |
| `DELETE /api/folders/[id]` | recursive delete |
| `GET /api/folders/[id]/impact` | `{ documents, folders, projectChanges }` — powers both confirm dialogs |

No folder-list endpoint: `GET /api/documents/tree` already carries folders, and the New-document
picker reads the same query the tree does.

## Live reactivity

`'folder'` is added to `ResourceName` (`shared/types/live.ts:3`) and to the client dispatch registry
(`app/utils/live-dispatch.ts`). Per the live-data rule, omitting the second half is a type error, not
a silent staleness bug. Folder mutations publish `folder:*`; the document rows they rewrite publish
`document:updated` individually.

## UI

### Layout

`documents.vue` becomes three `UDashboardPanel`s — tree · editor · inspector. The inspector is
`collapsible`, remembers its state in a `mm.documents.inspector` cookie (matching the existing
`mm.documents.viewMode` and `mm.documents.expanded` cookies), starts collapsed to an icon, and hides
below `lg` as the tree already does.

### Component split

`Tree.vue` is 608 lines doing five jobs and `Editor.vue` is 596. Both are broken up as part of this
work — these are the files the cycle edits most, and leaving them monolithic makes every task in
phases 3 and 4 harder:

| New file | Responsibility |
|---|---|
| `Tree.vue` | rendering, selection, drag wiring |
| `TreeRow.vue` | one row: colour rail, icon, hover affordances, context menu |
| `useDocumentTree.ts` | rename / move / delete / colour / share / retriage actions |
| `RenameModal.vue`, `MoveModal.vue`, `FolderDeleteModal.vue`, `NewDocumentModal.vue`, `FolderColorPicker.vue` | one modal each, extracted from `Tree.vue` and `documents.vue` |
| `Inspector.vue` | metadata, absorbed from the bottom of `Editor.vue` |

`Editor.vue` is left holding content, toolbar and autosave — the autosave machinery extracted in
`4a3792f` (`app/lib/documents/autosave.ts`) is untouched by this cycle.

### Context menus

Three, where today there is one:

- **File** — Open · Rename · Move · Duplicate · Copy path · Share/copy link · Re-triage (`/input`
  only, preserving the existing rule) · Delete
- **Folder** — New document here · New subfolder · Rename · Move · Colour ▸ · Copy path · Collapse
  all · Delete
- **Empty space / root** — New document · New folder · Expand all · Collapse all

### Drag

`useSortable` over the nested tree, files and folders alike: insert-line indicator, cmd/shift
multi-select, hover-to-expand on collapsed folders, root as a valid drop target, and a drag ghost
that says "3 documents" when several are selected.

Two traps are called out as task notes rather than discovered during the build. First, the
`usesortable-onend-snapback` lesson: emit the move from a deep watch on the list, never from `onEnd`,
or rows snap back. Second, nested-list group configuration — this is the genuinely hard task of the
cycle and should not be bundled with anything else.

### New-document modal

A searchable `USelectMenu` of folders (pre-selected to the open folder, or the folder that was
right-clicked), a separate filename field, and a live preview of the resulting path. The Move modal's
plain `USelect` (`Tree.vue:580`) becomes a `USelectMenu` in the same pass, finishing what cycle 58's
task `7be76abc` started.

### Empty-document view mode

The guard at `Editor.vue:115` (which already forces `edit` for non-markdown) gains one rule: on load,
if the document's content is empty and the stored mode is `preview`, use `edit`. `split` is left
alone. The override is **per document and does not rewrite the cookie** — opening one empty note must
not permanently reset the global preference.

## UX pass

- **Optimistic mutations.** Every action today ends in `emit('refresh')` → a full `refetchTree()`
  round-trip, and that latency is most of what makes the page feel slow. Move, rename, colour and
  delete become optimistic vue-query updates on the tree key, rolled back on error.
- **Loading.** The tree has a skeleton; the editor blanks to a centered spinner on every document
  switch (`Editor.vue:340`). Instead: keep the outgoing document visible under a subtle loading
  state, and skeleton the inspector.
- **Feel.** Breadcrumb header in place of the raw path string, colour rails, one consistent row
  density, focus-visible rings, keyboard navigation in the tree (arrows, enter, F2 rename, delete),
  per-folder empty states, and "no documents" told apart from "no search results".
- **Toast discipline.** Successes you can watch happen go quiet. Errors keep their toast, and a
  folder move gets an **Undo** action, since a mis-drop there costs N path rewrites.

## Testing

**Unit** (colocated `*.test.ts`): `ensureFolders` prefix derivation; the colour-inheritance walk
including the project seed and override cascade; prefix rewrite and collision detection; the
empty-document preview rule.

**DB** (`pnpm test:db`): materialization through the real service on create and move — which is what
proves the MCP writers are covered, since the hook is in `updateDoc` and not in a route; cascading
move with project re-resolution across a `/projects/<slug>/` boundary; recursive delete; the backfill
migration against a seeded corpus.

**Browser** (`playwright-cli`, per the project rule — never the Playwright MCP): right-click a folder
and get a menu; drag a folder into another folder; delete a folder's last document and watch the
folder stay; colour a folder and see children inherit; create a document through the picker; open an
empty document and land in edit mode. Each proven with a controlled probe — stash the change, confirm
the probe fails, restore.

**Known gap:** CI has no Postgres (MyMind task `70bcc740`), so `test:db` runs locally only and is not
part of the deploy gate. The cycle does not close that gap; it is called out so the handover does not
claim coverage the pipeline does not have.

## Migration and rollout

One migration: create `folders`, backfill from existing live document paths. It runs on deploy like
every other migration. Reversal is dropping the table — no document row is altered by the migration
itself, which is what keeps this safe to ship.

## Out of scope

- Manual sort order (`sort_order` on folders or documents)
- MCP folder tools (`create_folder`, `move_folder`, `delete_folder`, colour)
- Reworking the page's own search box — that belongs to the sidebar-IA task (`4e087adb`)
- `/input` triage behaviour, including capture titling (task `562b77f5`)
- Folder colour on other surfaces (galaxy, projects dashboard)
- Anything multi-user

## Risks

1. **The cascading move.** An N-row path rewrite plus project re-association is the one operation
   here that can do real damage. Mitigated by a single transaction, the pre-flight collision check,
   the impact endpoint behind the confirm dialog, an Undo on the toast, and a dry-run against a
   prod-shaped corpus before the UI is wired to it.
2. **`useSortable` on a nested tree.** The hardest UI task, and the one with a known failure mode
   already recorded in memory. Isolated as its own task.
3. **Materialization coverage.** If a writer bypasses `createDoc`/`updateDoc`, its folders never
   materialize and the empty-folder guarantee quietly breaks. The DB test exists specifically to
   catch that.
4. **Prod backfill.** Runs on deploy against the real corpus. Reversible by dropping the table.
