import type { SearchHit, SearchHitType } from '../../../shared/types/search'

export interface Candidate {
  type: SearchHitType
  id: string
  title: string
  snippet: string | null
  to: string
  icon: string
  meta: string | null
  rerankText: string     // text fed to the cross-encoder
  lexicalExact: boolean  // matched an exact substring → never dropped by the cutoff
  rrfRank: number        // 0-based position within its lane (fallback ordering)
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Rank candidates into the final SearchHit list.
 *
 * - rerankScores present → score = raw cross-encoder score; sort desc; keep a
 *   candidate iff lexicalExact OR score >= relBand × topScore (a RELATIVE band
 *   anchored to the query's own top hit — robust to the reranker's
 *   length-dependent absolute scale); then cap to topK.
 * - rerankScores null (reranker off/failed) → synthetic score = reciprocal lane
 *   rank + a boost for exact matches; sort desc; cap to topK (no band).
 *
 * Empty state is retrieval-based: a non-empty pool always yields ≥1 hit (the top
 * clears its own relative band), so [] ⟺ the candidate pool was empty.
 */
export function rankCandidates(
  candidates: Candidate[],
  rerankScores: Map<string, number> | null,
  cfg: { topK: number; relBand: number }
): SearchHit[] {
  const key = (c: Candidate) => `${c.type}:${c.id}`

  let scored: Array<{ c: Candidate; score: number }>
  if (rerankScores) {
    scored = candidates
      .map(c => ({ c, score: rerankScores.get(key(c)) ?? 0 }))
      .sort((a, b) => b.score - a.score)
    const topScore = scored.length ? scored[0]!.score : 0
    const threshold = cfg.relBand * topScore
    scored = scored.filter(({ c, score }) => c.lexicalExact || score >= threshold)
  } else {
    scored = candidates
      .map(c => ({ c, score: (c.lexicalExact ? 1 : 0) + 1 / (1 + c.rrfRank) }))
      .sort((a, b) => b.score - a.score)
  }

  return scored.slice(0, cfg.topK).map(({ c, score }) => ({
    type: c.type, id: c.id, title: c.title, snippet: c.snippet,
    score: round3(score), to: c.to, icon: c.icon, meta: c.meta
  }))
}
