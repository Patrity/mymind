// server/lib/ai/registry/store.ts
// Thin DB I/O for the single ai_config JSONB row + an in-process cache.
// Single instance, so a module-level cache with explicit invalidation is enough.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { settings } from '../../../db/schema'
import { parseConfig } from './schema'
import { emptyDoc, type AiConfigDoc } from './types'

const KEY = 'ai_config'
let cache: AiConfigDoc | null = null

export async function loadConfig(): Promise<AiConfigDoc> {
  if (cache) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = row ? parseConfig(row.value) : emptyDoc()
  return cache
}

export async function saveConfig(doc: AiConfigDoc): Promise<void> {
  const validated = parseConfig(doc)  // re-validate before persisting
  const db = useDb()
  await db.insert(settings)
    .values({ key: KEY, value: validated, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: validated, updatedAt: new Date() } })
  cache = validated
}

export function invalidate(): void { cache = null }
/** Test seam (cycle 81 worker child): put a doc in this process's cache WITHOUT writing the shared
 *  row, so a test can tell a cached read from a DB read. */
export function _setConfigCacheForTests(doc: AiConfigDoc | null): void { cache = doc }
