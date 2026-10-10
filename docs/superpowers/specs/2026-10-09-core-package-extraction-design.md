---
title: "Core package extraction — @mymind/core as a pnpm workspace package, no behaviour change (cycle 80, harness step 1)"
cycle: 80
date: 2026-10-09
status: spec
supersedes: null
builds_on: 2026-10-05-google-connections-design.md
---

# Core package extraction (cycle 80 — harness programme step 1)

## Why

2026-10-09 decision (memory `agent-harness-direction`): Bridget's agent loop — one chat turn, ≤16
steps, inside the Nitro web process — is the limit on agency. The programme rebuilds it as a
Turnstone-inspired TypeScript harness (Apache-2.0 design, ported) running as a **separate worker
process** in the same repo:

| step | scope |
|---|---|
| **1 (this spec)** | extract `@mymind/core` — no behaviour change |
| 2 | `apps/worker` + durable workstreams + cross-process live events + workstream UI |
| 3 | sandboxed workspace: file tools, background shells, `watch` |
| 4 | coordinator: task list, spawn/wait/steer children, narrowing authority |
| 5 | judge (rules + LLM veto-only) + smart approvals |
| 6 | eval + prompt/tool optimizer |
| 7 | host move to the Mac mini with a sandbox boundary |

Each step merges separately so any step can be reverted alone (Tony: no spike — "go for it, revert
if we don't like it"). Rejected for the programme: Python/forking Turnstone (would re-create the
seam to MyMind's 53 TS tools, schema and safety work), Claude Agent SDK (API cost; consumer terms
forbid automated subscription use; no local models).

## 1. Decisions (brainstorm 2026-10-09)

| # | Decision | Rejected |
|---|---|---|
| D1 | Core = the **import closure of the worker's code** (measured: 263 files) | all server domain code; db+shared only |
| D2 | **Source package, no build step**: `exports` point at `.ts`; Nitro/Vite bundle it, vitest runs it, the step-2 worker is esbuild-bundled | compiled `dist/` package |
| D3 | **`initCore(config)`** with a typed `CoreConfig`; web fills it from runtime config in a first-ordered Nitro plugin, the worker from `process.env`; core throws if used before init | core reading `process.env` directly |
| D4 | **Nuxt stays at the repo root**; `packages/core` (and later `apps/worker`) are workspace members | moving the app to `apps/web` now |
| D5 | **better-auth's `buildAuth(config)` moves into core**; the root app mounts its HTTP handler, the worker uses it in-process | auth staying Nitro-only |
| D6 | Process-local state (live-update hub, undo registry, approval channels, approval pins) moves **unchanged**; cross-process is step 2 | making it cross-process now |

## 2. What moves

From the closure of `server/lib/{agent,google,channels,ai}` + `server/db` (script-measured; the plan
re-derives it at execution time and fails on drift):

- `server/db/**` (schema, client, types)
- `server/lib/{agent, ai, channels, google, voice, search, observability, exec, imagegen, memory,
  documents, projects, tasks, triage, review, chunking, images}`
- the `server/services/*` modules in the closure (21: conversation-path, conversations, documents,
  files, folders, images, memory-dedup, memory, profile, projects, review-decisions, review,
  session-read, session-search, skills, task-columns, tasks, tree, triage, voice-presets, + any the
  re-derivation adds)
- `server/utils/{live-bus, net, storage}`
- the `shared/{types,utils,review}` files in the closure; `shared/` files used only by `app/`
  stay where they are
- their colocated `*.test.ts` files

Stays in the root app: `server/api/**` (193 routes), `server/plugins/**`, `server/middleware/**`,
`server/tasks/**`, Nuxt-only `server/utils/*`, the `server/lib/*` dirs outside the closure, and `app/`.

## 3. Layout

```
packages/core/
  package.json        name @mymind/core, private, type module,
                      exports: { "./*": "./src/*.ts", "./db": "./src/db/index.ts", ... }
  tsconfig.json       extends the root strict settings
  src/
    config.ts         CoreConfig, initCore, coreConfig()
    db/ lib/ services/ utils/ shared/    (same internal structure as today)
```

Root `pnpm-workspace.yaml` gains `packages: ['packages/*']` (existing `overrides`/`allowBuilds`
kept); root `package.json` adds `"@mymind/core": "workspace:*"`.

## 4. Decoupling from Nitro

- **Config:** every `useRuntimeConfig()` reachable from core (≈12 sites incl. `db/index.ts`,
  `utils/storage`, `lib/google/scopes.ts`, `services/memory.ts`) reads `coreConfig()` instead.
  `CoreConfig` is exactly the union of the fields those sites read — no speculative fields.
- **Auth:** `buildAuth(config)` + `useAuth()` move to `@mymind/core/lib/auth` (or alongside
  `lib/google/auth-options.ts`); `server/utils/auth.ts` re-exports so routes/middleware are unchanged
  in behaviour.
- **`$fetch`:** the four bare uses (`lib/ai/embeddings.ts`, `lib/ai/rerank.ts`,
  `lib/imagegen/comfy.ts`, `lib/observability/email.ts`) import `ofetch` explicitly.
- **Layering fix:** `server/api/review/kinds.ts` is imported by `lib/agent`; its logic moves to
  `@mymind/core/lib/review/kinds.ts` with plain errors; the API route maps them to HTTP via
  `createError`.
- **Init:** `server/plugins/00.core.ts` (object syntax, `name: 'core'`, ordered first — memory
  `nuxt-plugin-load-order`) calls `initCore()` from runtime config before any other plugin.
- **Guard test:** a test fails if any file under `packages/core/src` contains `useRuntimeConfig(`,
  `useNitroApp(`, `defineEventHandler(`, `useStorage(`, `createError(`, or an unimported `$fetch(`.

## 5. Mechanics

- Moves with `git mv` (history kept). Import rewriting by a committed codemod script
  (`scripts/codemod-core-imports.ts`): moved-file-relative imports stay relative; outside
  importers (`server/**`, `app/**`, `test/**`) are rewritten to `@mymind/core/...`. Never by hand.
- `nuxt.config.ts`: whatever is needed for Nitro/Vite to transpile the workspace source
  (`build.transpile` / Nitro externals inline) — determined by the build, recorded in the plan report.
- `drizzle.config.ts` schema path → `packages/core/src/db/schema`; migrations folder unchanged.
- Vitest configs include `packages/core/**/*.test.ts` and resolve `@mymind/core`.
- `.claude/rules/*` / `.claude/skills/*` globs or paths that pointed at moved dirs are updated.

## 6. Testing and gates

- `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build` green.
- **Same test counts as before** (baseline on master at plan time — currently 3451 passed / 1 skipped
  and 882): a changed count means a test was lost or double-collected (memory
  `vitest-claude-worktree-pollution`).
- Guard test (§4).
- **Plain-Node smoke test:** a script run with `tsx` outside Nuxt imports `@mymind/core`, calls
  `initCore` from env, and runs `select 1` through `useDb()` and lists one table via drizzle —
  proves the step-2 worker can use core.
- Browser smoke (playwright-cli): login, `/agent` sends a turn and gets a reply with a tool call,
  `/settings/connections` renders, a document opens.

## 7. Deploy and rollback

No deploy-path change (Nuxt stays at root). CD's `pnpm install --frozen-lockfile` picks up the
workspace. Prod verification: `/api/health` 200, authed MCP canary, one real Bridget turn, 0
journal errors. Rollback = revert the single merge.

## 8. Out of scope

`apps/worker`, cross-process live events, workstreams (step 2); moving the app to `apps/web`;
renaming/re-architecting anything inside the moved code; the remaining `server/lib` dirs.

The previously planned "cycle 80 — proactive Bridget over connectors" is renumbered after the
harness steps that it now depends on.
