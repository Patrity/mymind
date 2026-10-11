// Cycle 81 (Task 2): the ONE place that turns host inputs into a CoreConfig, shared by the web
// (`fromRuntimeConfig`, fed Nitro's useRuntimeConfig()) and the agent worker (`fromEnv`, fed
// process.env). Both must produce the same CoreConfig for the same deployment, so the key mapping,
// the build-time defaults and the NUXT_/NITRO_ override rules all live here.
//
// CoreConfig has two kinds of fields:
//  - runtimeConfig-backed (databaseUrl … triageAppendSimilarityFloor). In the web they come from
//    nuxt.config's runtimeConfig, which is evaluated ONCE AT BUILD from the build-time env
//    (`coreRuntimeConfig(process.env)` below — nuxt.config spreads it) and then overridden at
//    RUNTIME only by NITRO_*/NUXT_* env vars (Nitro's applyEnv; a plain DATABASE_URL does not
//    override). The worker has no build step: `fromEnv` evaluates the same defaults from its env and
//    applies the same NITRO_/NUXT_ overrides (`applyRuntimeEnv`, a faithful copy of Nitro's
//    applyEnv — test/core-config.test.ts runs both against Nitro's own implementation).
//  - env-backed (busNs): read from the RUNTIME process env by both processes, never baked at build,
//    so `MYMIND_BUS_NS` in .env.native reaches the web too.
//  - `dev` is a host fact: the web passes Nitro's build-time `import.meta.dev`; the worker passes
//    its own (false in the esbuild bundle, NODE_ENV=development under `tsx watch`).
import { destr } from 'destr'
import type { CoreConfig } from './config'

export type Env = Record<string, string | undefined>

/** The runtimeConfig keys nuxt.config declares for core — the runtimeConfig-backed CoreConfig fields. */
export type CoreRuntimeKey =
  | 'databaseUrl' | 'betterAuthSecret' | 'betterAuthUrl' | 'allowSignup'
  | 'googleClientId' | 'googleClientSecret'
  | 'storageDriver' | 'storageLocalDir' | 'storageS3'
  | 'memoryAutoReviewThreshold' | 'triageThresholds' | 'triageAppendSimilarityFloor'

/** The slice of Nuxt runtimeConfig that core reads, keyed exactly as nuxt.config.ts declares it. */
export type CoreRuntimeConfigSource = { [K in CoreRuntimeKey]?: unknown }

/** CoreConfig fields read from the runtime process env (both processes), never from runtimeConfig. */
export const ENV_BACKED_FIELDS = ['busNs', 'sandboxRequireFirewall', 'sandboxRequireLimits'] as const

export const BUS_NS_ENV_NAME = 'MYMIND_BUS_NS'

/**
 * nuxt.config.ts's runtimeConfig entries for core, as a function of the BUILD-time env. nuxt.config
 * spreads `coreRuntimeConfig(process.env)`; the worker calls it with its runtime env. One
 * definition, so a default changed here changes both processes.
 */
export function coreRuntimeConfig(env: Env) {
  return {
    databaseUrl: env.DATABASE_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    betterAuthUrl: env.BETTER_AUTH_URL,
    allowSignup: env.ALLOW_SIGNUP,
    // Cycle 79: Google OAuth client (server-only). Overridden at runtime by
    // NUXT_GOOGLE_CLIENT_ID / NUXT_GOOGLE_CLIENT_SECRET; empty ⇒ Google linking disabled.
    googleClientId: '',
    googleClientSecret: '',
    storageDriver: env.STORAGE_DRIVER ?? 'local',
    storageLocalDir: env.STORAGE_LOCAL_DIR ?? './.data/uploads',
    storageS3: {
      endpoint: env.STORAGE_S3_ENDPOINT,
      region: env.STORAGE_S3_REGION,
      bucket: env.STORAGE_S3_BUCKET,
      accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY
    },
    memoryAutoReviewThreshold: Number(env.MEMORY_AUTO_REVIEW_THRESHOLD ?? 0.75),
    // Capture triage confidence bars, per destination. ALL ship at 1.1 (= never
    // auto-apply) so the pipeline can be calibrated against real captures before it
    // is allowed to write. Lower by hand, one destination at a time, per the spec's
    // rollout. The memory bar is GATED on task f80622b9 (dedup under-catching).
    triageThresholds: {
      // Task lowered to 0.70 on 2026-08-17, the first step of the staged rollout, after a
      // day of reading real proposals in /review. Task is the safest bar to drop first:
      // the action is one row you can delete, and an undo now fully recovers (the courier
      // returns to /input and "Re-triage" puts it back in the sweeper's pool).
      task: 0.70,
      note: 1.1,
      // GATED on MyMind task f80622b9 (enrich-memories dedup under-catching). Triage is a
      // second inlet to the memories table; lowering this before that closes amplifies a
      // known defect, and bad memories degrade recall everywhere, invisibly.
      memory: 1.1,
      append: 1.1
    },
    triageAppendSimilarityFloor: 0.75
  } satisfies Required<CoreRuntimeConfigSource>
}

/** Nitro's env-name rule (scule snakeCase + upper): `storageS3.accessKeyId` → `STORAGE_S3_ACCESS_KEY_ID`. */
function envKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Nitro's runtime override pass (nitropack runtime/internal/utils.env `applyEnv`, with Nuxt's
 * `NUXT_` altPrefix), over an explicit env instead of process.env: for every key (recursively),
 * `NITRO_<KEY>` ?? `NUXT_<KEY>`, parsed with destr, replaces the value; an object-valued override
 * is merged into an object default. Mutates and returns `obj`.
 */
export function applyRuntimeEnv<T extends Record<string, unknown>>(obj: T, env: Env, parentKey = ''): T {
  const o = obj as Record<string, unknown>
  for (const key in o) {
    const subKey = parentKey ? `${parentKey}_${key}` : key
    const name = envKey(subKey)
    const raw = env[`NITRO_${name}`] ?? env[`NUXT_${name}`]
    const envValue = destr(raw) as unknown
    if (isObject(o[key])) {
      if (isObject(envValue)) {
        o[key] = { ...(o[key] as object), ...envValue }
        applyRuntimeEnv(o[key] as Record<string, unknown>, env, subKey)
      } else if (envValue === undefined) {
        applyRuntimeEnv(o[key] as Record<string, unknown>, env, subKey)
      } else {
        o[key] = envValue ?? o[key]
      }
    } else {
      o[key] = envValue ?? o[key]
    }
  }
  return obj
}

export interface HostFacts {
  /** True only in a dev server. Web: Nitro's `import.meta.dev`; worker: see apps/worker/src/env.ts. */
  dev?: boolean
  /** The RUNTIME process env, for the env-backed fields. Defaults to process.env. */
  env?: Env
}

/**
 * Pure mapper: Nuxt runtimeConfig (+ host facts) → CoreConfig. Each runtimeConfig-backed field reads
 * the SAME runtimeConfig key the pre-cycle-80 call site read via useRuntimeConfig(), passed through
 * untouched — no defaults, no coercion; the call sites keep their own `?? fallback`s.
 * test/core-config.test.ts pins every row.
 */
export function fromRuntimeConfig(rc: CoreRuntimeConfigSource, host: HostFacts = {}): CoreConfig {
  const env = host.env ?? process.env
  return {
    databaseUrl: rc.databaseUrl as CoreConfig['databaseUrl'],
    betterAuthSecret: rc.betterAuthSecret as CoreConfig['betterAuthSecret'],
    betterAuthUrl: rc.betterAuthUrl as CoreConfig['betterAuthUrl'],
    allowSignup: rc.allowSignup as CoreConfig['allowSignup'],
    googleClientId: rc.googleClientId as CoreConfig['googleClientId'],
    googleClientSecret: rc.googleClientSecret as CoreConfig['googleClientSecret'],
    storageDriver: rc.storageDriver as CoreConfig['storageDriver'],
    storageLocalDir: rc.storageLocalDir as CoreConfig['storageLocalDir'],
    storageS3: rc.storageS3 as CoreConfig['storageS3'],
    memoryAutoReviewThreshold: rc.memoryAutoReviewThreshold as CoreConfig['memoryAutoReviewThreshold'],
    triageThresholds: rc.triageThresholds as CoreConfig['triageThresholds'],
    triageAppendSimilarityFloor: rc.triageAppendSimilarityFloor as CoreConfig['triageAppendSimilarityFloor'],
    ...envBacked(env),
    dev: host.dev === true
  }
}

/** The env-backed fields, from the runtime env. */
export function envBacked(env: Env, platform: NodeJS.Platform = process.platform): Pick<CoreConfig, typeof ENV_BACKED_FIELDS[number]> {
  return {
    busNs: env[BUS_NS_ENV_NAME] || undefined,
    sandboxRequireFirewall: sandboxRequireFirewall(env, platform),
    sandboxRequireLimits: sandboxRequireLimits(env, platform)
  }
}

/** `SANDBOX_REQUIRE_FIREWALL`: true/1/yes or false/0/no; anything else ⇒ the platform default
 *  (true on Linux — prod LXC — false elsewhere). */
export function sandboxRequireFirewall(env: Env, platform: NodeJS.Platform = process.platform): boolean {
  return linuxDefaultFlag(env.SANDBOX_REQUIRE_FIREWALL, platform)
}

/** `SANDBOX_REQUIRE_LIMITS` (cycle 82 final review I4): refuse the sandbox unless its memory + pids
 *  limits are really enforced (an unprivileged LXC can silently discard them). Same parsing and
 *  platform default as SANDBOX_REQUIRE_FIREWALL. */
export function sandboxRequireLimits(env: Env, platform: NodeJS.Platform = process.platform): boolean {
  return linuxDefaultFlag(env.SANDBOX_REQUIRE_LIMITS, platform)
}

function linuxDefaultFlag(raw: string | undefined, platform: NodeJS.Platform): boolean {
  const v = raw?.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return platform === 'linux'
}

/**
 * The worker's mapper: process env → the CoreConfig the web would build from the same env.
 * = the runtimeConfig nuxt.config would bake from `env` + Nitro's NITRO_/NUXT_ runtime overrides,
 * then `fromRuntimeConfig`.
 */
export function fromEnv(env: Env = process.env, host: Omit<HostFacts, 'env'> = {}): CoreConfig {
  const rc = applyRuntimeEnv(structuredClone(coreRuntimeConfig(env)) as Record<string, unknown>, env)
  return fromRuntimeConfig(rc as CoreRuntimeConfigSource, { ...host, env })
}
