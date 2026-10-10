// @mymind/core config: the one piece of host-provided state core code reads instead of
// reaching into Nuxt/Nitro runtime config directly (see global-constraints: core must never
// import Nuxt/Nitro runtime). The app calls initCore() once at startup; core modules call
// coreConfig() to read it.
//
// CoreConfig is exactly the union of the runtime-config fields the core closure reads — no
// speculative fields. Each field is named after the Nuxt runtimeConfig key it replaces (see
// server/utils/core-config.ts fromRuntimeConfig, whose table test pins every source key), and is
// typed as the old call site cast it: values pass through untouched, no coercion or defaults.
export interface CoreConfig {
  /** server/db/index.ts — the Postgres connection string. */
  databaseUrl: string | undefined
  /** server/lib/auth — better-auth signing secret. */
  betterAuthSecret: string | undefined
  /** server/lib/auth + lib/channels/email — the app's public origin. */
  betterAuthUrl: string | undefined
  /** server/lib/auth — raw value; compared via String(x) === 'true' (string at build, boolean at runtime). */
  allowSignup: string | boolean | undefined
  /** server/lib/google/scopes + lib/auth — Google OAuth client ('' ⇒ Google disabled). */
  googleClientId: string
  googleClientSecret: string
  /** server/utils/storage — 'local' | 's3'. */
  storageDriver: string
  storageLocalDir: string
  storageS3: {
    endpoint?: string
    region?: string
    bucket?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
  /** server/services/memory.ts createMemory. */
  memoryAutoReviewThreshold: number
  /** server/services/triage.ts — per-destination auto-apply bars. */
  triageThresholds: Record<string, number>
  triageAppendSimilarityFloor: number
}

let config: CoreConfig | undefined

export function initCore(cfg: CoreConfig): void {
  if (config !== undefined) {
    if (isDeepEqual(config, cfg)) {
      return
    }
    throw new Error('core already initialised with a different config')
  }
  config = cfg
}

export function coreConfig(): CoreConfig {
  if (config === undefined) {
    throw new Error('core not initialised — call initCore() first')
  }
  return config
}

// Test-only: resets module-level state between tests. Not exported from the package's
// public surface beyond this module — tests import it directly from './config'.
export function _resetCoreForTests(): void {
  config = undefined
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  )
}
