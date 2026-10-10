/**
 * Deduplicate, normalise (trim + lowercase), filter blanks, and cap to `max` tags.
 * First occurrence of each normalised tag wins; order is preserved.
 */
export function capTags(tags: string[], max = 10): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (out.length >= max) break
    const t = raw.trim().toLowerCase()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
