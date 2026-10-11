// Cycle 80 Task 2: fromRuntimeConfig must read each CoreConfig field from the SAME runtimeConfig
// key the pre-extraction call site read via useRuntimeConfig() (prod overrides those keys at
// runtime via NUXT_* env vars, so a renamed source key would silently change prod behaviour).
// One row per field; each source key carries a unique sentinel so a crossed wire is caught.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import { fromRuntimeConfig } from '../server/utils/core-config'
import { coreRuntimeConfig, ENV_BACKED_FIELDS, fromEnv } from '@mymind/core/config-env'

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
    const cfg = fromRuntimeConfig(sentinelRuntimeConfig(), { env: {} })
    // Cycle 81: + the env-backed fields and the `dev` host flag (never runtimeConfig keys).
    expect(Object.keys(cfg).sort()).toEqual([...ROWS.map(r => r[0]), ...ENV_BACKED_FIELDS, 'dev'].sort())
  })

  it('passes absent keys through as undefined (old code saw undefined too)', () => {
    const cfg = fromRuntimeConfig({}) as unknown as Record<string, unknown>
    for (const [field] of ROWS) expect(cfg[field]).toBeUndefined()
  })

  it('env-backed fields come from the RUNTIME env, never from runtimeConfig; dev from the host', () => {
    const rc = { ...sentinelRuntimeConfig(), busNs: 'baked-ns', agentExecutor: 'worker' }
    const cfg = fromRuntimeConfig(rc, { env: { MYMIND_BUS_NS: 'live-ns', AGENT_EXECUTOR: 'worker' }, dev: true })
    expect(cfg.busNs).toBe('live-ns')
    expect(cfg.agentExecutor).toBe('worker')
    expect(cfg.dev).toBe(true)
    const plain = fromRuntimeConfig(rc, { env: { AGENT_EXECUTOR: 'Worker ' } })
    expect(plain).toMatchObject({ busNs: undefined, agentExecutor: 'web', dev: false })
  })
})

// Cycle 81 Task 2: the worker maps its env with `fromEnv`; the web gets runtimeConfig = what
// nuxt.config bakes at build (coreRuntimeConfig(buildEnv), spread into runtimeConfig) + Nitro's
// runtime NITRO_/NUXT_ overrides. For the same env the two must yield the SAME CoreConfig. The web
// side runs Nitro's OWN applyEnv (nitropack runtime/internal/utils.env, with Nuxt's `NUXT_`
// altPrefix), so a drift between core's copy and Nitro's real rules turns this red.
const nitroRequire = createRequire(createRequire(import.meta.url).resolve('nuxt/package.json'))
const nitroEnvPath = join(dirname(nitroRequire.resolve('nitropack/package.json')), 'dist/runtime/internal/utils.env.mjs')
type NitroApplyEnv = (obj: Record<string, unknown>, opts: { prefix: string; altPrefix: string; envExpansion?: boolean }) => Record<string, unknown>
let nitroApplyEnv: NitroApplyEnv

/** What the web would see: build-baked runtimeConfig, then Nitro's runtime env pass over `env`. */
function webConfig(env: Record<string, string>) {
  const baked = structuredClone(coreRuntimeConfig(env)) as Record<string, unknown>
  const saved = process.env
  process.env = { ...env } // Nitro's getEnv reads process.env directly
  try {
    const rc = nitroApplyEnv(baked, { prefix: 'NITRO_', altPrefix: 'NUXT_' })
    return fromRuntimeConfig(rc, { env, dev: false })
  } finally { process.env = saved }
}

const BASE = {
  DATABASE_URL: 'postgres://u:p@db:5432/mymind',
  BETTER_AUTH_SECRET: 's3cret',
  BETTER_AUTH_URL: 'http://localhost:3000',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: './.data/uploads',
  MEMORY_AUTO_REVIEW_THRESHOLD: '0.75'
}

// [case, env, spot-checks on the resulting CoreConfig — so equality can't pass vacuously]
const ENV_ROWS: Array<[string, Record<string, string>, Partial<Record<string, unknown>>]> = [
  ['empty env (all defaults)', {}, { storageDriver: 'local', storageLocalDir: './.data/uploads', memoryAutoReviewThreshold: 0.75, databaseUrl: undefined, agentExecutor: 'web', busNs: undefined }],
  ['plain dev .env', BASE, { databaseUrl: BASE.DATABASE_URL, betterAuthSecret: 's3cret' }],
  ['prod native: NUXT_DATABASE_URL / NUXT_STORAGE_LOCAL_DIR win over the plain vars',
    { ...BASE, NUXT_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/mymind', NUXT_STORAGE_LOCAL_DIR: '/opt/mymind/.data/uploads' },
    { databaseUrl: 'postgres://u:p@127.0.0.1:5432/mymind', storageLocalDir: '/opt/mymind/.data/uploads' }],
  ['NITRO_ beats NUXT_', { ...BASE, NUXT_DATABASE_URL: 'postgres://nuxt', NITRO_DATABASE_URL: 'postgres://nitro' }, { databaseUrl: 'postgres://nitro' }],
  ['Google client only via NUXT_', { ...BASE, GOOGLE_CLIENT_ID: 'ignored', NUXT_GOOGLE_CLIENT_ID: 'cid', NUXT_GOOGLE_CLIENT_SECRET: 'csec' }, { googleClientId: 'cid', googleClientSecret: 'csec' }],
  ['allowSignup: plain string at build, destr boolean via NUXT_', { ...BASE, ALLOW_SIGNUP: 'true' }, { allowSignup: 'true' }],
  ['allowSignup NUXT_ override parses to a boolean', { ...BASE, ALLOW_SIGNUP: 'false', NUXT_ALLOW_SIGNUP: 'true' }, { allowSignup: true }],
  ['numbers: plain at build (Number), NUXT_ via destr', { ...BASE, MEMORY_AUTO_REVIEW_THRESHOLD: '0.6', NUXT_TRIAGE_APPEND_SIMILARITY_FLOOR: '0.9' }, { memoryAutoReviewThreshold: 0.6, triageAppendSimilarityFloor: 0.9 }],
  ['nested leaf + whole-object JSON merge', { ...BASE, NUXT_TRIAGE_THRESHOLDS: '{"note":0.8}', NUXT_TRIAGE_THRESHOLDS_TASK: '0.5' }, { triageThresholds: { task: 0.5, note: 0.8, memory: 1.1, append: 1.1 } }],
  ['S3: plain at build, NUXT_STORAGE_S3_* leaf overrides',
    { ...BASE, STORAGE_DRIVER: 's3', STORAGE_S3_REGION: 'us-east-1', STORAGE_S3_BUCKET: 'plain', NUXT_STORAGE_S3_BUCKET: 'over', NUXT_STORAGE_S3_ACCESS_KEY_ID: 'AK' },
    { storageDriver: 's3', storageS3: { endpoint: undefined, region: 'us-east-1', bucket: 'over', accessKeyId: 'AK', secretAccessKey: undefined } }],
  ['env-backed: MYMIND_BUS_NS + AGENT_EXECUTOR=worker', { ...BASE, MYMIND_BUS_NS: 'w2', AGENT_EXECUTOR: 'worker' }, { busNs: 'w2', agentExecutor: 'worker' }],
  ['env-backed: an unknown AGENT_EXECUTOR is web in both', { ...BASE, AGENT_EXECUTOR: 'both' }, { agentExecutor: 'web' }]
]

describe('fromEnv (worker) ≡ fromRuntimeConfig over Nitro runtimeConfig (web)', () => {
  beforeAll(async () => {
    nitroApplyEnv = (await import(pathToFileURL(nitroEnvPath).href)).applyEnv as NitroApplyEnv
  })

  it.each(ENV_ROWS)('%s', (_name, env, expected) => {
    const worker = fromEnv(env)
    expect(worker).toEqual(webConfig(env))
    expect(worker).toMatchObject(expected)
    expect(worker.dev).toBe(false)
  })

  it('fromEnv passes the host dev flag through', () => {
    expect(fromEnv(BASE, { dev: true }).dev).toBe(true)
  })
})
