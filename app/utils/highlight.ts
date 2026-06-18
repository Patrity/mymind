export interface HighlightSegment { text: string; match: boolean }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Split `text` into matched/unmatched segments against the query's tokens
 * (case-insensitive, ≥2 chars). Used to render <mark>-style highlights in the
 * palette. Pure — no DOM.
 */
export function highlightTokens(text: string, query: string): HighlightSegment[] {
  if (!text) return []
  const toks = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2).map(escapeRegExp)
  if (!toks.length) return [{ text, match: false }]

  const re = new RegExp(`(${toks.join('|')})`, 'gi')
  const out: HighlightSegment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), match: false })
    out.push({ text: m[0], match: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false })
  return out
}
