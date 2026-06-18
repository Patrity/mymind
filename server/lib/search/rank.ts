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
 * - rerankScores present → score = raw cross-encoder score; drop below cutoff
 *   UNLESS lexicalExact (exact substring matches are pinned). Sort desc.
 * - rerankScores null (reranker off/failed) → synthetic score = reciprocal lane
 *   rank + a boost for exact matches; NO cutoff (the per-lane cosine floor
 *   already trimmed weak vector hits). Sort desc.
 */
export function rankCandidates(
  candidates: Candidate[],
  rerankScores: Map<string, number> | null,
  cfg: { rerankCutoff: number }
): SearchHit[] {
  const key = (c: Candidate) => `${c.type}:${c.id}`

  const scored = rerankScores
    ? candidates
        .map(c => ({ c, score: rerankScores.get(key(c)) ?? 0 }))
        .filter(({ c, score }) => c.lexicalExact || score >= cfg.rerankCutoff)
    : candidates.map(c => ({ c, score: (c.lexicalExact ? 1 : 0) + 1 / (1 + c.rrfRank) }))

  scored.sort((a, b) => b.score - a.score)

  return scored.map(({ c, score }) => ({
    type: c.type, id: c.id, title: c.title, snippet: c.snippet,
    score: round3(score), to: c.to, icon: c.icon, meta: c.meta
  }))
}
