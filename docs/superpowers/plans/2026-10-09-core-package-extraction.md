# Core Package Extraction Implementation Plan (cycle 80, harness step 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker-needed server code lives in a source-only pnpm workspace package `@mymind/core` that runs without Nuxt, with zero behaviour change for the app.

**Architecture:** Decouple first, move second. Task 2 removes every Nitro global from the code that will move (config via `initCore`, auth factory, explicit `ofetch`, review-kinds layering fix) while files stay in place. Task 3 then moves the measured import closure with `git mv` + a committed codemod, wires the workspace into Nuxt/vitest/drizzle, and proves independence with a guard test and a plain-Node smoke script.

**Tech Stack:** pnpm workspaces, Nuxt 4 / Nitro, Vite, vitest, drizzle-kit, tsx, better-auth.

**Spec:** `docs/superpowers/specs/2026-10-09-core-package-extraction-design.md`

## Global Constraints

- **No behaviour change.** No logic edits beyond what §4 of the spec requires (config source, auth location, `$fetch` import, kinds layering). No renames, no refactors "while we're here".
- **Same test counts:** baseline taken on the worktree base before Task 1 (`pnpm test` passed/skipped and `pnpm test:db` passed) is recorded in the ledger; every task ends with identical counts (new tests added by this plan are counted separately and listed).
- Gates every task: `pnpm typecheck`, `pnpm test`, `pnpm test:db`; Task 3+ also `pnpm build`. Lint is NOT a gate.
- Moves use `git mv` (history). Import rewrites only via the committed codemod — never by hand-editing hundreds of files.
- Core must never import from `app/`, `server/api`, `server/plugins`, `server/middleware`, `server/tasks`, or Nuxt/Nitro runtime (`#imports`, `nitropack/runtime`, `h3` event helpers).
- Conventional commits, **no co-author/model attribution trailers**. Mutation checks: commit first, mutate, `git checkout -- <file>`, `git diff --quiet`. Never `git stash`.
- Dev DB is shared with real data.

## Review Focus

1. **Silent config divergence** — a `coreConfig()` field filled from a different runtime-config key than the old `useRuntimeConfig()` read (e.g. `databaseUrl` vs `NUXT_DATABASE_URL` baking). Task 2 test maps each field.
2. **Init order** — anything touching core before `00.core.ts` runs (another plugin, a module-level `useDb()` call, a Nitro task at boot). Task 2 test + Task 3 build/boot smoke.
3. **Double module instances** — Vite/Nitro resolving `@mymind/core/x` and a leftover relative path to two copies, splitting singletons (live-bus hub, undo registry, approval pins, db pool). Task 3 test asserts one instance.
4. **Lost tests** — moved `*.test.ts` not collected, or collected twice. Count gate.
5. **Prod-only path differences** — `drizzle.config.ts` / migrate in CD, `.output` bundling of workspace source. Task 3 build + Task 5 deploy check.

---

### Task 1: Workspace scaffold + `initCore`

**Files:**
- Modify: `pnpm-workspace.yaml` (add `packages:\n  - packages/*`, keep existing keys), root `package.json` (`"@mymind/core": "workspace:*"` in dependencies)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/config.ts`, `packages/core/src/config.test.ts`
- Modify: root `tsconfig.json` / `nuxt.config.ts` only if needed for resolution; `vitest.config.ts`, `vitest.db.config.ts` (include `packages/core/**/*.test.ts`)

**Produces:**
```ts
// packages/core/src/config.ts
export interface CoreConfig { /* filled in Task 2 with exactly the fields core reads */ }
export function initCore(cfg: CoreConfig): void          // idempotent if called again with an equal object; throws if called with a different one
export function coreConfig(): CoreConfig                 // throws Error('core not initialised — call initCore() first') before init
export function _resetCoreForTests(): void               // test-only
```
`packages/core/package.json`:
```json
{ "name": "@mymind/core", "private": true, "type": "module",
  "exports": { "./*": "./src/*.ts" } }
```

- [ ] Record baseline counts in the ledger (`pnpm test`, `pnpm test:db`).
- [ ] Failing tests (`config.test.ts`): `coreConfig()` throws before init; returns the object after; second `initCore` with a different object throws; `_resetCoreForTests` resets.
- [ ] Implement; `pnpm install`; a root file can `import { initCore } from '@mymind/core/config'` (prove with a trivial vitest import test in `test/core-resolve.test.ts`).
- [ ] Gates; counts = baseline + the new tests. Commit `build(core): pnpm workspace + @mymind/core scaffold with initCore`.

---

### Task 2: Decouple the closure from Nitro, in place

**Files (in place under `server/` — nothing moves yet):**
- Every `useRuntimeConfig()` reachable from the closure: `server/db/index.ts`, `server/utils/storage/index.ts`, `server/lib/google/scopes.ts`, `server/services/memory.ts`, + any others the closure script (Task 3 Step 1, run early here in report-only mode) finds. Each reads `coreConfig().<field>` instead.
- `packages/core/src/config.ts`: `CoreConfig` gains exactly those fields (named after the runtime-config keys they replace).
- Create `server/plugins/00.core.ts`: `defineNitroPlugin({ name: 'core', setup() { initCore(fromRuntimeConfig(useRuntimeConfig())) } })` — object syntax per memory `nuxt-plugin-load-order`; `fromRuntimeConfig` is a pure exported mapper (in `server/utils/core-config.ts`) so it can be unit-tested.
- Auth: `server/utils/auth.ts` `buildAuth` becomes `buildAuth(cfg: CoreConfig)` in `server/lib/auth/index.ts` with `useAuth()` there (reads `coreConfig()`); `server/utils/auth.ts` re-exports `useAuth` so existing imports keep working. Google `connections.ts`/`manage.ts`/`token.ts` import `useAuth` explicitly from the new module.
- `$fetch` → `import { ofetch } from 'ofetch'` in `lib/ai/embeddings.ts`, `lib/ai/rerank.ts`, `lib/imagegen/comfy.ts`, `lib/observability/email.ts` (same options/semantics; check each for `$fetch.raw` or Nitro-relative URLs — a relative `$fetch('/api/…')` would hit Nitro internally and MUST be reported, not silently converted).
- Layering: logic of `server/api/review/kinds.ts` → `server/lib/review/kinds.ts` throwing plain `Error`s (or a typed `ReviewKindError` with a `status`); `server/api/review/kinds.ts` (if it is a route helper) re-exports or wraps with `createError`. `lib/agent` imports the lib version.

- [ ] Failing tests: `fromRuntimeConfig` maps every field from the runtime-config key the old code read (table test, one row per field — Review Focus 1); `useDb()` before `initCore` throws the not-initialised error; `lib/review/kinds` throws plain errors and the API wrapper still yields the same HTTP status as before (existing tests + one new).
- [ ] Implement. Also grep the closure for module-level (top-level) calls into config/db — any that run at import time would break init order (Review Focus 2); list them in the report and make them lazy.
- [ ] `pnpm dev` boot check: start on a spare port (`PORT=3016 BETTER_AUTH_URL=http://localhost:3016 pnpm dev`), `/api/health` 200 and login 200, then stop it (kill only your PID).
- [ ] Gates; counts = Task 1 counts + new tests. Commit `refactor(core): config via initCore, auth factory, explicit ofetch, review-kinds layering (no move yet)`.

---

### Task 3: Move the closure into `packages/core`

**Files:**
- Create: `scripts/core-closure.ts` (computes the import closure from seeds `server/lib/{agent,google,channels,ai}` + `server/db`, resolving relative + `~~/` + `~/` imports, ignoring `*.test.ts`; prints the file list; `--check` mode exits non-zero if the closure contains anything under the forbidden roots in Global Constraints), `scripts/codemod-core-imports.ts`
- Move (`git mv`): every closure file and its colocated `*.test.ts` from `server/<x>` → `packages/core/src/<x>` and `shared/<x>` → `packages/core/src/shared/<x>` (only closure files; `shared/` files used only by `app/` stay)
- Codemod: imports between moved files stay relative (paths unchanged relative to each other because the internal tree is preserved); importers outside core (`server/**`, `app/**`, `test/**`, `shared/**` leftovers, `scripts/**`) are rewritten to `@mymind/core/<path-without-.ts>`; `~~/shared/...` imports of moved shared files likewise.
- Modify: `drizzle.config.ts` schema path; `nuxt.config.ts` (whatever Vite/Nitro needs to transpile/inline the workspace source — try none first; record what was needed); vitest configs; `tsconfig` paths if needed.
- Create: `packages/core/src/guard.test.ts` (fails on any `useRuntimeConfig(`, `useNitroApp(`, `defineEventHandler(`, `useStorage(`, `createError(`, `defineNitroPlugin(`, or `$fetch(` without an import, under `packages/core/src`; and on any import resolving outside `packages/core/src` except npm packages), `scripts/core-smoke.ts` (tsx: `initCore` from env → `useDb().execute(sql\`select 1\`)` → count rows of one table → print OK) + `test/core-smoke.test.ts` that spawns it (db test suite).
- Create: `test/core-single-instance.test.ts` — imports the live-bus hub / undo registry via `@mymind/core/...` and via whatever path the app uses, asserts `===` (Review Focus 3).

- [ ] Run `scripts/core-closure.ts`, save the list to the report, diff against the spec's 263 (explain any drift). `--check` passes.
- [ ] `git mv` + codemod (commit the scripts first, then the move as its own commit so the diff is reviewable as a pure rename + import rewrite).
- [ ] Fix config wiring until typecheck/test/test:db/build pass. Counts = Task 2 counts + new tests (guard, smoke, single-instance) — identical otherwise.
- [ ] Mutation: add `useRuntimeConfig()` to one core file → guard test red; restore.
- [ ] `pnpm build` then boot the built server (`node .output/server/index.mjs` on a spare port with dev env) → `/api/health` 200 — proves the workspace source is bundled into `.output` (Review Focus 5). Stop it.
- [ ] Commit `refactor(core): move worker closure into @mymind/core (git mv + codemod)`.

---

### Task 4: Paths in tooling + docs, browser smoke

**Files:** `.claude/rules/*`, `.claude/skills/*` (globs/paths that referenced moved dirs), `CLAUDE.md` (one line on `packages/core`), `docs/wiki/agent.md` + other wiki pages that cite moved paths (path updates only), `docs/DEPLOYMENT.md` if it names moved paths.

- [ ] `grep -rn "server/lib/agent\|server/db/\|server/lib/google\|server/services/" .claude docs/wiki CLAUDE.md docs/DEPLOYMENT.md` → update each to the new location (handovers/specs/plans are historical — leave them).
- [ ] Browser smoke (playwright-cli, skill `browser-testing`, spare port): login; `/agent` new conversation → a turn that calls a tool (e.g. "what are my open tasks?") gets a reply; `/settings/connections` renders; open a document. Screenshot + Read each.
- [ ] Commit `docs(core): paths after @mymind/core extraction`.

---

### Task 5 (controller): final review, handover, deploy

- [ ] Final whole-branch review (most capable model) → one fix wave → scoped re-review.
- [ ] Handover `docs/handovers/2026-10-09-core-package-extraction.md` (frontmatter accurate), roadmap row 80 → shipped, wiki mirror for changed wiki pages.
- [ ] Merge (ff), push, watch CD with a polling loop on `gh run view --json status,conclusion` (not `gh run watch` piped), verify prod: `/api/health` 200, authed MCP canary, one real Bridget turn via the prod DB check of a fresh run, 0 journal errors.
