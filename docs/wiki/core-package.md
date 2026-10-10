---
title: "@mymind/core (shared server package)"
status: shipped
cycle: 80
updated: 2026-10-09
---

# `@mymind/core`

The server code that both the Nuxt app and (from harness step 2) the separate agent worker run. It
lives in `packages/core/src` as a **source-only pnpm workspace package**: `exports` map
`@mymind/core/*` straight to `.ts` files, there is no build step, and Nitro/Vite bundle it into
`.output` like local code. Nuxt stays at the repo root.

## What's in it

`db/` (schema, `useDb()` pool, types), `lib/` (agent, ai, auth, channels, chunking, documents, exec,
google, imagegen, images, memory, observability, projects, review, search, tasks, triage, voice — the
parts the worker reaches), `services/` (the 21 services those import), `utils/` (live-bus, net,
storage), `shared/` (types/utils used by core; app-only `shared/` files stay at the root).
What's in core is the import closure of `lib/{agent,google,channels,ai,auth}` + `db`, computed by
`scripts/core-closure.ts` (`--check` fails if core reaches a forbidden root).

## The boot contract — `initCore(config)`

Core never reads Nitro's `useRuntimeConfig()`. It reads one typed object:

```ts
import { initCore, coreConfig } from '@mymind/core/config'
```

| `CoreConfig` field | used by |
|---|---|
| `databaseUrl` | `db` (`useDb()` pool) |
| `betterAuthSecret`, `betterAuthUrl`, `allowSignup` | `lib/auth` (`buildAuth`), email links |
| `googleClientId`, `googleClientSecret` | `lib/google`, `lib/auth` (`''` ⇒ Google off) |
| `storageDriver`, `storageLocalDir`, `storageS3` | `utils/storage` |
| `memoryAutoReviewThreshold` | `services/memory` |
| `triageThresholds`, `triageAppendSimilarityFloor` | `services/triage` |

- **Web app:** `server/plugins/00.core.ts` (Nitro function-form plugin; runs before every other plugin
  and before scheduled tasks start) calls `initCore(fromRuntimeConfig(useRuntimeConfig()))`.
  `fromRuntimeConfig` (`server/utils/core-config.ts`) reads the same runtime-config keys the code read
  before cycle 80, so `NUXT_*` env overrides behave exactly as before.
- **tsx scripts:** `import './lib/core-init'` first (`scripts/lib/core-init.ts` → `initCore` from env).
- **Tests:** `test/setup/core-bridge.ts` initialises core per test file and bridges the existing
  `useRuntimeConfig` / `$fetch` stubs.
- `coreConfig()` before `initCore` throws `core not initialised — call initCore() first`; a second
  `initCore` with a different object throws.
- **Still read from `process.env` directly** (not yet in `CoreConfig`; step 2 decides):
  `lib/ai/registry/crypto.ts`, `lib/search/store.ts`, `lib/exec/run.ts`,
  `lib/agent/runtime/runs.ts`, `lib/agent/jobs/{schedule,timezone}.ts`,
  `lib/channels/bluebubbles/{channel,client}.ts`, `lib/observability/email.ts`
  (also uses Nitro's build-time `import.meta.dev`).

## Auth

`buildAuth(cfg)` is a pure function of `CoreConfig`; `useAuth()` builds the singleton from
`coreConfig()`. The root app mounts the HTTP handler; `server/utils/auth.ts` re-exports. See [auth.md](auth.md).

## Guard rails

- `packages/core/src/guard.test.ts` — fails on `useRuntimeConfig(`, `useNitroApp(`,
  `defineEventHandler(`, `useStorage(`, `createError(`, `defineNitroPlugin(`, or any unbound `$fetch`
  under `packages/core/src`.
- `pnpm typecheck` = `nuxt typecheck` **and** `tsc -p packages/core --noEmit` (core type-checks with no
  `.nuxt`, so no Nitro auto-import can creep in).
- `test/core-single-instance.test.ts` — singletons resolve to one module.
- `test/core-smoke.db.test.ts` — plain Node (tsx) imports core, `initCore` from env, `select 1`.

## Adding code

- Code the worker needs → `packages/core/src/...`, imported as `@mymind/core/<path>` from the app.
- Never call Nitro/h3 globals in core; take values from `coreConfig()` or parameters.
- New config → add the field to `CoreConfig`, map it in `fromRuntimeConfig` (table test pins the key),
  and in `scripts/lib/core-init.ts`.

## Known limits (step 2)

Process-local singletons (live-update hub, undo registry, approval channels and pins) are still
single-process; `yaml` is undeclared in core's `package.json`; esbuild bundling of core for the worker
is unproven.
