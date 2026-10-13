// Real-Postgres test: a stored `provider: searxng` doc resolves to Brave, qps persists in its own row.
// Touches the shared dev DB's search rows, so it snapshots and restores them. Run with `pnpm test:db`.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { inArray, eq } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('@mymind/core/db')
const { settings } = await import('@mymind/core/db/schema')
const { loadSearchConfig, saveSearchConfig, invalidateSearchConfig, QPS_KEY } = await import('@mymind/core/lib/search/store')
const { encryptSecret } = await import('@mymind/core/lib/ai/registry/crypto')
const { searchProvider } = await import('@mymind/core/lib/search/resolve')

const KEYS = ['search_config', QPS_KEY]
const ENC = encryptSecret('brave-test-key')
let snapshot: Array<typeof settings.$inferSelect> = []

async function put(key: string, value: unknown) {
  await useDb().insert(settings).values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

describe('search config store (real DB)', () => {
  beforeAll(async () => {
    snapshot = await useDb().select().from(settings).where(inArray(settings.key, KEYS))
  })
  afterAll(async () => {
    const db = useDb()
    await db.delete(settings).where(inArray(settings.key, KEYS))
    for (const r of snapshot) await put(r.key, r.value)
    invalidateSearchConfig()
  })

  it('resolves a stored searxng doc to Brave with no error, keeping the key', async () => {
    await put('search_config', { provider: 'searxng', searxngUrl: 'http://searxng:8080', braveApiKeyEnc: ENC })
    await useDb().delete(settings).where(eq(settings.key, QPS_KEY))
    invalidateSearchConfig()
    expect(await loadSearchConfig()).toEqual({ provider: 'brave', braveApiKeyEnc: ENC, braveQps: 1 })
    await expect(searchProvider()).resolves.toHaveProperty('search')
  })

  it('persists qps in search.brave.qps and rewrites the doc without searxng fields', async () => {
    await saveSearchConfig({ braveQps: 2 })
    invalidateSearchConfig()
    expect((await loadSearchConfig()).braveQps).toBe(2)
    const [doc] = await useDb().select().from(settings).where(eq(settings.key, 'search_config'))
    expect(doc!.value).toEqual({ provider: 'brave', braveApiKeyEnc: ENC })
    const [q] = await useDb().select().from(settings).where(eq(settings.key, QPS_KEY))
    expect(q!.value).toBe(2)
  })

  it('rejects an invalid qps', async () => {
    await expect(saveSearchConfig({ braveQps: 0 })).rejects.toThrow(/braveQps/)
  })
})
