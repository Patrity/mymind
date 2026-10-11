---
title: "@mymind/core (shared server package)"
status: shipped
cycle: 80 (bus, env mapper, worker: cycle 81)
updated: 2026-10-11
mymind_id: 4c23fd31-c5f1-4648-868a-b584ffa5f308
mymind_hash: fda84f582689e397bdad403e9774addbf47700a8ec8b894114fe93debd6d9c66
---

# `@mymind/core`

The server code that both the Nuxt app and the separate agent worker (`apps/worker`, cycle 81) run. It
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
| `busNs` (env-backed, cycle 81) | `lib/bus/ns.ts` — the bus namespace (`MYMIND_BUS_NS`, default `default`) |
| `dev` (host fact, cycle 81) | dev-only stubs (`lib/observability/email.ts`) |

**One env mapper (cycle 81): `packages/core/src/config-env.ts`.** The web and the worker build
`CoreConfig` through the same module, so they cannot drift.
- `fromRuntimeConfig(rc, host)` is for the web, fed Nitro's `useRuntimeConfig()`.
  `server/utils/core-config.ts` re-exports it.
- `fromEnv(env)` is for the worker, fed `process.env`. It evaluates the same build-time defaults
  (`coreRuntimeConfig`), then applies the same `NITRO_*`/`NUXT_*` runtime overrides with
  `applyRuntimeEnv`, a faithful copy of Nitro's `applyEnv` that `test/core-config.test.ts` runs
  against Nitro's own implementation. So `NUXT_DATABASE_URL` wins in both processes, and a plain
  `DATABASE_URL` does not override in either.
- **Env-backed** fields (`ENV_BACKED_FIELDS = ['busNs']`, read from the variable `MYMIND_BUS_NS`)
  are read from the *runtime* env by both processes and are never baked at build time. A value in
  `.env.native` therefore reaches the web too. The web and the worker **must agree** on it.

- **Agent worker:** `apps/worker/src/main.ts` → `initCore(workerSettings().core)` (`apps/worker/src/env.ts`
  → `fromEnv`), before any dynamic import touches the DB.
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

## The bus (cycle 81)

`packages/core/src/lib/bus/` is how the web and the worker talk. It runs through Postgres only:
tables in `db/schema/bus.ts`, migrations 0068–0071. The behaviour is described in
[agent-runtime.md](agent-runtime.md#processes-and-the-bus-cycle-81).

| Module | Does |
|---|---|
| `ns.ts` | The bus namespace: `busNs()` / `setBusNs()` (tests). Every row and NOTIFY carries it, and every claim, read and listener filters on it. |
| `listen.ts` | The process's ONE dedicated `LISTEN` client (never on the pool). It is lazy and multiplexed, drops other namespaces, and self-heals: on error or end, or on a health ping that fails or hangs, it reconnects with backoff, re-LISTENs, and fires the `onListenReady` resync hooks. |
| `events.ts` | `run_events`, the run-event log. `createRunEventWriter` coalesces deltas (≈50 ms), writes one transaction per batch plus a NOTIFY pointer, and retries in order. `createRunEventReader` uses a lookback window and (run, seq) dedupe, so a row that commits late is never skipped. Also `openApprovalFrames` and `pruneRunEvents` (7 days; workstreams kept). |
| `relay.ts` | The web side: fans `run_events` out to the voice sockets per conversation, and replays running runs from seq 1 on a late join. |
| `commands.ts` | `worker_commands`: `sendCommand` (optionally awaiting a result with a 10 s timeout; an unclaimed row is closed when the sender gives up), `handleCommands` (atomic claim on NOTIFY and on a poll), `beatWorker` / heartbeat reads, `pruneHandledCommands`. |
| `live.ts` | Cross-process `publishChange` / `publishActivity`, with an origin id dropping echoes. |
| `invalidate.ts` | Settings caches: the web's PUT routes send `invalidate` with a known cache name. |

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

## Known limits

- Undo tokens, approval channels and their pins are still process-local, by design. They live in the
  worker that executes the run; the web reaches them by command (`undo`, `approval-decision`).
- `yaml` is undeclared in core's `package.json`.
- The worker bundle is esbuild-built (`apps/worker/build.mjs`). `apps/worker/stage.mjs` copies the
  externals' dependency closure into the release and import-proves every one from there.
- The `useDb()` pool has an `'error'` listener (cycle 81 fix wave): an idle client's socket error is
  logged and never crashes the process.
