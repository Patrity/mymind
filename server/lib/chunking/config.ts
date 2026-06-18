import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export interface ChunkingConfig {
  contextual: boolean   // run the LLM contextualization step
  targetTokens: number
  maxTokens: number
  overlapTokens: number
  embedBatch: number    // ≤ TEI max_client_batch_size
}

const DEFAULTS: ChunkingConfig = { contextual: true, targetTokens: 300, maxTokens: 512, overlapTokens: 32, embedBatch: 32 }
const KEY = 'chunking'

export async function getChunkingConfig(): Promise<ChunkingConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const v = (row?.value ?? {}) as Partial<ChunkingConfig>
  return { ...DEFAULTS, ...v }
}
