// server/lib/agent/reflect/similarity.ts
//
// Content similarity for the rejection memory (spec §5.3): a proposal close to one Tony rejected
// in the last 30 days is dropped rather than asked again. Pure and deliberately crude — word
// 3-shingles catch "the same proposal, lightly reworded" without any model call.

/** Lowercase, punctuation → space, whitespace collapsed and trimmed. */
export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** Word 3-shingles. A text of one or two words is a single shingle (itself), so short texts still
 *  compare; an empty text has none. */
function shingles(s: string): Set<string> {
  const words = normaliseText(s).split(' ').filter(Boolean)
  if (!words.length) return new Set()
  if (words.length < 3) return new Set([words.join(' ')])
  const out = new Set<string>()
  for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(' '))
  return out
}

/** Jaccard over word 3-shingles of `normaliseText`. 1 when both are empty, 0 when only one is. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a)
  const sb = shingles(b)
  if (!sa.size && !sb.size) return 1
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  return inter / (sa.size + sb.size - inter)
}
