/** Collapse distance-ordered chunk hits to a deduped, order-preserved list of source ids. */
export function collapseChunksToSources(hits: { sourceId: string }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of hits) {
    if (seen.has(h.sourceId)) continue
    seen.add(h.sourceId)
    out.push(h.sourceId)
  }
  return out
}

/** Like collapseChunksToSources, but carries the best (first-seen) distance per source. */
export function collapseChunksToHits(
  hits: { sourceId: string; distance: number }[]
): { sourceId: string; distance: number }[] {
  const seen = new Set<string>()
  const out: { sourceId: string; distance: number }[] = []
  for (const h of hits) {
    if (seen.has(h.sourceId)) continue
    seen.add(h.sourceId)
    out.push({ sourceId: h.sourceId, distance: h.distance })
  }
  return out
}
