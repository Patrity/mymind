import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { settings } from '@mymind/core/db/schema'

export interface ChunkingConfig {
  contextual: boolean   // run the LLM contextualization step
  targetTokens: number
  maxTokens: number
  overlapTokens: number
  embedBatch: number    // ≤ TEI max_client_batch_size
  // Stack review 2026-10-19 (D1): bounds on the contextualization prompt. Before these, every
  // chunk's call carried the WHOLE document (avg 23.8 K prompt tokens, 48 % of MyMind's volume).
  /** Max document tokens sent per contextualize call (the chunk's section + neighbours + title). */
  contextWindowTokens: number
  /** Whole chunks either side of the target included in that window. */
  contextNeighbours: number
  /** Documents under this many tokens (or with a single chunk) are not contextualized at all. */
  contextMinDocTokens: number
}

const DEFAULTS: ChunkingConfig = {
  contextual: true, targetTokens: 300, maxTokens: 512, overlapTokens: 32, embedBatch: 32,
  contextWindowTokens: 6000, contextNeighbours: 2, contextMinDocTokens: 1500
}
const KEY = 'chunking'

export async function getChunkingConfig(): Promise<ChunkingConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const v = (row?.value ?? {}) as Partial<ChunkingConfig>
  return { ...DEFAULTS, ...v }
}
