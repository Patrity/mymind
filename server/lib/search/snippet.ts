/** Query tokens worth locating a snippet around (drop 1-char noise). */
function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
}

/**
 * Build a display snippet: collapse whitespace, find the earliest matched query
 * token, and return a window of up to `maxLen` chars around it with `…` ellipses
 * on truncated ends. No match → the head of the text.
 */
export function makeSnippet(text: string, query: string, maxLen = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean

  const lower = clean.toLowerCase()
  let idx = -1
  for (const t of tokens(query)) {
    const i = lower.indexOf(t)
    if (i !== -1 && (idx === -1 || i < idx)) idx = i
  }

  if (idx === -1) return clean.slice(0, maxLen) + '…'

  // Find the end of all matched tokens starting from idx
  let phraseEnd = idx
  for (const t of tokens(query)) {
    const i = lower.indexOf(t, idx)
    if (i !== -1) {
      phraseEnd = Math.max(phraseEnd, i + t.length)
    }
  }

  // Compute window: try to give context before, but ensure the phrase fits
  const phraseLen = phraseEnd - idx
  const availableForContext = Math.max(0, maxLen - phraseLen)
  const contextBefore = Math.min(30, availableForContext)

  const start = Math.max(0, idx - contextBefore)
  const end = Math.min(clean.length, start + maxLen)

  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '')
}
