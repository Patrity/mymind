export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const len = a.length
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi; na += ai * ai; nb += bi * bi
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

export interface DedupCandidate { id: string, contentHash: string, embedding: number[] | null }

export function dedupDecision(
  candidate: { contentHash: string, embedding: number[] },
  existing: DedupCandidate[],
  opts: { threshold?: number } = {}
): { action: 'insert' | 'merge' | 'skip', mergeId?: string } {
  const threshold = opts.threshold ?? 0.85
  // exact hash match -> skip (already stored, identical)
  const exact = existing.find(e => e.contentHash === candidate.contentHash)
  if (exact) return { action: 'skip', mergeId: exact.id }
  // semantic near-duplicate -> merge evidence into the closest above threshold
  let best: { id: string, sim: number } | null = null
  for (const e of existing) {
    if (!e.embedding) continue
    const sim = cosine(candidate.embedding, e.embedding)
    if (sim >= threshold && (!best || sim > best.sim)) best = { id: e.id, sim }
  }
  if (best) return { action: 'merge', mergeId: best.id }
  return { action: 'insert' }
}
