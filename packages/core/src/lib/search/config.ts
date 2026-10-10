import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export interface SearchRelevanceConfig {
  rerankTopK: number         // max hits returned (top-k cap, both reranked + fallback paths)
  rerankRelBand: number      // reranked: keep hits with score >= rerankRelBand * topScore (0..1)
  cosineFloor: number        // max cosine distance kept per vector lane (drop distance > floor)
  candidatesPerLane: number  // top-K per lane fed to the aggregator
  maxCandidates: number      // cap on the pool sent to the reranker
}

// Defaults are deliberately permissive: cosineFloor 1.0 keeps anything more similar
// than orthogonal (hides nothing before tuning). The rerank cutoff is RELATIVE
// (rerankRelBand × the query's own top score) so it's robust to the reranker's
// length-dependent score scale; rerankTopK bounds the palette list. Tune via the
// `search_relevance` settings key (no redeploy).
const DEFAULTS: SearchRelevanceConfig = {
  rerankTopK: 12, rerankRelBand: 0.6, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
}
const KEY = 'search_relevance'

export function mergeSearchConfig(raw: Partial<SearchRelevanceConfig> | null | undefined): SearchRelevanceConfig {
  return { ...DEFAULTS, ...(raw ?? {}) }
}

export async function getSearchConfig(): Promise<SearchRelevanceConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return mergeSearchConfig(row?.value as Partial<SearchRelevanceConfig> | undefined)
}
