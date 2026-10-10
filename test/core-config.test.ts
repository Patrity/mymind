// Cycle 80 Task 2: fromRuntimeConfig must read each CoreConfig field from the SAME runtimeConfig
// key the pre-extraction call site read via useRuntimeConfig() (prod overrides those keys at
// runtime via NUXT_* env vars, so a renamed source key would silently change prod behaviour).
// One row per field; each source key carries a unique sentinel so a crossed wire is caught.
import { describe, it, expect } from 'vitest'
import { fromRuntimeConfig } from '../server/utils/core-config'

// [CoreConfig field, runtimeConfig key the old code read, old call site]
const ROWS: Array<[string, string, string]> = [
  ['databaseUrl', 'databaseUrl', 'server/db/index.ts useDb'],
  ['betterAuthSecret', 'betterAuthSecret', 'server/utils/auth.ts buildAuth'],
  ['betterAuthUrl', 'betterAuthUrl', 'server/utils/auth.ts buildAuth + lib/channels/email/channel.ts appOrigin'],
  ['allowSignup', 'allowSignup', 'server/utils/auth.ts buildAuth'],
  ['googleClientId', 'googleClientId', 'server/lib/google/scopes.ts + utils/auth.ts'],
  ['googleClientSecret', 'googleClientSecret', 'server/lib/google/scopes.ts + utils/auth.ts'],
  ['storageDriver', 'storageDriver', 'server/utils/storage/index.ts'],
  ['storageLocalDir', 'storageLocalDir', 'server/utils/storage/index.ts'],
  ['storageS3', 'storageS3', 'server/utils/storage/index.ts'],
  ['memoryAutoReviewThreshold', 'memoryAutoReviewThreshold', 'server/services/memory.ts createMemory'],
  ['triageThresholds', 'triageThresholds', 'server/services/triage.ts triageCapture'],
  ['triageAppendSimilarityFloor', 'triageAppendSimilarityFloor', 'server/services/triage.ts resolveAppendTarget']
]

function sentinelRuntimeConfig(): Record<string, unknown> {
  const rc: Record<string, unknown> = { unrelatedKey: 'must-not-leak', public: { allowSignup: 'public-not-server' } }
  for (const [, key] of ROWS) rc[key] = { sentinel: key }
  return rc
}

describe('fromRuntimeConfig', () => {
  it.each(ROWS)('%s reads runtimeConfig.%s (%s)', (field, key) => {
    const rc = sentinelRuntimeConfig()
    const cfg = fromRuntimeConfig(rc) as unknown as Record<string, unknown>
    // Same reference: passed through untouched (no coercion, no defaults).
    expect(cfg[field]).toBe(rc[key])
  })

  it('maps exactly the CoreConfig fields — nothing more', () => {
    const cfg = fromRuntimeConfig(sentinelRuntimeConfig())
    expect(Object.keys(cfg).sort()).toEqual(ROWS.map(r => r[0]).sort())
  })

  it('passes absent keys through as undefined (old code saw undefined too)', () => {
    const cfg = fromRuntimeConfig({}) as unknown as Record<string, unknown>
    for (const [field] of ROWS) expect(cfg[field]).toBeUndefined()
  })
})
