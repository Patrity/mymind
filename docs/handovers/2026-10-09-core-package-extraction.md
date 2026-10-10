---
title: Core package extraction — @mymind/core as a source-only pnpm workspace package (cycle 80, harness step 1)
cycle: 80
date: 2026-10-09
status: built  # → deployed after CD
branch: feat/core-package (worktree .claude/worktrees/feat+core-package, base 48bfca4)
merged: false
deployed: false
wiki:
  - ../wiki/core-package.md
  - ../wiki/auth.md
specs:
  - ../superpowers/specs/2026-10-09-core-package-extraction-design.md
plans:
  - ../superpowers/plans/2026-10-09-core-package-extraction.md
migrations: []  # none — db:generate reports no schema changes
behaviour_change: none (intended)
next: harness step 2 — apps/worker + durable workstreams + cross-process live events + workstream UI
---

# Core package extraction (cycle 80)

Step 1 of the agent-harness programme (memory `agent-harness-direction`: rebuild Bridget's loop as a
Turnstone-inspired TypeScript harness with a separate worker process). This step only makes the
worker possible: the server code the worker needs now lives in `packages/core` (`@mymind/core`) and
runs without Nuxt. The app behaves exactly as before.

## What changed
- **Workspace:** `pnpm-workspace.yaml` gains `packages: [packages/*]`; root depends on
  `@mymind/core: workspace:*`. Core is source-only — `exports` point at `.ts`; Nitro/Vite bundle it
  (nothing needed in `nuxt.config.ts`), vitest runs it, `pnpm typecheck` adds `tsc -p packages/core`.
- **Config:** `initCore(config)` / `coreConfig()` in `@mymind/core/config`; the root app fills it in
  `server/plugins/00.core.ts` (Nitro function-form plugin, runs first) via `fromRuntimeConfig`
  (`server/utils/core-config.ts`, same runtime-config keys as before); tsx scripts use
  `scripts/lib/core-init.ts` (env).
- **Auth:** `buildAuth(cfg)` (pure) + `useAuth()` live in core `lib/auth`; `server/utils/auth.ts`
  re-exports.
- **Nitro globals removed from moved code:** 5 bare `$fetch` → `ofetch` (incl. `lib/ai/chat.ts`);
  review-kinds logic moved from `server/api/review/kinds.ts` to core `lib/review/kinds.ts`.
- **The move:** 265 files (+72 colocated tests and fixtures) by `git mv` + the committed codemod
  `scripts/codemod-core-imports.ts`; closure computed by `scripts/core-closure.ts` (`--check`).
  Replaying the codemod reproduces the move commit's tree exactly; 0 non-import changes.
- **Guards:** `packages/core/src/guard.test.ts` (no Nitro globals in core), `test/core-single-instance.test.ts`,
  `test/core-smoke.db.test.ts` (plain-Node tsx: initCore from env → `select 1`).
- **Paths:** `.claude/rules`, skills, CLAUDE.md, 33 wiki pages, DEPLOYMENT.md updated; new wiki page `core-package.md`.
- **Final review:** Ready with fixes (docs only: core wiki page, auth.md path, commit this handover). CD verified unchanged by a simulated deploy (frozen install over existing node_modules, no TTY prompt), core-init plugin runs before agent-runtime recovery and scheduled tasks, every singleton appears once in `.output`, no server code in the client bundle.

## Evidence
- Counts: baseline 3451/1 + 882 → right after the move 3480/1 + 882 (identical to pre-move) → final
  3508/1 + 883 (new: 6 config, 21 decoupling, 24 guard, 4 single-instance, 2 auth-purity, 1 smoke).
- Gates: typecheck (nuxt + core tsc), test, test:db, build green; built `.output` boots, `/api/health` 200;
  `db:generate` → "No schema changes".
- Browser (dev): Bridget turn with 3 tool calls + reply in 4.0 s; Settings → Connections; a document.

## Known limits / notes
- With an empty model `baseURL`, `lib/ai/chat.ts` / `embeddings.ts` now fail with an ofetch invalid-URL
  error instead of Nitro's relative self-hit error (both throw; failover unchanged; activity_log text differs).
- `import.meta.dev` in core `lib/observability/email.ts` is a Nitro define — step 2 must move the
  dev-email flag into `CoreConfig` before the worker sends mail.
- `yaml` is not declared in core's package.json (declaring it bumps two transitive deps); revisit when
  the worker is bundled.
- Process-local singletons (live-update hub, undo registry, approval channels/pins) are unchanged and
  single-process — step 2 makes them cross-process.
- Deferred minors (SDD ledger): closure `--check` post-move detection, guard misses aliased globals
  (core tsc covers), single-instance test vs index exports, `.dockerignore` `**/node_modules`,
  smoke test tsx path.
