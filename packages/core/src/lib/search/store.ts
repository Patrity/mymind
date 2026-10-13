// server/lib/search/store.ts
// Thin DB I/O for the single search_config JSONB row + the search.brave.qps row + an in-process cache.
// Mirrors server/lib/ai/registry/store.ts: module-level cache, explicit invalidation.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret } from '../ai/registry/crypto'
import type { SearchConfig } from './types'
import { processCache } from '../eval/context'
import { DEFAULT_BRAVE_QPS } from './limiter'

const KEY = 'search_config'
export const QPS_KEY = 'search.brave.qps'
export const MAX_BRAVE_QPS = 50
const cache = processCache<SearchConfig>() // cycle 85: bypassed in an eval world

export function validQps(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_BRAVE_QPS
}

/** Normalise any stored shape to the Brave-only config. A legacy `provider: 'searxng'` doc (or any
 *  unknown provider) resolves to Brave; its searxngUrl is dropped; the Brave key is preserved. */
export function normalizeSearchConfig(raw: unknown, qps?: unknown): SearchConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { braveApiKeyEnc?: unknown }
  return {
    provider: 'brave',
    ...(typeof r.braveApiKeyEnc === 'string' && r.braveApiKeyEnc ? { braveApiKeyEnc: r.braveApiKeyEnc } : {}),
    braveQps: validQps(qps) ? qps : DEFAULT_BRAVE_QPS,
  }
}

export async function loadSearchConfig(): Promise<SearchConfig> {
  const hit = cache.get()
  if (hit) return hit
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const [qpsRow] = await db.select().from(settings).where(eq(settings.key, QPS_KEY)).limit(1)
  const loaded = normalizeSearchConfig(row?.value, qpsRow?.value)
  cache.set(loaded)
  return loaded
}

export async function saveSearchConfig(input: {
  braveApiKey?: string
  braveQps?: number
}): Promise<void> {
  // Load existing to preserve fields not being updated (especially braveApiKeyEnc)
  const current = await loadSearchConfig()
  const next: SearchConfig = { ...current, provider: 'brave' }

  // Encrypt the new key if provided and non-empty; otherwise keep existing enc
  if (input.braveApiKey && input.braveApiKey.trim().length > 0) {
    next.braveApiKeyEnc = encryptSecret(input.braveApiKey)
  }
  if (input.braveQps !== undefined) {
    if (!validQps(input.braveQps)) throw new Error(`braveQps must be a number in (0, ${MAX_BRAVE_QPS}]`)
    next.braveQps = input.braveQps
  }

  const { braveQps, ...doc } = next // the qps lives in its own settings row
  const now = new Date()
  await useDb().transaction(async (tx) => {
    await tx.insert(settings)
      .values({ key: KEY, value: doc, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: doc, updatedAt: now } })
    await tx.insert(settings)
      .values({ key: QPS_KEY, value: braveQps, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: braveQps, updatedAt: now } })
  })
  cache.set(next)
}

export function invalidateSearchConfig(): void {
  cache.set(null)
}
