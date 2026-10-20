// Stack review 2026-10-19 (D1). Contextual retrieval (Anthropic-style "situate this chunk") used
// to send the ENTIRE document with every chunk: 3,433 calls / 81.7 M prompt tokens in 14 days —
// 48 % of every prompt token MyMind sent, each call holding one of the main coder's 4 slots for
// its prefill. The technique is fine; the full-document prefix is the cost. These two pure helpers
// bound it:
//   - shouldContextualize: skip documents where the chunk IS the document (one chunk, or under
//     `minDocTokens`) — the heading path already says everything a situating sentence would.
//   - buildContextWindow: pass at most `maxTokens` of the document per call — the chunk's own
//     section, ±`neighbours` whole chunks, and the document's title line — instead of all of it.
// Both are pure so they can be tested without a model; embed-source.ts wires them in.
import { estimateTokens, type Chunk } from '@mymind/core/lib/chunking/chunk-markdown'

const CHARS_PER_TOKEN = 3.8 // mirrors chunk-markdown's estimateTokens
const ELLIPSIS = '…'

export interface ContextWindowOpts {
  /** Hard cap on the <document> excerpt per call, in estimated tokens. */
  maxTokens: number
  /** Whole chunks on either side of the target to include, within the cap. */
  neighbours: number
}

export interface ContextualizeGate {
  enabled: boolean
  /** Documents estimated under this many tokens are not contextualized at all. */
  minDocTokens: number
}

/** Pure: is a situating sentence worth a model call for this document at all? */
export function shouldContextualize(parts: Chunk[], docTokens: number, gate: ContextualizeGate): boolean {
  if (!gate.enabled) return false
  if (parts.length < 2) return false
  return docTokens >= gate.minDocTokens
}

/**
 * Pure: the slice of `doc` to send as <document> for `parts[i]`.
 *
 * A document that fits the cap is returned whole (behaviour unchanged for small docs). Otherwise
 * the window is the union of the chunk's section (every chunk sharing its headingPath) and its
 * ±K neighbours, shrunk symmetrically around the target chunk until it fits, with the title line
 * prepended and an ellipsis marking each cut edge. The target chunk itself is always whole: it is
 * ≤ maxTokens(512) and the cap is thousands.
 */
export function buildContextWindow(doc: string, parts: Chunk[], i: number, opts: ContextWindowOpts): string {
  if (estimateTokens(doc) <= opts.maxTokens) return doc
  const target = parts[i]
  if (!target) return doc

  const titleLine = doc.slice(0, firstLineEnd(doc)).trim()
  const sectionHeading = target.headingPath.split(' › ').pop() ?? ''
  const prefix = `${titleLine}\n[${sectionHeading}]\n${ELLIPSIS}\n`
  const suffix = `\n${ELLIPSIS}`
  const budgetChars = Math.floor(opts.maxTokens * CHARS_PER_TOKEN) - prefix.length - suffix.length

  // Desired range: the containing section ∪ ±K neighbours.
  let start = target.charStart
  let end = target.charEnd
  for (const p of parts) {
    if (p.headingPath !== target.headingPath) continue
    start = Math.min(start, p.charStart)
    end = Math.max(end, p.charEnd)
  }
  const lo = parts[Math.max(0, i - opts.neighbours)]!
  const hi = parts[Math.min(parts.length - 1, i + opts.neighbours)]!
  start = Math.min(start, lo.charStart)
  end = Math.max(end, hi.charEnd)

  // Shrink toward the target chunk, symmetrically, until the range fits the budget.
  if (end - start > budgetChars) {
    const chunkLen = target.charEnd - target.charStart
    const spare = Math.max(0, budgetChars - chunkLen)
    let left = Math.min(target.charStart - start, Math.floor(spare / 2))
    const right = Math.min(end - target.charEnd, spare - left)
    left = Math.min(target.charStart - start, spare - right) // hand unused right-side room to the left
    start = target.charStart - left
    end = target.charEnd + right
  }

  const cutStart = start > 0
  const cutEnd = end < doc.length
  const body = doc.slice(start, end).trim()
  if (!cutStart && !cutEnd) return doc
  return (cutStart ? prefix : '') + body + (cutEnd ? suffix : '')
}

function firstLineEnd(s: string): number {
  const nl = s.indexOf('\n')
  return nl < 0 ? s.length : nl
}
