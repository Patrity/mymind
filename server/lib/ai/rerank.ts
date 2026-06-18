/**
 * Optional cross-encoder reranker (TEI /rerank).
 *
 * Disabled unless a model is assigned to the 'rerank' usage in the AI config
 * registry (Settings). The caller resolves baseURL/apiKey/model and skips
 * reranking when the usage is unconfigured.
 *
 * Returns RAW relevance scores (no normalisation) so callers can apply an
 * absolute cutoff. THROWS on network/parse failure — callers choose the fallback.
 */

export interface RerankDoc { id: string; text: string }
export interface RerankResult { id: string; score: number }

/** Pure: map a TEI /rerank response to {id,score}[] sorted desc by raw score. */
export function parseRerankResponse(raw: unknown, ids: string[]): RerankResult[] {
  const arr = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : null)
  if (!arr) throw new Error(`Unexpected rerank response shape: ${JSON.stringify(raw)}`)
  const out: RerankResult[] = []
  // The rig returns `score` (Task-1 spike); accept `relevance_score` too for TEI variants.
  for (const r of arr as Array<{ index?: number; score?: number; relevance_score?: number }>) {
    const id = typeof r.index === 'number' ? ids[r.index] : undefined
    const score = typeof r.score === 'number' ? r.score
      : (typeof r.relevance_score === 'number' ? r.relevance_score : undefined)
    if (id === undefined || score === undefined) continue
    out.push({ id, score })
  }
  return out.sort((a, b) => b.score - a.score)
}

export async function rerank(
  query: string,
  docs: RerankDoc[],
  baseUrl: string,
  apiKey: string,
  model = 'Qwen3-Reranker-0.6B'
): Promise<RerankResult[]> {
  if (!docs.length) return []
  const raw = await $fetch(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: { model, query, documents: docs.map(d => d.text), return_documents: false },
    timeout: 5000
  })
  return parseRerankResponse(raw, docs.map(d => d.id))
}
