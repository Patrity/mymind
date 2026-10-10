import type { CoreConfig } from '@mymind/core/config'

/** The slice of Nuxt runtimeConfig that core reads, keyed exactly as nuxt.config.ts declares it. */
export type CoreRuntimeConfigSource = { [K in keyof CoreConfig]?: unknown }

/**
 * Pure mapper: Nuxt runtimeConfig → CoreConfig. Each field reads the SAME runtimeConfig key the
 * pre-cycle-80 call site read via useRuntimeConfig(), so prod (where NUXT_* env vars override
 * those keys at runtime) behaves identically. Values pass through untouched — no defaults, no
 * coercion; the call sites keep their own `?? fallback`s. test/core-config.test.ts pins every row.
 */
export function fromRuntimeConfig(rc: CoreRuntimeConfigSource): CoreConfig {
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
    triageAppendSimilarityFloor: rc.triageAppendSimilarityFloor as CoreConfig['triageAppendSimilarityFloor']
  }
}
