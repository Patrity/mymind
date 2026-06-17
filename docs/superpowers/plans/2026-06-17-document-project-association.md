# Document ↔ Project Association (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Associate documents with canonical projects via a path⟺project invariant (`/projects/<slug>/` filing root), surfaced as a Documents tab on the project dashboard.

**Architecture:** A document is associated to project X iff its `documents.path` is under `/projects/<X-slug>/`. The path is the single source of truth; `documents.project_id` (canonical) + the existing `documents.project` slug are **derived from the path on every write** through one choke point. Triggers: manual move, assign-project (sets project ⇒ files the doc), and the `/input` enrichment run (proposes a project + target path, applied via the existing review-approve flow). The dashboard's editable-slug rename cascade is extended to rewrite associated doc paths.

**Tech Stack:** Nuxt 4 / Nitro / Drizzle-pg / @tanstack/vue-query / Nuxt UI v4. Tests: vitest.

**Spec:** `docs/superpowers/specs/2026-06-17-document-project-association-design.md` (read for rationale; this plan is the build).

## Global Constraints

- **Filing root is lowercase `/projects`** (a `documents.path` string; distinct namespace from the Nuxt route `/projects/[slug]`). Constant `PROJECTS_ROOT = '/projects'`.
- **Path is the source of truth.** `documents.project_id` + `documents.project` (slug) are always derived from the path on write; they never drift. Match is **match-only — never create** a project from a folder name (cycle-23: creation is git-remote-only).
- **Live-data convention** (`.claude/rules/live-data.md`): reads via @tanstack/vue-query (keys `[resource,id]` / `[resource,'list',params]`, reactive params in a `computed`, `data` read-only); every server mutation calls `publishChange({resource,action,id})` after commit. `document` is a valid `ResourceName`.
- **Nuxt UI v4 + semantic color tokens only** (no raw Tailwind palette classes); invoke `nuxt-ui-docs` before using a component whose v4 API is unfamiliar (`UTabs` etc.). (`.claude/rules/web-vue-ui.md`)
- Gates: `pnpm typecheck` 0 errors, `pnpm test` green (currently 336), `pnpm build`. Lint is red repo-wide (not a gate). Validate UI with `playwright-cli` (creds `test@example.com` / `testpassword123`; restart the dev server if `.vue` HMR looks stale).
- `pnpm db:migrate` applies migrations locally; prod self-migrates on deploy.

## File Structure

- `server/db/schema/documents.ts` — add `project_id` column + index (T1).
- `server/db/migrations/0021_*.sql` (+ snapshot) — the migration (T1).
- `server/lib/projects/doc-path.ts` — **new**: `PROJECTS_ROOT`, `projectFromPath` (T2).
- `server/services/projects.ts` — extract `matchProjectByLabel`; extend `updateProject` slug-cascade to documents (T2, T4); add `documentCount` to `COUNT_COLUMNS` (T6).
- `server/services/documents.ts` — `resolveDocProjectFromPath` choke point wired into `createDoc`/`updateDoc`; assign-project path reconciliation; new flat `listDocs({project})` (T3, T6).
- `server/api/documents/index.get.ts` — **new**: `GET /api/documents?project=` flat list (T6).
- `server/lib/ai/enrich.ts` (+ its prompt) — feed project list to the proposer; propose `/projects/<slug>/` target path (T5).
- `server/services/enrichment.ts` — pass projects into the proposer call (T5).
- `server/services/image-enrich.ts` — emit `document` `publishChange` on OCR spin-off (T6).
- `shared/types/tasks.ts` — `documentCount` on `ProjectDTO` (T6).
- `app/composables/useDocuments.ts` — `useDocList(project)` hook (T6).
- `app/pages/projects/[slug].vue` — Documents tab + count (T6).

---

## Task 1: Migration — `documents.project_id`

**Files:**
- Modify: `server/db/schema/documents.ts`
- Create: `server/db/migrations/0021_*.sql` (+ `meta/` snapshot via `pnpm db:generate`)
- Test: none (migration); verify via `pnpm db:migrate` + a count query.

**Interfaces — Produces:** `documents.project_id uuid` (nullable FK → `projects.id`), index `documents_project_id_idx`.

- [ ] **Step 1:** In `server/db/schema/documents.ts` add column `projectId: uuid('project_id')` (after `project`) and, in the index block, `projectIdIdx: index('documents_project_id_idx').on(t.projectId)`.
- [ ] **Step 2:** `pnpm db:generate` → review the emitted `0021_*.sql`. It must `ALTER TABLE documents ADD COLUMN project_id uuid` + create the index. **Hand-add the FK** if drizzle omits it: `ALTER TABLE documents ADD CONSTRAINT documents_project_id_fk FOREIGN KEY (project_id) REFERENCES projects(id)`. Append a **backfill** statement to the migration: `UPDATE documents d SET project_id = p.id FROM projects p WHERE d.project = p.slug AND d.project_id IS NULL;`
- [ ] **Step 3:** `pnpm db:migrate` (local). Then verify: a row with a known `project` slug got `project_id` set (psql or a quick `tsx` count). Expected: docs whose `project` matches a project slug now have `project_id`.
- [ ] **Step 4:** `pnpm typecheck` (the schema type changes ripple to `$inferSelect`). Fix any `toDTO`/insert sites that now need to acknowledge `project_id` (the column is nullable, so inserts omitting it are fine).
- [ ] **Step 5:** Commit `feat(docs): add documents.project_id (migration 0021) + backfill`.

**Note:** `DocumentDTO` does NOT need `projectId` exposed (the client filters by the `project` slug). Keep `toDTO` as-is unless typecheck requires otherwise.

---

## Task 2: Pure helpers — `projectFromPath` + `matchProjectByLabel`

**Files:**
- Create: `server/lib/projects/doc-path.ts`
- Create: `server/lib/projects/__tests__/doc-path.test.ts` (or the repo's test location — check `git ls-files | grep test`)
- Modify: `server/services/projects.ts` (extract `matchProjectByLabel`)
- Test: extend an existing projects test or add `test/match-project-by-label.test.ts`

**Interfaces — Produces:**
- `PROJECTS_ROOT = '/projects'` and `projectFromPath(path: string): string | null` (returns the `<seg>` after `/projects/`, requiring a trailing slash boundary, else null).
- `matchProjectByLabel(label: string): Promise<typeof projects.$inferSelect | null>` in `projects.ts` — slug/alias/slugified-name match, **never creates**, no Uncategorized fallback.

- [ ] **Step 1 (RED):** Write `doc-path.test.ts`: `projectFromPath('/projects/mymind/notes/a.md') === 'mymind'`; `projectFromPath('/projects/mymind') === null` (no trailing-slash boundary → not "under"); `projectFromPath('/input/a.md') === null`; `projectFromPath('/projectsfoo/a.md') === null`; `projectFromPath('/projects//a.md') === null`. Run → FAIL (module missing).
- [ ] **Step 2 (GREEN):** Create `server/lib/projects/doc-path.ts`:
  ```ts
  export const PROJECTS_ROOT = '/projects'
  // Returns the project-slug segment iff the path is UNDER /projects/<seg>/ (trailing slash required).
  export function projectFromPath(path: string): string | null {
    const m = /^\/projects\/([^/]+)\//.exec(path)
    return m ? m[1]! : null
  }
  ```
  Run the test → PASS.
- [ ] **Step 3:** In `server/services/projects.ts`, extract the no-git label-match logic from `findOrCreateProject` into an exported `matchProjectByLabel(label)`: select where `slug = label OR aliases @> [label] OR aliases @> [slugify(label)] OR slug = slugify(label)`; return the row or null (no Uncategorized, no create). Refactor `findOrCreateProject`'s no-git branch to call it (then fall back to Uncategorized as it does today). Keep behavior identical for `findOrCreateProject`.
- [ ] **Step 4 (test):** Add a test (DB-backed if the repo has one, else assert the query-builder shape) — or a focused unit if a project fixture exists: a known slug matches; an alias matches; an unknown label → null. Keep `pnpm test` green.
- [ ] **Step 5:** `pnpm typecheck` + `pnpm test`. Commit `feat(projects): projectFromPath + matchProjectByLabel (path→project resolver)`.

---

## Task 3: Association choke point + write-path wiring

**Files:**
- Modify: `server/services/documents.ts` (`createDoc`, `updateDoc`; add `resolveDocProjectFromPath`)
- Test: `test/doc-project-association.test.ts` (DB-backed service test — follow any existing service-test pattern; if none, a focused unit around the path/assign reconciliation logic extracted as a pure helper)

**Interfaces:**
- Consumes: `projectFromPath`, `matchProjectByLabel` (T2).
- Produces: documents written via `createDoc`/`updateDoc` always have `project_id` + `project` **derived from their final path**; setting `project=<slug>` files the doc under `/projects/<slug>/`.

**Behavior (the reconciliation — implement exactly):**
1. A pure helper `targetPathForAssign(currentPath, slug): string` — returns `/projects/<slug>/<basename>` where `basename = currentPath.split('/').pop()`. (Unit-test it.)
2. `async resolveDocProjectFromPath(path): { projectId: string | null, project: string | null }` — `seg = projectFromPath(path)`; if seg and `matchProjectByLabel(seg)` resolves → that project's `{id, slug}`; else `{null, null}`.
3. **`createDoc`/`updateDoc` path precedence:**
   - Compute the **final path**: if the input carries a `project` slug (non-null) AND the path is NOT already under `/projects/<thatSlug>/`, set `finalPath = targetPathForAssign(path, slug)` (assign-project ⇒ file). Otherwise `finalPath = path`.
   - Derive `{projectId, project} = await resolveDocProjectFromPath(finalPath)` and write BOTH (overriding any passed `project`/`project_id`). So path always wins; the input `project` only *relocates* the doc.
   - `project = null` input with a path still under `/projects/X/` keeps `project = X` (path wins). To unassign, the doc must be moved out of `/projects/` (path changes).
4. Apply on **every** create and on every update **where path or project is in the input**. (`moveDoc` already routes through `updateDoc({path})`, so it's covered.)
5. Path-collision on the assign-move reuses existing behavior (the unique `documents_path_live_uidx` throws; let it surface as it does today — match current `createDoc`/`updateDoc` semantics).

- [ ] **Step 1 (RED):** Tests: (a) `targetPathForAssign('/input/foo.md','mymind') === '/projects/mymind/foo.md'`; (b) create with `path:'/projects/mymind/x.md'` ⇒ row has `project='mymind'` + `project_id` = mymind's id; (c) create with `path:'/input/x.md', project:'mymind'` ⇒ row path is `/projects/mymind/x.md` + associated; (d) update moving a doc to `/input/x.md` ⇒ `project_id`/`project` cleared; (e) `/projects/nope/x.md` (no matching project) ⇒ path kept, `project_id` null. Run → FAIL.
- [ ] **Step 2 (GREEN):** Implement `targetPathForAssign`, `resolveDocProjectFromPath`, and wire the precedence into `createDoc`/`updateDoc`. Set `project_id` + `project` in the insert/patch.
- [ ] **Step 3:** Run the tests → PASS. `pnpm typecheck`.
- [ ] **Step 4:** Confirm the existing review-approve path (`server/api/review/[id]/approve.post.ts`) still behaves: it calls `updateDoc({project})` then `moveDoc(path)`. With this change, `updateDoc({project: X})` files the doc under `/projects/X/`, then `moveDoc(p.path)` (if `p.path` already `/projects/X/...`) is idempotent. Verify no double-move regression (the move-listener resolves the same project). Add a test asserting approve-of-a-project-proposal associates the doc.
- [ ] **Step 5:** `pnpm test` green. Commit `feat(docs): derive project_id/slug from path on every write (move-listener + assign)`.

---

## Task 4: Slug-rename cascade → documents

**Files:**
- Modify: `server/services/projects.ts` (`updateProject` transaction)
- Modify: `server/api/projects/[slug].patch.ts` (emit a `document` change on slug rename)
- Test: extend the slug-rename coverage / `test/doc-project-association.test.ts`

**Interfaces — Consumes:** the existing `updateProject` slug-rename transaction (item 1) that cascades `sessions/tasks/memories.project`.

**Behavior:** when `patch.slug` changes, inside the SAME transaction also:
```sql
UPDATE documents
SET project = <newSlug>,
    path = regexp_replace(path, '^/projects/' || <oldSlug> || '/', '/projects/' || <newSlug> || '/'),
    updated_at = now()
WHERE project_id = <projectId>;
```
`project_id` is unchanged. Relative subpaths are preserved → no intra-project path collisions. (Use Drizzle `sql` with bound params; escape `<oldSlug>` for the regexp — slugs are `^[a-z0-9-]+$` so they're regex-safe, but anchor with `^/projects/<old>/`.)

- [ ] **Step 1 (RED):** Test: create a project `p` (slug `old`), a doc at `/projects/old/a/b.md` associated to `p`, rename `p.slug → new` via `updateProject`. Assert the doc's `path === '/projects/new/a/b.md'`, `project === 'new'`, `project_id` unchanged. Run → FAIL.
- [ ] **Step 2 (GREEN):** Add the `UPDATE documents …` to the rename transaction in `updateProject`.
- [ ] **Step 3:** In `[slug].patch.ts`, on a slug change additionally `publishChange({ resource: 'document', action: 'updated', id: project.slug })` (alongside the existing session/task/memory emits) so the tree refreshes.
- [ ] **Step 4:** `pnpm test` green + `pnpm typecheck`. Commit `feat(projects): slug rename cascades document paths`.

---

## Task 5: Enrichment classifies `/input` docs into a project

**Files:**
- Modify: `server/lib/ai/enrich.ts` (`proposeFrontmatter` signature + prompt)
- Modify: `server/services/enrichment.ts` (pass the project list into the proposer)
- Test: extend `enrich.ts`'s parser test (the `Proposed` parser already accepts `project`).

**Interfaces — Consumes:** `Proposed { title?, project?, domain?, type?, tags?, path? }` (already exists); the review-approve path already applies `project` + `path` (move). T3's move-listener resolves `project_id` from the moved path.

**Behavior:** the enrichment proposer must (a) be given the list of existing projects (slug + name + description), (b) **classify** the `/input` doc into the best matching project slug or none, and (c) when it picks a project, propose `path = '/projects/<slug>/<basename>'` so approval files + associates the doc. Confidence-gating rides the **existing** review flow (currently always queues a `pending` `review_queue` row → human approves; no new auto-apply mechanism — verify first and extend that path only).

- [ ] **Step 1:** Read `proposeFrontmatter` + its prompt. Change its signature to accept `projects: { slug: string, name: string, description: string }[]` and inject them into the system/user prompt: "Pick the single best-matching project SLUG from this list, or omit `project` if none fits. If you pick one, also set `path` to `/projects/<slug>/<current-filename>`." Keep the strict-JSON `Proposed` output (project + path already parse).
- [ ] **Step 2:** In `runEnrichInput`, load the active project list once (`listProjects({activeOnly:true})` or a lean `select slug,name,description`) and pass it to `proposeFrontmatter(docDto, projects)`. Skip `uncategorized` from the candidate list (not a filing target).
- [ ] **Step 3 (test):** Extend the proposer/parser test: a `Proposed` JSON with `project:'mymind', path:'/projects/mymind/x.md'` parses; one with no project omits it. (The LLM call itself isn't unit-tested; assert the parser + that `runEnrichInput` passes projects through — a focused test or a typecheck-level guarantee.)
- [ ] **Step 4:** `pnpm test` green + `pnpm typecheck`. Commit `feat(enrich): classify /input docs into a project + propose /projects/<slug>/ path`.

**Note:** do NOT change the review_queue schema or the approve path — they already carry/apply `project` + `path`. This task only makes the proposer produce them.

---

## Task 6: Surfacing — docs-by-project list, Documents tab, count, OCR emit

**Files:**
- Modify: `server/services/projects.ts` (`COUNT_COLUMNS` += `documentCount`)
- Modify: `shared/types/tasks.ts` (`ProjectDTO.documentCount: number`)
- Modify: `server/services/documents.ts` (`listDocs(opts?: { project?: string })` flat list)
- Create: `server/api/documents/index.get.ts` (`GET /api/documents?project=<slug>`)
- Modify: `app/composables/useDocuments.ts` (`useDocList(project)`)
- Modify: `app/pages/projects/[slug].vue` (Documents tab + stat)
- Modify: `server/services/image-enrich.ts` (emit `document` change on OCR spin-off)
- Test: `documentCount` in the projects-count path; `listDocs` project filter.

**Interfaces:**
- Consumes: T1 `project_id`, T3 association, `ProjectDTO` (item 1).
- Produces: `ProjectDTO.documentCount`; `GET /api/documents?project=<slug> → DocumentDTO[]`; `useDocuments().useDocList(slug)` (vue-query key `['document','list', slug]`).

- [ ] **Step 1:** Add to `COUNT_COLUMNS` (projects.ts): `documentCount: sql<number>\`(select count(*)::int from ${documents} d where d.project = ${projects.slug})\`` (count by slug, consistent with item-1). Add `documentCount` to `toDTO` + `ProjectDTO` (default 0). `pnpm typecheck`.
- [ ] **Step 2:** `documents.ts`: `export async function listDocs(opts: { project?: string } = {}): Promise<DocumentDTO[]>` — `select * where live() AND (opts.project ? eq(project, opts.project) : true) order by updatedAt desc limit 200`; map `toDTO`. Add `server/api/documents/index.get.ts` reading `?project=` → `listDocs({ project })`.
- [ ] **Step 3:** `useDocuments.ts`: add `useDocList(project: MaybeRefOrGetter<string|undefined>)` → `useQuery({ queryKey: ['document','list', computed(()=>toValue(project))], queryFn })` calling `ofetch('/api/documents', { query: { project } })`. (Mirror `useTaskList`.)
- [ ] **Step 4:** `app/pages/projects/[slug].vue`: add a **Documents** tab (4th `UTabs` item, `slot:'documents'`), a stat cell for `project.documentCount`, and rows from `useDocList(slug)` (loading/empty/error states like the other tabs). Each row shows the doc title + path; link to the document editor (the documents page — use whatever deep-link the page supports, else `/documents`). Invoke `nuxt-ui-docs` for `UTabs` if needed; drive tabs with real `playwright-cli click` when validating.
- [ ] **Step 5 (OCR emit fix):** In `server/services/image-enrich.ts`, after the `createDoc({...})` in the OCR spin-off branch, add `publishChange({ resource: 'document', action: 'created', id: doc.id })` (import `publishChange` if not already). `pnpm typecheck`.
- [ ] **Step 6:** `pnpm test` green + `pnpm build`. Commit `feat(projects): Documents tab + documentCount + docs-by-project list + OCR doc emit`.

---

## Self-review notes (author)
- **Spec coverage:** invariant (T2/T3), project_id storage (T1), three triggers (T3 move+assign, T5 enrichment), slug-cascade (T4), filter+count+tab (T6), OCR emit (T6). ✓
- **`?project=` on tree/search:** the spec mentioned filtering `listTree`/`searchDocs`; this plan instead adds a **flat `listDocs`** for the dashboard tab (cleaner for a tab than a filtered tree). Tree/search project-filtering is deferred (not needed by the tab) — note in the handover.
- **Type consistency:** `documentCount` added to `ProjectDTO` + `COUNT_COLUMNS` + `toDTO` together (T6). `matchProjectByLabel` defined T2, consumed T3/T5.
- **Validation:** after T6, playwright E2E — file a doc under `/projects/<slug>/` (move) → appears in the Documents tab + count increments; rename the project slug → the doc path follows; approve an enrichment proposal → doc files + associates.
