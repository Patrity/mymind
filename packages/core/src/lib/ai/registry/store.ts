// server/lib/ai/registry/store.ts
// Thin DB I/O for the single ai_config JSONB row + an in-process cache.
// Single instance, so a module-level cache with explicit invalidation is enough.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { settings } from '../../../db/schema'
import { parseConfig } from './schema'
import { emptyDoc, type AiConfigDoc } from './types'
import { processCache } from '../../eval/context'

const KEY = 'ai_config'
const cache = processCache<AiConfigDoc>() // cycle 85: bypassed in an eval world

export async function loadConfig(): Promise<AiConfigDoc> {
  const hit = cache.get()
  if (hit) return hit
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const loaded = row ? parseConfig(row.value) : emptyDoc()
  cache.set(loaded)
  return loaded
}

export async function saveConfig(doc: AiConfigDoc): Promise<void> {
  const validated = parseConfig(doc)  // re-validate before persisting
  const db = useDb()
  await db.insert(settings)
    .values({ key: KEY, value: validated, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: validated, updatedAt: new Date() } })
  cache.set(validated)
}

export function invalidate(): void { cache.set(null) }
/** Test seam (cycle 81 worker child): put a doc in this process's cache WITHOUT writing the shared
 *  row, so a test can tell a cached read from a DB read. */
export function _setConfigCacheForTests(doc: AiConfigDoc | null): void { cache.set(doc) }
