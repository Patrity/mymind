// server/lib/search/store.ts
// Thin DB I/O for the single search_config JSONB row + an in-process cache.
// Mirrors server/lib/ai/registry/store.ts: module-level cache, explicit invalidation.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret } from '../ai/registry/crypto'
import type { SearchConfig } from './types'

const KEY = 'search_config'
let cache: SearchConfig | null = null

function defaultConfig(): SearchConfig {
  return {
    provider: 'searxng',
    searxngUrl: process.env.SEARCH_SEARXNG_URL || 'http://searxng:8080',
  }
}

export async function loadSearchConfig(): Promise<SearchConfig> {
  if (cache) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = row ? (row.value as SearchConfig) : defaultConfig()
  return cache
}

export async function saveSearchConfig(input: {
  provider?: 'searxng' | 'brave'
  searxngUrl?: string
  braveApiKey?: string
}): Promise<void> {
  // Load existing to preserve fields not being updated (especially braveApiKeyEnc)
  const current = await loadSearchConfig()

  const next: SearchConfig = {
    provider: input.provider ?? current.provider,
    searxngUrl: input.searxngUrl ?? current.searxngUrl,
    braveApiKeyEnc: current.braveApiKeyEnc,
  }

  // Encrypt the new key if provided and non-empty; otherwise keep existing enc
  if (input.braveApiKey && input.braveApiKey.trim().length > 0) {
    next.braveApiKeyEnc = encryptSecret(input.braveApiKey)
  }

  const db = useDb()
  await db.insert(settings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache = next
}

export function invalidateSearchConfig(): void {
  cache = null
}
