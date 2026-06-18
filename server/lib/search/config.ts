import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export interface SearchRelevanceConfig {
  rerankCutoff: number       // raw rerank-score floor when reranking (drop below, unless lexicalExact)
  cosineFloor: number        // max cosine distance kept per vector lane (drop distance > floor)
  candidatesPerLane: number  // top-K per lane fed to the aggregator
  maxCandidates: number      // cap on the pool sent to the reranker
}

// Defaults are deliberately permissive: cosineFloor 1.0 keeps anything more
// similar than orthogonal (hides nothing before tuning); the reranker + the
// exact-match pin do the precision work. Tune down via the `search_relevance`
// settings key once the live corpus is observed (no redeploy).
const DEFAULTS: SearchRelevanceConfig = {
  rerankCutoff: 0.2, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
}
const KEY = 'search_relevance'

export function mergeSearchConfig(raw: Partial<SearchRelevanceConfig> | null | undefined): SearchRelevanceConfig {
  return { ...DEFAULTS, ...(raw ?? {}) }
}

export async function getSearchConfig(): Promise<SearchRelevanceConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return mergeSearchConfig(row?.value as Partial<SearchRelevanceConfig> | undefined)
}
