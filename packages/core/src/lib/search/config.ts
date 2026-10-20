import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export interface SearchRelevanceConfig {
  rerankTopK: number         // max hits returned (top-k cap, both reranked + fallback paths)
  rerankRelBand: number      // reranked: keep hits with score >= rerankRelBand * topScore (0..1)
  cosineFloor: number        // max cosine distance kept per vector lane (drop distance > floor)
  candidatesPerLane: number  // top-K per lane fed to the aggregator
  maxCandidates: number      // cap on the pool sent to the reranker
  /** Floor for `SET LOCAL hnsw.ef_search` on every vector lane; the effective value is
   *  max(this, 2 × the lane's LIMIT), capped at pgvector's 1000. pgvector's default of 40 made a
   *  `LIMIT 50` lane physically unable to return more than ~40 rows (2026-10-19 stack review). */
  hnswEfSearchMin: number
  /** `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` on lanes that carry a scope/project/session
   *  filter, so a filtered HNSW scan keeps walking instead of returning fewer than LIMIT rows.
   *  Only applied when the connected pgvector is >= 0.8 (probed once per process). */
  hnswIterativeScan: boolean
  /** Use the `tsv` (websearch_to_tsquery + ts_rank_cd) lexical lane. `false` is the kill switch
   *  back to the pre-migration ILIKE + pg_trgm lane — no redeploy, no schema change. */
  lexicalFts: boolean
}

// Defaults are deliberately permissive: cosineFloor 1.0 keeps anything more similar
// than orthogonal (hides nothing before tuning). The rerank cutoff is RELATIVE
// (rerankRelBand × the query's own top score) so it's robust to the reranker's
// length-dependent score scale; rerankTopK bounds the palette list. Tune via the
// `search_relevance` settings key (no redeploy).
const DEFAULTS: SearchRelevanceConfig = {
  rerankTopK: 12, rerankRelBand: 0.6, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50,
  hnswEfSearchMin: 100, hnswIterativeScan: true, lexicalFts: true
}
const KEY = 'search_relevance'

export function mergeSearchConfig(raw: Partial<SearchRelevanceConfig> | null | undefined): SearchRelevanceConfig {
  return { ...DEFAULTS, ...(raw ?? {}) }
}

export async function getSearchConfig(): Promise<SearchRelevanceConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return mergeSearchConfig(row?.value as Partial<SearchRelevanceConfig> | undefined)
}
