---
title: Document Spine
status: shipped
cycle: 59
updated: 2026-08-26
mymind_id: 541b04de-a9f9-4809-8001-50082fdafaa1
mymind_hash: c4d73c2579200371a2beac8dcdbfabbad900b7ab03bb8da63e3d4ef5e4c879fb
---

# Document Spine

The shared content core every feature is a view over: documents stored in Postgres with a hybrid path-tree + frontmatter model, browsed/edited in a split file-tree/editor UI, keyword-searchable, and publicly shareable.

## Data model — `documents` (`server/db/schema/documents.ts`)
`id` uuid PK · `path` text (canonical tree location, e.g. `/input/x.md`; unique where `deleted_at is null`) · `title` · `content` · `language` (from `getLanguageFromPath`) · `frontmatter` jsonb · **promoted queryable columns** `project` text (denormalized slug) / `project_id` uuid FK → `projects.id` (nullable, indexed; migration 0021) / `domain` / `type` / `tags` text[] / `topic` ltree · `content_hash` · `is_public` + `public_slug` (unique) · `embedding` halfvec(2560) — **vestigial, see correction below** · `created_at` / `updated_at` / `deleted_at` (soft delete) · `triaged_at` (cycle 57, capture triage's idempotency claim — see [triage.md](triage.md)).
Indexes: partial unique on `path`, unique `public_slug`, GIN on `tags`, btree `project`, btree `project_id`, GIN trigram on `title` and `content`, GiST on `topic`, btree `triaged_at`.

> **Correction (2026-08-16, cycle 57) — `documents.embedding` is NOT the document vector; it
> has never been written to.** This page previously said the column went "NULL until cycle 2"
> and described it as the vector this table's rows carry. Both were wrong. The column's own
> schema comment has read `// schema only in cycle 1; stays null` since cycle 1
> (`server/db/schema/documents.ts:28`), no writer in this codebase has ever populated it, and a
> live count on this dev box shows only a handful of legacy rows non-null out of thousands —
> noise, not signal. **The real per-document vector lane lives in `chunks`**
> (`sourceType = 'document'`, cycle 31's chunking work), joined back to `documents` by
> `sourceId` — see `searchDocIds`'s vector lane in `server/services/documents.ts` and
> `resolveAppendTarget` in `server/services/triage.ts`, which copies that exact join rather
> than querying `documents.embedding`. This mistake was not cosmetic: cycle 57's own
> implementation plan sketched a resolver against `documents.embedding` on the strength of this
> page's old wording, which would have compiled, run, and silently degraded every append-target
> resolution forever with no test catching it — caught only because Task 10's implementer
> checked the live column instead of trusting the wiki. The `embedding` column itself stays in
> the schema (untouched, still declared, still never written) — this note is the only change.

**Project association (cycle 26):** a doc is associated with project X **iff** its `path` is under `/projects/<X-slug>/` (lowercase). The `project` slug and `project_id` are derived from the final path on every write — the path is the single source of truth. Three triggers: manual move into/out of `/projects/<slug>/`; setting `project=X` on a doc (which relocates it to `/projects/X/<basename>`); or the `/input` enrichment classifying a doc into a project (proposes a new path via the `review_queue → approve` flow). See [projects.md](projects.md) for full detail.

See [projects.md](projects.md) for the canonical `projects` table schema (git-keyed, full URL/alias/local-paths model).

## Data model — `folders` (`server/db/schema/folders.ts`, cycle 59)
Folders used to be nothing but a shared `documents.path` prefix — no row, no id, no properties,
and gone the instant the last document under them left. Cycle 59 gave them a registry: `id` uuid
PK · `path` text, absolute and unique, no trailing slash, the root is never a row (`folders_path_uidx`)
· `color` text, nullable hex from `FOLDER_PALETTE` (`shared/types/folders.ts` — the same 14-hue list
`projects.color` draws from) or `null` to inherit · `created_at` / `updated_at`. No `deleted_at` — a
folder row is metadata, not content; its documents carry their own soft delete.

A **CHECK constraint** (`folders_path_format_check`) enforces `path ~ '^/' AND path !~ '/$' AND
path !~ '//'` at the database, not just in application code — the same call `task_columns_kind_check`
made (cycle 58): several writers touch this table (`ensureFolders`, `createFolder`, `moveFolder`)
and trusting every one of them to normalize independently is how `/projects//mymind` or
`/projects/` slips in and corrupts the tree everywhere it's read.

**Materialization.** A row is created (`ensureFolders(docPath)`, `server/services/folders.ts`) the
first time any writer puts a document under that path — called from `createDoc`/`updateDoc` in
`server/services/documents.ts` (the service, not the HTTP route), which is the one choke point
every writer shares: the documents UI, MCP (`save_document`/`sync_document`/`move_document`/
`edit_document`), capture triage's `/input` sweep, and ShareX transcriptions all funnel through
those two functions. Idempotent (`onConflictDoNothing`), so a race between two writers just leaves
one winner. `moveFolder` and `createFolder` also insert ancestor rows directly so a folder created
or moved several levels deep is reachable from the root.

**Colour precedence** (`applyFolderColors` in `server/services/tree.ts`, resolved server-side, top-down):
own colour, else — if the folder IS a project root (`/projects/<slug>` exactly two levels deep) —
the owning project's colour, else whatever cascaded from an ancestor, else nothing. An override at
any level cascades to everything below it; `colorSource` (`'own' | 'project' | 'inherited'`, `shared/types/folders.ts`)
tells the picker where the rendered colour came from so it can show an "inheriting…" hint instead
of a false positive.

**Folder operations** (`server/services/folders.ts`) — `createFolder`, `moveFolder`, `deleteFolder`,
`setFolderColor`, `folderImpact`, all path-prefix-safe:
- Every prefix predicate goes through `escapeLikeLiteral` before hitting `LIKE '<path>/%' ESCAPE E'\\'` —
  `_` and `%` are SQL LIKE wildcards and both occur naturally in real paths (`/projects/my_project`);
  an unescaped predicate would sweep sibling rows into a move or delete that only differ at that
  position.
- `moveFolder(id, toPath)` is a rename-or-move (a rename is a move within the same parent), atomic
  in one transaction: every descendant document's `path` is rewritten by prefix, and because
  `documents.path` is the single source of truth for project membership (cycle 26), **documents
  crossing a `/projects/<slug>/` boundary are re-associated to their new project as part of the
  same write** (`project`/`projectId` recomputed per destination directory). Collisions (a document
  or folder already at the destination) are pre-checked and reported as `{ reason: 'collision',
  conflict: '<path>' }` before any write; moving a folder into itself is `{ reason: 'invalid' }`;
  an unknown id is `{ reason: 'not-found' }`. A residual race is documented, not closed: a writer
  that commits between the transaction's snapshot and its commit can still strand a document at
  the old prefix — accepted for a single-user app because the tree is self-healing (`buildTree`
  unions path-derived folders with registry rows, so a stranded document still renders its own
  folder from its own path, and the next write under it re-materializes the row).
- `deleteFolder(id)` soft-deletes every descendant document (restorable) and hard-deletes every
  descendant folder row plus the folder itself (`foldersDeleted` — metadata, not content, so no
  restore path). `foldersDeleted === 0` is the unambiguous "no such folder" signal, since even an
  empty folder deletes its own row and reports 1.
- `folderImpact(id, toPath?)` is the read-only preview behind both confirm dialogs — the exact
  same predicates a delete or move will use, so the number a user approves can't drift from what
  actually happens. Returns `foldersInside` (descendants only — **deliberately distinct from**
  `deleteFolder`'s `foldersDeleted`, which also counts the folder itself; the two names differ on
  purpose so a confirm dialog and its toast can't be wired to the same field with an off-by-one).
  With `toPath`, also returns `projectChanges` — which documents would switch project and to what.

## The seam
All document access goes through `server/services/documents.ts`: `listTree`, `getDoc`, `createDoc`, `updateDoc`, `moveDoc`, `deleteDoc` (soft), `searchDocs`, `setPublic`, `getByPublicSlug`. Nothing else touches the `documents` table. Folder operations go through `server/services/folders.ts` exclusively — see above.

**Tree shaping** — `server/services/tree.ts` `buildTree(docs, folderRows)`: the tree is the union
of path-derived folders (so a folder with documents always renders, registry row or not) and
`folders` registry rows (so an *empty* folder — no documents at all — still renders, which is the
whole reason the table exists: the old prefix-only tree made an emptied folder vanish). A registry
row's real `id` is attached to whichever node its path resolves to. `TreeNode` (returned to the
client, also consumed by the MCP tree tools) carries: `name`, `path`, `type: 'file' | 'folder'`,
`id?` (a **document id for files**, the **`folders` registry id for folders** — not the same kind
of thing, and not the same as a folder's tree key, which is its `path`), `title?`, `children?`,
and — folders only — `color?` / `colorSource?` after `applyFolderColors` has run.

## API (`server/api/documents/*`, `server/api/folders/*`, `server/api/share/*`)
Documents: `GET tree` · `POST /` (create) · `GET|PUT|DELETE [id]` · `POST [id]/move` · `POST [id]/share` · `GET search?q=` · public `GET /api/share/[slug]` (auth-exempt, read-only). Client wrapper: `app/composables/useDocuments.ts`.

**Folders (cycle 59):** `POST /api/folders` (create, body `{ path }`) · `PATCH /api/folders/[id]`
(body `{ path?, color? }` — at least one required, a `{}` body is rejected by a zod `.refine`
before either service call runs, so a vacuous PATCH can never 200 and fire a live event for
nothing) · `DELETE /api/folders/[id]` · `GET /api/folders/[id]/impact?to=<path>` (preview, read-only).
Every mutating route maps a service-level `FolderOpFailure.reason` onto a status code through one
shared function (`server/utils/folder-http.ts` `folderOpError`, `never`-guarded so a fourth reason
added to the service is a compile error here, not a silent 409): `'not-found'` → 404, `'invalid'`
→ 400, `'collision'` → 409 (`"Path already taken: <path>"`). Every successful mutation publishes
`{ resource: 'folder', action, id }` (`server/utils/live-bus.ts`); the client dispatch
(`app/utils/live-dispatch.ts`) invalidates `['document','list']` on it — a folder mutation rewrites
document paths, so the tree query itself has to refetch, not just a folder-scoped cache entry.
Client wrapper: `app/composables/useFolders.ts` (`create`/`patch`/`remove`/`impact`).

**Known asymmetry:** a *file*-rename path collision surfaces as a generic 500, where a folder
collision returns a clean 409 naming the conflicting path. Pre-existing on the file side; not
touched in cycle 59.

## UI
`app/pages/documents.vue` — three `UDashboardPanel`s: left `Tree.vue` (browse/select, search box)
· centre `Editor.vue` · right, collapsible, `Inspector.vue` (metadata form — title/project/domain/
type/tags, share toggle). The metadata form moved out of the editor and into its own panel in
cycle 59 (previously inline below the editor). Editor: CodeMirror (`CodeEditor.client.vue`) + MDC
preview (`MdView.vue`), `edit|preview|split` toggle (cookie-persisted), ~1.5s debounced autosave.
**An empty document always opens in Edit mode** — a truly empty preview render is indistinguishable
from a document that failed to load, so `resolveViewMode` (`app/lib/documents/view-mode.ts`) forces
Edit whenever the stored mode would otherwise show a blank Preview pane.

**Loading states never blank the editor** (cycle 59): switching documents shows a skeleton over the
*previous* document's content rather than an empty pane, and the CodeMirror instance is made
`read-only` while a switch is in flight — both to stop keystrokes and pasted images from landing on
the outgoing document and being autosaved onto whatever id the switch resolves to next (see the
metadata-timer bug below).

**The tree is a hand-rolled recursive renderer (`Tree.vue`), not Nuxt UI's `UTree`** (cycle 59). Reka-ui's
`UTree`/`TreeRoot` could not host the drag interaction this cycle needed — it renders no `<ul>` for
an empty folder, exposes no path-keyed DOM hooks, and binds no mutable array `useSortable` could
splice — so the tree renders itself via `createReusableTemplate` recursion instead. Rows keep a
real `role="treeitem"`, `tabindex` and focus ring, but reka-ui's roving tabindex, typeahead, and
arrow-key navigation are gone with the library and have been **hand-rebuilt** in
`app/lib/documents/tree-keyboard.ts` (`folderChainOf`, `arrowLeftAction`/`arrowRightAction`,
`neighborPathFor`, `nextVisiblePath`, `typeaheadMatch`) with no library behind them going forward —
a future reka-ui upgrade will not carry any of this along for free. `aria-level`/`aria-setsize`/
`aria-posinset` are set by hand to compensate.

**Autosave semantics** (`app/lib/documents/autosave.ts` + `Editor.vue`). The pending edit is held as an `(id, content)` pair, not as a timer over "whatever document is selected now". Three rules follow from that:
- **Leaving flushes, never discards.** Switching documents or unmounting the editor writes the pending edit rather than cancelling its timer. Both paths capture the *outgoing* document's id/values synchronously before the incoming document loads, so a late save can't land on the wrong document.
- **Unwritten text is always visible.** The status badge reads `unsaved` (amber) whenever the buffer differs from what was last written, alongside `saving…`/`saved`/`save failed`. A `beforeunload` handler warns on tab close/reload while content or metadata is dirty — the one exit a flush can't cover.
- **Only what was actually written is marked saved.** The save marks the body it sent, not the current buffer, so text typed while a request is in flight stays dirty and gets its own save.

Metadata (800ms debounce, `Inspector.vue`) follows the same explicit-id rule and is flushed on the
same paths. **A pre-existing timer leak here was found and fixed in cycle 59:** the document-switch
watcher never cancelled a pending metadata-save timer, so it could fire ~800ms after a switch and
write the *outgoing* document's stale edit onto the *incoming* document — reachable whenever the
incoming document's own fetch took longer than 800ms, so the skeleton branch (above) was mid-flight
when the stale timer fired. Predates cycle 59; caught only because this cycle deliberately
constructed the switch-during-debounce hazard rather than assuming it was safe. Public read-only page: `app/pages/share/[slug].vue` (`layout: false`).

## Search
**Hybrid (cycle 2, vector lane moved in cycle 31):** `searchDocs`/`searchDocIds` fuse a trigram
lane (`ilike` + `similarity()` directly on `documents.title`/`content`) and a vector cosine lane
via RRF, falling back to trigram-only if embeddings are unavailable. **The vector lane queries
`chunks.embedding` joined to `documents` on `sourceId`** (`chunks.sourceType = 'document'`), not
`documents.embedding` — see the correction in the data model section above. See
[enrichment.md](enrichment.md) for the embedding pipeline that actually populates `chunks`.

## Power-editor (cycle 9; tree rebuilt cycle 59)
- **Tree**: right-click `UContextMenu`, different per row type. **Files** — Open/Rename/Move/
  Duplicate/Copy path/Share/Delete. **Folders** — New document here/New subfolder/Rename/Move/
  Colour/Copy path/Collapse all/Delete (previously did nothing at all — the first of the six
  complaints this cycle closed). Colour opens a 14-swatch picker (`FolderColorPicker.vue`) plus
  "Inherit" to clear an override back to the parent/project colour.
  **Drag** (`@vueuse/integrations/useSortable`, replacing native HTML5 DnD): both files AND
  folders drag from a hover-revealed `.drag-handle` grip (row-wide drag would fight click-to-select
  and text selection). Dropping onto a folder's own row — not just into its already-expanded child
  list — files the drop into that folder, matching Explorer/Finder. A folder drag that crosses a
  `/projects/<slug>/` boundary (and a multi-file drag whose destination project differs) routes
  through `MoveModal`'s impact preview and requires acknowledgement before it writes — silently
  re-associating a document's project on a drag would be worse than asking. **Folders persist with
  no documents at all** — deleting a folder's last document leaves the empty folder in the tree
  (the second and third complaints this cycle closed): the registry row survives independently of
  content.
  Mutations are optimistic (`useOptimisticTreeMutation()`, cycle 59) for rename/move/colour/delete/
  create — the tree updates immediately and rolls back on failure, generation-stamped so a slower
  failing mutation can't clobber a newer one's write; drag itself was left alone (already
  low-latency via `useSortable`'s own DOM splice).
  Copy-public-link (full URL).
- **Markdown toolbar** (`MarkdownToolbar.vue`, `.md` + edit/split only): bold/italic/code/H1–3/list/numbered/checkbox/quote/link/codeblock via pure `shared/utils/md-transforms.ts`, applied through `CodeEditor.client.vue`'s exposed `getSelection`/`applyTransform`/`insertText`. Insert menu for MDC block components.
- **Custom MDC components** (`app/components/content/`): `Note`, `Collapsible` (and `Callout` — though `::callout` currently resolves to MDC's built-in themed prose-callout; see handover).
- **Inline image paste/drop** in the markdown editor → public upload (`/api/upload?public=1`) → `![](url)` at the cursor.
- **Last-open doc** persisted via `useCookie('mm.lastDoc')` (`?doc=` query wins).
- **New-document modal** (`NewDocumentModal.vue`) offers a `USelectMenu` folder picker over every
  known folder path (registry + path-derived) instead of a hand-typed path (the fourth complaint
  this cycle closed) — a separate Filename field composes with it into the final path.
- **Cross-tab live reactivity**: every folder mutation (`create`/`move`/`color`/`delete`) publishes
  a `folder` SSE event (`/api/events`) that invalidates the tree query in every other open tab —
  verified end to end in cycle 59 with two real browser tabs (one mutates, the other updates with
  no manual refresh); this had been wired and payload-verified but never actually observed cross-tab
  before this cycle's validation sweep.
- **Both dashboard panels' `collapsible` attribute is inert.** `UDashboardPanel` (Nuxt UI 4.8.1) has
  no such prop — it lives on `UDashboardSidebar` instead — so neither the tree panel's nor (before
  cycle 59 hand-rolled one) the inspector's collapse ever came from that attribute. The inspector's
  collapse is a hand-rolled cookie-driven icon-strip swap (cycle 59); the tree panel's `collapsible`
  is simply dead markup, pre-existing and untouched.

## Known gaps (see handover)
`useDocuments` uses raw ofetch. (Deep-link `?doc=<id>` **does** auto-load — `documents.vue` watches `route.query.doc` and selects it; verified in-browser 2026-08-16. The former "doesn't auto-load" note here was stale.) Tree drag-drop shipped (cycle 9, folder drag + drop-onto-row + optimistic mutations added cycle 59, see Power-editor above). Project association doc-tree/search `?project=` filtering deferred (dashboard uses flat `listDocs`); per-doc deep-link route (`?doc=<id>`) from the project Documents tab is deferred (rows link to `/documents`).

**Cycle 59 residuals** (see the [handover](../handovers/2026-08-25-documents-folders-ux.md) for full detail — deliberately not re-litigated here): the tree's hand-rolled roving-tabindex/typeahead nav has no library behind it going forward; a *file*-rename path collision returns a generic 500 where a folder collision returns a clean 409; `moveFolder` has a documented (accepted, self-healing) race window between its snapshot and commit; and the migration's 0037 backfill was verified against a local corpus of only 8 documents — production's correctness rests on reading the SQL.
