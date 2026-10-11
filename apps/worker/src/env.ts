// The worker's settings from its process env. CoreConfig goes through core's `fromEnv` — the same
// mapper (key table, build defaults, NITRO_/NUXT_ overrides) the web's `fromRuntimeConfig` uses, so
// the worker sees exactly the database, storage, bus namespace and executor the web sees.
import type { CoreConfig } from '@mymind/core/config'
import { fromEnv, type Env } from '@mymind/core/config-env'

// Replaced by esbuild (`define`, build.mjs) with `false`: the bundle is never a dev host — the
// worker's equivalent of Nitro's build-time `import.meta.dev`. Unbundled (tsx watch, tests) it is
// undeclared and the dev flag falls back to NODE_ENV=development.
declare const __MYMIND_WORKER_DEV__: boolean | undefined

export interface WorkerSettings {
  core: CoreConfig
  /** The runtime tick (recover, jobs, outbox, iMessage catch-up, pump) — WORKER_TICK_MS (5s). */
  tickMs: number
  /** Heartbeat interval (worker_heartbeat; the web reads it as stale after 30s). */
  beatMs: number
  /** SIGTERM drain: how long in-flight runs get to finish (spec §2: ≤60s). */
  drainMs: number
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function workerDev(env: Env): boolean {
  if (typeof __MYMIND_WORKER_DEV__ === 'boolean') return __MYMIND_WORKER_DEV__
  return env.NODE_ENV === 'development'
}

export function workerSettings(env: Env = process.env): WorkerSettings {
  return {
    core: fromEnv(env, { dev: workerDev(env) }),
    tickMs: positiveInt(env.WORKER_TICK_MS, 5_000),
    beatMs: positiveInt(env.WORKER_BEAT_MS, 5_000),
    drainMs: positiveInt(env.WORKER_DRAIN_MS, 60_000)
  }
}
