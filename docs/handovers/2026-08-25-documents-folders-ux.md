---
title: Documents — real folders, colour, and a UX pass (cycle 59)
cycle: 59
date: 2026-08-25
status: >
  BUILT, NOT MERGED. All 18 tasks complete on `worktree-feat+documents-folders-ux`
  (subagent-driven, per-task two-verdict review, several multi-round fix loops). All six of the
  user's original complaints fixed and browser-verified with evidence; the previously-unproven
  cross-tab SSE refresh on folder mutations is now observed end to end. Gates measured fresh at
  HEAD for this handover: **typecheck 0 errors / test 1332 passed (166 files) / test:db 176
  passed (18 files) / build clean.** Not pushed, not merged into `master`, not deployed.
branch: worktree-feat+documents-folders-ux
spec: ../superpowers/specs/2026-08-25-documents-folders-ux-design.md
plan: ../superpowers/plans/2026-08-25-documents-folders-ux.md
docs:
  - ../wiki/document-spine.md (tree/folder sections fully rewritten — mirrored to MyMind at /projects/mymind/wiki/document-spine.md)
  - ../superpowers/plans/00-roadmap.md (cycle 59 row added)
  - ../BACKLOG.md (six complaints struck, cycle-58 USelectMenu sweep noted complete)
tasks:
  - f7d4ed33 (MyMind) — "Cycle 59 — Documents: real folders, colour, and a UX pass" — closed
  - ad0e0244 (MyMind) — "Cycle 59 follow-ups — documents folders UX (30 deferred items)" — opened
---

# Documents — real folders, colour, and a UX pass (cycle 59)

Folders in the document tree used to be nothing but a shared `documents.path` prefix — no row, no
id, no properties, gone the instant the last document under them left. This cycle gave folders a
real registry table, colour with top-down inheritance, full context menus, drag-and-drop for both
files and folders (replacing native HTML5 DnD with `useSortable`), a folder picker on document
creation, a guaranteed-non-blank empty-document view, and a UX pass over the rest of the documents
surface (three-pane layout with a collapsible inspector, optimistic mutations, loading states that
never blank the editor, keyboard navigation rebuilt after the tree stopped being `UTree`).

Full architecture — the `folders` table, the CHECK constraint, materialization, colour precedence,
the four endpoints and their `reason`→status mapping, move/delete semantics including project
re-association — is in [`../wiki/document-spine.md`](../wiki/document-spine.md); this document is
about how the cycle went, what was found, and what's still open.

## Read this first: the honest caveats

The controller's ledger (`docs/superpowers/sdd/2026-08-25-documents-folders-ux/progress.md`) is the
authoritative record of all 17 build tasks. These items must not be quietly dropped:

1. **The migration's backfill was verified against a local corpus of only 8 live documents / 4
   folders.** Production's corpus is orders of magnitude larger with deeper, messier paths. A
   review round did find and fix a real defect this small corpus could not surface (malformed
   folder paths from a document with an internal `//` in its path — R7 normalizes repeated
   slashes in the backfill rather than filtering those documents out), which is exactly why this
   caveat matters: the migration's correctness on production rests on reading the SQL
   (`0037_stormy_dust`), not on empirical proof at scale.
2. **`UTree` was replaced by a hand-rolled recursive renderer.** Reka-ui's `TreeRoot` could not
   host the drag interaction this cycle needed — it renders no `<ul>` for an empty folder, exposes
   no path-keyed DOM hooks, and binds no mutable array `useSortable` could splice. The tree now
   renders itself via `createReusableTemplate` recursion. This cost more than first estimated:
   beyond arrow-key navigation, the replacement also lost reka-ui's roving tabindex, typeahead,
   and several ARIA attributes (`aria-level`/`setsize`/`posinset`/`multiselectable`) — all since
   **hand-rebuilt** in `app/lib/documents/tree-keyboard.ts` with unit tests, but MyMind now
   maintains tree keyboard navigation itself, with no library behind it going forward. A future
   reka-ui upgrade will not carry any of this along for free.
3. **The tree panel's `collapsible` attribute has always been inert.** `UDashboardPanel` has no
   such prop in Nuxt UI 4.8.1 (it lives on `UDashboardSidebar` instead) — verified by reading the
   installed component source, not assumed. This means the document tree's collapse has never
   worked, in any cycle. Pre-existing, untouched here; the new inspector panel's collapse is a
   hand-rolled cookie-driven icon-strip swap because the same missing prop would have made it
   equally inert.
4. **A *file*-rename path collision returns a generic 500, where a folder collision returns a
   clean 409 naming the conflicting path.** Rollback works correctly either way (Task 15's
   optimistic mutations revert on either failure shape), but the error surfaced to the user is
   worse for files. Pre-existing asymmetry, surfaced (not introduced) by this cycle's optimistic
   rename work.
5. **A pre-existing metadata-save timer leak was found and fixed.** Editing a document's metadata
   then switching to another document within the 800ms debounce window could write the *outgoing*
   document's metadata onto the *incoming* one, if the incoming document's own fetch took longer
   than 800ms (the switch watcher never cancelled the pending metadata-save timer). This predates
   cycle 59 entirely — it surfaced only because Task 14's brief demanded the switch-during-debounce
   hazard be deliberately constructed rather than assumed safe. Fixed; has no automated regression
   test yet (tracked in the follow-ups task, item 19).
6. **The "No documents match" empty state may be practically unreachable via real search on this
   dev box.** The dev DB's semantic search lane returns near-universal hits for nonsense queries
   (a pre-existing `cosineFloor`/embedding relevance quirk, not introduced here), so Task 17
   verified the empty-state copy by stubbing `fetch` rather than by finding a query with zero real
   hits. The reviewer accepted the stub as isolating the UI from a known, pre-existing search-
   relevance issue rather than concealing anything.
7. **Residual concurrency notes, documented not closed.** `moveFolder` has a documented race: a
   concurrent writer committing between its transaction's snapshot and its commit can still strand
   a document at the old path prefix. SERIALIZABLE isolation would not close this window (every
   other writer — UI, MCP, triage — is autocommit READ COMMITTED; promoting only `moveFolder` adds
   retry overhead without removing the race). Accepted because the tree is self-healing: `buildTree`
   unions path-derived folders with registry rows, so a stranded document still renders its own
   folder from its own path, and the next write under that folder re-materializes the registry row.
   Separately, Task 15's optimistic-mutation rollback is stamped with a generation counter so a
   slower failing mutation can't clobber a newer one's write — but that counter only discriminates
   against other mutations sharing the same factory; a slow-failing mutation could in principle
   still restore a stale snapshot over a fresher SSE-triggered refetch landing in the interim. Both
   are narrow, single-user-scale exposures, not fixed this cycle.

## What shipped

**Data model (`folders` table, migration 0037):** id/path/color/timestamps, `folders_path_uidx`
unique index, and a `folders_path_format_check` CHECK constraint added mid-cycle after a review
caught the backfill emitting malformed paths for documents with an internal `//`. Materialization
(`ensureFolders`) is hooked into `createDoc`/`updateDoc` in the *service* layer, so every writer —
the documents UI, all four MCP document tools, capture triage, and ShareX transcriptions — creates
folder rows by construction, not by each writer remembering to.

**Colour** (`FOLDER_PALETTE`, the same 14 hex values `projects.color` draws from): own colour, else
the owning project's colour (if the folder IS a `/projects/<slug>` root), else whatever cascaded
from an ancestor, else nothing — resolved server-side, top-down, in `applyFolderColors`.
`FolderColorPicker.vue` plus an "Inherit" action to clear an override.

**Folder operations** (`server/services/folders.ts`): `createFolder`, `moveFolder`, `deleteFolder`,
`setFolderColor`, `folderImpact`. Every path-prefix predicate is `LIKE`-escaped (`_` and `%` occur
naturally in real paths like `/projects/my_project`; an unescaped predicate would sweep sibling
rows into a move or delete — caught in review as an Important finding, fixed before merge into the
task's own branch). `moveFolder` re-associates documents to a new project when they cross a
`/projects/<slug>/` boundary, atomically, in one transaction. A `reason: 'not-found' | 'invalid' |
'collision'` discriminant lets the four HTTP routes map straight to 404/400/409 through one shared,
`never`-guarded function (`server/utils/folder-http.ts`).

**Four endpoints:** `POST /api/folders`, `PATCH /api/folders/[id]`, `DELETE /api/folders/[id]`,
`GET /api/folders/[id]/impact`. Every mutation publishes a `folder` SSE event that invalidates the
tree query app-wide (`app/utils/live-dispatch.ts`) — confirmed live across two real browser tabs
during this task's validation sweep (see below), which nobody had actually observed before.

**UI:** tree rebuilt as a hand-rolled recursive renderer (see caveat 2) with real folder/file
context menus (folders: New document here / New subfolder / Rename / Move / Colour / Copy path /
Collapse all / Delete — previously nothing at all), `useSortable` drag for both files and folders
(dropping onto a folder's own row files into it, matching Explorer/Finder — a review round caught
and fixed a bug where dropping onto a collapsed folder's row was filing into its *parent*
instead), a folder picker (`USelectMenu`) on document creation instead of a hand-typed path, an
empty document that always opens in Edit mode, a three-pane layout (tree · editor · collapsible
inspector, metadata form moved out of the editor into its own panel), optimistic tree mutations
for rename/move/colour/delete/create (generation-stamped rollback, cycle 15), and loading states
that keep the previous document visible (read-only) instead of ever showing a blank editor.

**A pre-existing user-visible subtraction, ruled on by the controller mid-cycle:** the hover-reveal
quick-delete trash icon on every file row was removed (that hover slot now holds the drag handle).
Delete remains available on the file context menu. Accepted — a hover-revealed destructive control
invites mis-clicks, and both VS Code and Finder use the context menu for this — but it's a genuine
subtraction in a cycle framed as a UX improvement, so it's called out here explicitly. Reversible
in a few lines if wanted back.

## Gate numbers (measured fresh for this handover, this run)

```
$ pnpm typecheck
✔ (0 errors)

$ pnpm test
 Test Files  166 passed (166)
      Tests  1332 passed (1332)

$ pnpm test:db
 Test Files  18 passed (18)
      Tests  176 passed (176)

$ pnpm build
✨ Build complete! (clean)
```

Docker's local `mymind-db` Postgres container was already running; no dev server was up before the
gates ran (`pnpm build` and `pnpm dev` were never live at the same time).

## Browser validation — all six original complaints, plus the carried cross-tab check

All performed with `playwright-cli` against `PORT=3010 pnpm dev` (with a matching
`BETTER_AUTH_URL=http://localhost:3010` — better-auth validates the request Origin against
`trustedOrigins`, derived solely from `BETTER_AUTH_URL`, so a spare-port dev server needs the env
var to match or every sign-in attempt 400s with "Invalid origin"; not previously documented,
worth adding to the browser-testing skill for the next cycle that uses a spare port).

1. **Right-click a folder → full context menu.** Confirmed: New document here / New subfolder /
   Rename / Move / Colour / Copy path / Collapse all / Delete. Screenshot taken. Previously did
   nothing at all. **PASS.**
2. **Folders drag, not just files; dropping a file onto a folder row files it into that folder.**
   Both proven with real multi-step mouse drags (SortableJS needs genuine intermediate
   `mousemove`s, not one jump) from the row's `.drag-handle`. A file dragged onto a collapsed
   folder's own row moved into it; a folder dragged from `/notes` into `/projects` moved and, on a
   full page reload, was still there. **PASS.**
3. **Deleting a folder's last document leaves the folder in place.** Created a document inside an
   empty subfolder, deleted it via its own context menu, and the folder (now empty again) remained
   in the tree with "This folder is empty." **PASS.**
4. **Creating a document offers a folder picker instead of a hand-typed path.** The New Document
   modal's "Folder" field is a `USelectMenu` listbox populated from the real tree (registry rows +
   path-derived folders), not a text input. **PASS.**
5. **An empty document opens in Edit mode, never a blank preview.** Created a genuinely empty
   `.md` file and opened it: the Edit toggle was active, the markdown toolbar (edit/split-only)
   was visible, and CodeMirror showed an empty line-1 gutter — never a blank Preview pane.
   **PASS.**
6. **Folders can be coloured, inherited down the tree.** Set a folder's colour via the picker;
   its rail and folder-icon both read `rgb(59, 130, 246)` (`#3b82f6`, the exact swatch clicked)
   via computed style, and a child subfolder with no colour of its own read the identical
   `rgb(59, 130, 246)` — inheritance confirmed with real computed values, not a presence check.
   **PASS.**
7. **Cross-tab SSE refresh (carried from Task 7 — never previously observed).** Opened two real
   browser tabs on `/documents`, both logged in. In tab 1: changed the test folder's colour, then
   switched to tab 2 (no navigation, no reload) — tab 2's rail updated to the exact new hex
   immediately. Repeated with a rename for a second, independent confirmation — tab 2 picked up
   the new folder name with no reload. The app sets `refetchOnWindowFocus: false` explicitly
   (`app/plugins/vue-query.ts`), which rules out "it was just a focus refetch" as the explanation;
   the only mechanism left is the `folder` SSE event → `dispatchLiveEvent` →
   `invalidateQueries(['document','list'])` path. **PASS — the carried item is now proven, not
   just correct by inspection.**

All test folders/documents created for validation (`/notes/zz-cycle59-test` and its contents) were
deleted through the UI's own folder-delete flow before finishing; a post-cleanup tree fetch
confirmed zero residual `zz-`-prefixed paths. The dev server was killed by verified PID
(`lsof -ti tcp:3010`) after validation, before this handover's docs were written.

## A defect found during validation (reported, not fixed — per this task's constraints)

**Deleting the currently-open document does not clear the tree's selection.** `documents.vue`'s
`selectedId` ref is never reset when the deleted document is the one currently open, so `Editor.vue`
keeps rendering the deleted document's stale content and breadcrumb, and its `useDocDetail` query
silently retries a 404 GET against the now-deleted id in the background (three consecutive 404s
observed in the console over several seconds, no user-facing error, no redirect to the "select a
document" placeholder). Reproduced live: created and opened a document, deleted it via its own
context menu, and the editor pane never left the deleted document's view. This appears pre-existing
rather than a cycle-59 regression — `confirmDelete` (`useDocumentTree.ts`) is Task 8's straight
extraction of prior logic, reviewed and confirmed behaviourally identical to what it replaced — it
simply hadn't been exercised with "delete the document you're currently looking at" before this
sweep. Captured as item 21 in the follow-ups task (MyMind `ad0e0244`); not fixed here per this
task's own constraint against changing application code during validation.

## Deferred minors

Thirty items carried from the ledger plus the one found above, grouped by area (tree/drag, colour,
API/service, editor/inspector, cosmetic/naming) and none blocking the shipped feature — full list
in MyMind task `ad0e0244` ("Cycle 59 follow-ups — documents folders UX (30 deferred items)"). The
two judged worth prioritizing first, if this list is ever worked: the stale-editor-after-delete
defect above, and the asymmetric one-at-a-time move-confirmation guard (a manually-opened Move
dialog can be silently overwritten by an in-flight drag's confirmation resolving at the same
moment — narrow, but a real correctness gap in the same family this cycle's other confirmation
races were fixed in).

## Tracking docs reconciled

- `docs/superpowers/plans/00-roadmap.md` — cycle 59 row added.
- `docs/BACKLOG.md` — the six original complaints struck as shipped; cycle 58's `USelectMenu`
  sweep (MyMind task `7be76abc`) noted complete (it already was, closed in cycle 58's own
  handover — restated here per this task's brief).
- MyMind task `f7d4ed33` closed; MyMind task `ad0e0244` opened for the follow-ups above.

## What to check before merging

- This branch (`worktree-feat+documents-folders-ux`) is 29 commits ahead of `master`, not pushed,
  not merged, not deployed. No merge/deploy authorization was requested or granted as part of this
  task — that decision belongs to Tony, same as cycle 58's precedent.
- Migration 0037 (`folders` table + backfill + CHECK constraint) has only run against local dev.
  Caveat 1 above applies before running it on production's real corpus.
- The hover-delete-icon removal (see "What shipped") is worth a two-second gut check against real
  usage before merging — it's the one place this cycle removed an existing affordance rather than
  only adding new ones.
