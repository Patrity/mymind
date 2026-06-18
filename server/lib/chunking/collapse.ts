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
