/**
 * Optional cross-encoder reranker.
 *
 * Disabled by default (aiRerankBaseUrl = '' in runtimeConfig).
 * Set AI_RERANK_BASE_URL env var to enable (e.g. http://192.168.2.25:8883).
 *
 * On any failure the caller falls back to RRF-rank relevance — this module
 * never throws.
 */

export interface RerankDoc {
  id: string
  text: string
}

export interface RerankResult {
  id: string
  score: number
}

/**
 * Rerank a list of documents against a query using a cross-encoder.
 * Returns results ordered by score descending with normalised scores [0,1].
 * Falls back to returning the original order with evenly-spaced scores on error.
 */
export async function rerank(
  query: string,
  docs: RerankDoc[],
  baseUrl: string,
  apiKey: string
): Promise<RerankResult[]> {
  if (!docs.length) return []

  try {
    const res = await $fetch<{ results: Array<{ index: number, relevance_score: number }> }>(
      `${baseUrl}/rerank`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: {
          model: 'Qwen3-Reranker-0.6B',
          query,
          documents: docs.map(d => d.text),
          return_documents: false
        },
        timeout: 5000
      }
    )

    const scored = res.results.map(r => ({
      id: docs[r.index]!.id,
      score: r.relevance_score
    }))

    // Normalise scores to [0,1] via min-max
    const scores = scored.map(s => s.score)
    const min = Math.min(...scores)
    const max = Math.max(...scores)
    const range = max - min

    return scored
      .map(s => ({
        id: s.id,
        score: range > 0 ? Math.round(((s.score - min) / range) * 1000) / 1000 : 1.0
      }))
      .sort((a, b) => b.score - a.score)
  } catch (err) {
    console.warn('[rerank] reranker failed, falling back to original order:', err)
    // Fall back: return original order with rank-based scores
    return docs.map((d, i) => ({
      id: d.id,
      score: Math.round((1 / (1 + i)) * 1000) / 1000
    }))
  }
}
