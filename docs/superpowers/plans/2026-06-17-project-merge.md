# Project Merge (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fold a legacy duplicate project (loser) into its canonical twin (winner) — repoint all references, absorb the loser's identity, hard-delete it — surfaced as a "Merge into…" action on the project dashboard.

**Architecture:** A transactional `mergeProjects(loserSlug, winnerSlug)` repoints `sessions`/`memories`/`documents`/`tasks` from the loser to the winner (by `project_id` or denormalized slug), rewrites filed doc paths `/projects/<loser>/` → `/projects/<winner>/` (row-by-row with collision uniquify), absorbs the loser's slug+aliases into the winner, and hard-deletes the loser. A follow-up pass collapses duplicate memories the merge created, reusing `createMemory`'s `dedupDecision` machinery.

**Tech Stack:** Nuxt 4 / Nitro / Drizzle-pg / @tanstack/vue-query / Nuxt UI v4. Tests: vitest (pure-unit; repo has NO DB harness — DB behavior is validated by the controller's playwright E2E).

**Spec:** `docs/superpowers/specs/2026-06-17-project-merge-design.md`.

## Global Constraints

- **Path is the source of truth for doc filing** (cycle 26): a doc is associated to X iff under `/projects/<X-slug>/`. The merge repoints `project_id`+slug AND rewrites the path so the invariant holds. Reuse `rewriteProjectPathPrefix` (`server/lib/projects/doc-path.ts`).
- **Match by `project_id` OR the denormalized `project = slug`** when repointing (catch drift). `tasks` repoint by slug only (no `project_id`).
- **Live-data convention**: every mutation `publishChange({resource,action,id})` after commit; `project`/`session`/`task`/`memory`/`document` are valid `ResourceName`s. Reads via vue-query (reactive key in a `computed`; `data` read-only).
- **Nuxt UI v4 + semantic tokens only** (no raw Tailwind palette classes); invoke `nuxt-ui-docs` before unfamiliar v4 component APIs.
- Gates: `pnpm typecheck` 0, `pnpm test` green (currently 379), `pnpm build`. Lint not a gate. `pnpm db:migrate` for local migrations (this cycle adds **no migration** — pure logic + UI).
- **Hard-delete is final** — no undo; the confirm dialog is the guard.

## File Structure

- `server/services/project-merge.ts` — **new**: `mergeProjects` + the doc-path collision helpers (T1, T2). (Keep separate from `projects.ts`, which is already large.)
- `server/services/memory.ts` — extract a reusable `dedupExistingMemory(id)` from `createMemory`; the merge dedup pass (T3).
- `server/api/projects/[slug]/merge.post.ts` — **new**: endpoint (T4).
- `app/composables/useProjects.ts` — `merge(loserSlug, targetSlug)` (T4).
- `app/components/ProjectMergeModal.vue` — **new**: confirm dialog (T5).
- `app/pages/projects/[slug].vue` — "Merge into…" action wiring (T5).

---

## Task 1: Pure helpers — doc-path uniquify + array merge

**Files:**
- Create: `server/services/project-merge.ts` (start it with these pure helpers)
- Test: `test/project-merge.test.ts`

**Interfaces — Produces:**
- `uniquifyPath(target: string, taken: Set<string>): string` — if `target` not in `taken`, return it; else insert `-2`/`-3`/… before the extension until free (e.g. `/projects/w/foo.md` taken → `/projects/w/foo-2.md`). Mirrors `nextUniqueSlug`'s counter strategy.
- `mergeStringArrays(a: string[], b: string[]): string[]` — concat + dedupe, preserving `a`'s order then new items from `b`.

- [ ] **Step 1 (RED):** `test/project-merge.test.ts`: `uniquifyPath('/projects/w/foo.md', new Set())` → unchanged; with `{'/projects/w/foo.md'}` → `/projects/w/foo-2.md`; with `foo.md`+`foo-2.md` taken → `foo-3.md`; a path with no extension (`/projects/w/readme`) → `/projects/w/readme-2`. `mergeStringArrays(['a','b'],['b','c'])` → `['a','b','c']`; empties → `[]`. Run → FAIL.
- [ ] **Step 2 (GREEN):** Implement both in `server/services/project-merge.ts`. For `uniquifyPath`, split on the last `/` for dir+name, split name on the last `.` for base+ext, loop `base-${n}` until free. Run → PASS.
- [ ] **Step 3:** `pnpm typecheck` + `pnpm test`. Commit `feat(merge): doc-path uniquify + array-merge helpers`.

---

## Task 2: `mergeProjects` transactional core

**Files:**
- Modify: `server/services/project-merge.ts` (add `mergeProjects`)
- Test: `test/project-merge.test.ts` (the pure repoint-plan logic, if extracted; the DB transaction is E2E-validated)

**Interfaces:**
- Consumes: `uniquifyPath`, `mergeStringArrays` (T1); `rewriteProjectPathPrefix` (`server/lib/projects/doc-path.ts`); `getProject` (`server/services/projects.ts`); schema `projects`, `sessions`, `memories`, `documents`, `tasks`.
- Produces: `mergeProjects(loserSlug: string, winnerSlug: string): Promise<{ winner: ProjectDTO, repointedMemoryIds: string[] }>` — the `repointedMemoryIds` feed Task 3's dedup pass.

**Behavior (in `db.transaction`, all on `tx`):**
1. Load loser `L` + winner `W` rows (`select … where slug = …`). Throw a typed error if either is missing, if `L.id === W.id` (self-merge), or if either slug is `uncategorized`. (Endpoint maps these to 400/404.)
2. Capture `repointedMemoryIds`: `select id from memories where (project_id = L.id or project = L.slug) and archived_at is null` (these enter W's bucket — Task 3 dedups them).
3. **Bulk repoints:**
   - `tx.update(sessions).set({ projectId: W.id, project: W.slug }).where(or(eq(sessions.projectId, L.id), eq(sessions.project, L.slug)))`
   - same for `memories`.
   - `tx.update(tasks).set({ project: W.slug }).where(eq(tasks.project, L.slug))` (slug only).
4. **Documents — row-by-row** (path collisions possible): select loser docs `where (project_id = L.id or project = L.slug) and deleted_at is null`. Pre-load W's existing live doc paths into a `Set` (`select path from documents where deleted_at is null` — or scope to `/projects/W.slug/`). For each loser doc: compute `newPath = rewriteProjectPathPrefix(doc.path, L.slug, W.slug)` (paths not under `/projects/L.slug/` are unchanged); then `newPath = uniquifyPath(newPath, takenSet)`; add `newPath` to `takenSet`; `tx.update(documents).set({ projectId: W.id, project: W.slug, path: newPath, updatedAt: new Date() }).where(eq(documents.id, doc.id))`.
5. **Absorb identity into W:** `aliases = mergeStringArrays(W.aliases, [L.slug, ...L.aliases, ...(L.gitRemoteKey && !W.gitRemoteKey ? [L.gitRemoteKey] : [])])`; `localPaths = mergeStringArrays(W.localPaths, L.localPaths)`; `lastActivityAt = max(W,L)`. `tx.update(projects).set({ aliases, localPaths, lastActivityAt, updatedAt }).where(eq(projects.id, W.id))`.
6. **Hard-delete L:** `tx.delete(projects).where(eq(projects.id, L.id))`.
7. After the transaction: re-fetch the winner via `getProject(W.slug)` for the returned DTO.

- [ ] **Step 1:** Implement `mergeProjects` per the above. Use `db.transaction(async (tx) => {...})`; every statement on `tx`. Throw `new Error('MERGE_SELF'|'MERGE_UNCATEGORIZED'|'MERGE_NOT_FOUND')`-style sentinels for the guards (the endpoint maps them).
- [ ] **Step 2 (emit):** After commit, `publishChange` for: `project` (id `W.slug`), `project` (id `L.slug`, action `deleted`), and `session`/`task`/`memory`/`document` (action `updated`, id `W.slug`) so all lists refresh. (Do the emits in `mergeProjects` or the endpoint — pick one place; the endpoint is fine.)
- [ ] **Step 3 (test):** If you extract a pure "compute doc target paths with collisions" helper, unit-test it (loser docs `a.md`,`b.md` + winner already has `a.md` → loser's `a.md` → `a-2.md`, `b.md` unchanged). The transaction itself is E2E-validated. Keep `pnpm test` green + `pnpm typecheck` 0.
- [ ] **Step 4:** Commit `feat(merge): mergeProjects — repoint + absorb identity + hard-delete loser`.

---

## Task 3: Post-merge memory dedup

**Files:**
- Modify: `server/services/memory.ts` (extract `dedupExistingMemory`; add `dedupMemoriesAfterMerge`)
- Test: `test/project-merge.test.ts` or `test/mem-dedup.test.ts` (the decision reuse)

**Interfaces:**
- Consumes: `dedupDecision` + `DedupCandidate` (`server/services/memory-dedup.ts`) — already used by `createMemory`. `embedOne`, `memories` schema.
- Produces: `dedupMemoriesAfterMerge(memoryIds: string[]): Promise<{ collapsed: number }>`.

**Behavior:** for each `memoryId` (the loser memories now in W's bucket), run the SAME candidate-pool + decision logic `createMemory` uses (`server/services/memory.ts:154-208`), but for an EXISTING memory:
- Load the memory (its `contentHash` + `embedding` + `scope` + `project`).
- Build the candidate pool **excluding itself**: exact-hash (global) + top-20 nearest vectors in `(scope, project=W.slug)` where `id != memoryId` and `archived_at is null`.
- `decision = dedupDecision({ contentHash, embedding }, candidates)`.
- If `decision.action === 'skip'` (exact dup of an existing W memory) OR `'merge'` (near-dup): **archive THIS memory** (`archivedAt = now`, `supersededBy = decision.mergeId`), and merge its `evidence` into the survivor (`evidence = survivor.evidence || this.evidence`). `publishChange({ resource: 'memory', action: 'updated', id })`. Count it.
- If `'insert'` (no dup): leave it.

**Extraction (DRY):** factor the candidate-pool-building (lines 154-182 of `createMemory`) into a shared helper `buildDedupCandidates({ contentHash, embedding, scope, project, excludeId? })` used by BOTH `createMemory` and `dedupMemoriesAfterMerge`. Keep `createMemory`'s behavior identical (verify its tests stay green).

**Note:** this is the deterministic near-neighbor/hash collapse (the "existing near-neighbor dedup"). The LLM relationship-judge (`judgeRelations` supersede/contradict) is a separate enrichment-time layer and is **out of scope** for the merge dedup (a possible richer follow-up).

- [ ] **Step 1:** Extract `buildDedupCandidates(...)` from `createMemory` (no behavior change — run the existing memory tests to confirm). 
- [ ] **Step 2:** Implement `dedupMemoriesAfterMerge(memoryIds)` reusing it + `dedupDecision`; archive near/exact dups, merge evidence, emit, count.
- [ ] **Step 3 (test):** Unit-test the decision reuse where feasible (e.g. that `buildDedupCandidates` excludes the self id; that an exact-hash match yields a `skip`/archive). The full collapse is E2E-validated. `pnpm test` green + typecheck 0.
- [ ] **Step 4:** Commit `feat(merge): post-merge memory dedup (reuses dedupDecision)`.

---

## Task 4: Merge endpoint + composable

**Files:**
- Create: `server/api/projects/[slug]/merge.post.ts`
- Modify: `app/composables/useProjects.ts` (`merge`)
- Test: none new (guard mapping is thin); covered by E2E.

**Interfaces:**
- Consumes: `mergeProjects` (T2), `dedupMemoriesAfterMerge` (T3).
- Produces: `POST /api/projects/[slug]/merge` `{ targetSlug }` → winner `ProjectDTO`; `useProjects().merge(loserSlug, targetSlug)`.

- [ ] **Step 1:** Endpoint: zod `{ targetSlug: z.string().min(1) }`. `const loserSlug = getRouterParam(event,'slug')!`. `try { const { winner, repointedMemoryIds } = await mergeProjects(loserSlug, targetSlug); await dedupMemoriesAfterMerge(repointedMemoryIds); return winner } catch (e) { map MERGE_SELF/MERGE_UNCATEGORIZED → 400, MERGE_NOT_FOUND → 404, else rethrow }`. Emit the `publishChange` events here if not done in the service.
- [ ] **Step 2:** `useProjects.ts`: `const merge = (slug: string, targetSlug: string) => ofetch<ProjectDTO>(\`/api/projects/${slug}/merge\`, { method: 'POST', body: { targetSlug } })`; add to the returned object.
- [ ] **Step 3:** `pnpm typecheck` 0. Commit `feat(merge): POST /api/projects/[slug]/merge endpoint + composable`.

---

## Task 5: Dashboard "Merge into…" UI

**Files:**
- Create: `app/components/ProjectMergeModal.vue`
- Modify: `app/pages/projects/[slug].vue` (wire the action)
- Test: none (.vue); verified by typecheck + build + E2E.

**Interfaces — Consumes:** `useProjects().merge` (T4), `useProjects().useProjectList` (target options), the current `project` DTO (counts).

- [ ] **Step 1:** `ProjectMergeModal.vue`: props `project: ProjectDTO | null` (the loser) + `open` (`defineModel<boolean>('open')`); emits `merged: [ProjectDTO]`. Body:
  - A target `USelectMenu` over `useProjectList()` filtered to **exclude** the current project and `uncategorized` (options `{ label: name, value: slug }`).
  - A preview line: "**{N} sessions · {M} memories · {K} docs · {J} tasks** will move to **{target name}**" from `project.sessionCount`/`memoryCount`/`documentCount`/`taskCount`.
  - A destructive warning (`text-error`): "**{project.name}** will be permanently deleted. This cannot be undone."
  - Footer: Cancel + a `color="error"` "Merge" button (disabled until a target is chosen, `loading` during the call). On click: `await useProjects().merge(project.slug, targetSlug)`, toast success, `emit('merged', winner)`, close. On error, toast the message.
  - Nuxt UI v4 + semantic tokens. Invoke `nuxt-ui-docs` for `USelectMenu`/`UModal` if unsure.
- [ ] **Step 2:** `projects/[slug].vue`: add a "Merge into…" action — a secondary `UButton`/`UDropdownMenu` item in the header (next to Edit) or inside the Edit modal — that opens `<ProjectMergeModal v-model:open="showMerge" :project="project" @merged="onMerged" />`. `onMerged(winner)` → `navigateTo('/projects/' + winner.slug)`.
- [ ] **Step 3:** `pnpm typecheck` 0 + `pnpm build`. Commit `feat(merge): dashboard "Merge into…" confirm dialog`.

---

## Self-review notes (author)
- **Spec coverage:** repoint set (T2), doc-path rewrite + collision uniquify (T1/T2), identity absorption (T2), hard-delete (T2), post-merge dedup (T3), endpoint + guards (T4), dashboard UI + preview counts + warning (T5). ✓
- **Dedup scope:** uses `dedupDecision` (the deterministic near-neighbor/hash dedup `createMemory` already uses); the LLM `judgeRelations` layer is explicitly deferred — documented in T3 + the handover (a proportionate reading of the spec's "reuse the existing machinery").
- **Type consistency:** `mergeProjects` returns `{ winner, repointedMemoryIds }` (T2) → consumed by the endpoint (T4) → `dedupMemoriesAfterMerge(ids)` (T3). `merge(slug, targetSlug)` composable (T4) → `ProjectMergeModal` (T5).
- **No migration** this cycle (pure logic + UI).
- **E2E validation** (controller, after T5): create two projects with overlapping data (incl. a colliding doc path + a duplicate memory), merge L→W, assert all refs moved, loser 404s, W absorbed L.slug as an alias, the colliding doc path uniquified, the duplicate memory collapsed (archived).
