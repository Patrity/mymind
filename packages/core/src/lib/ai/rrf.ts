/**
 * Reciprocal Rank Fusion
 * score(id) = sum over lanes of 1/(k + rank). Higher = better.
 * Deduplicates within each lane (first occurrence wins) and across lanes.
 */
export function rrfFuse(lanes: string[][], k = 60): string[] {
  const score = new Map<string, number>()
  for (const lane of lanes) {
    const seen = new Set<string>()
    lane.forEach((id, rank) => {
      if (seen.has(id)) return
      seen.add(id)
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}
