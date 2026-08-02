// Pure string transforms over a document's markdown `content`. No DB, no I/O.
// Line numbers are 1-indexed throughout.

export interface Heading { level: number; text: string; line: number }
export interface Section { startLine: number; endLine: number; level: number }
export interface ReadResult { text: string; startLine: number; endLine: number }
export interface GrepMatch { line: number; text: string; context: { line: number; text: string }[] }
export interface GrepResult { matches: GrepMatch[]; total: number; truncated: boolean }

/** A typed edit failure: `error` is a stable machine code, `message` the human-readable hint. */
export interface ReplaceFailure {
  error: 'empty_old_string' | 'no_match' | 'ambiguous_match'
  message: string
  matches: number
  candidates?: { line: number; text: string }[]
}

const ATX = /^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/
const FENCE = /^\s*(```|~~~)/

/** ATX headings, skipping fenced code blocks. */
export function outline(content: string): Heading[] {
  const lines = content.split('\n')
  const out: Heading[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = ATX.exec(line)
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: i + 1 })
  }
  return out
}

/** The span of a uniquely-named section: heading line → line before the next heading of level <= its own (or EOF). */
export function findSection(content: string, heading: string): Section | { error: string } {
  const heads = outline(content)
  const target = heading.trim()
  const matches = heads.filter(h => h.text === target)
  if (matches.length === 0) return { error: `heading not found: "${heading}"` }
  if (matches.length > 1) return { error: `heading "${heading}" is ambiguous (${matches.length} matches)` }
  const h = matches[0]!
  const next = heads.find(x => x.line > h.line && x.level <= h.level)
  const endLine = next ? next.line - 1 : content.split('\n').length
  return { startLine: h.line, endLine, level: h.level }
}

export function readSection(
  content: string,
  opts: { heading?: string; offset?: number; limit?: number },
): ReadResult | { error: string } {
  const lines = content.split('\n')
  if (opts.heading !== undefined) {
    const sec = findSection(content, opts.heading)
    if ('error' in sec) return sec
    return { text: lines.slice(sec.startLine - 1, sec.endLine).join('\n'), startLine: sec.startLine, endLine: sec.endLine }
  }
  const offset = Math.max(1, opts.offset ?? 1)
  const limit = Math.max(1, opts.limit ?? 200)
  const start = offset - 1
  const end = Math.min(lines.length, start + limit)
  return { text: lines.slice(start, end).join('\n'), startLine: offset, endLine: end }
}

export function documentStats(content: string): { lineCount: number; charCount: number } {
  return { lineCount: content.split('\n').length, charCount: content.length }
}

function contextLines(lines: string[], idx: number, ctx: number): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  for (let j = Math.max(0, idx - ctx); j <= Math.min(lines.length - 1, idx + ctx); j++) {
    if (j === idx) continue
    out.push({ line: j + 1, text: lines[j]! })
  }
  return out
}

export function grepContent(
  content: string,
  pattern: string,
  opts: { regex?: boolean; context?: number; max?: number } = {},
): GrepResult | { error: string } {
  const ctx = opts.context ?? 2
  const max = opts.max ?? 50
  const lines = content.split('\n')
  let test: (s: string) => boolean
  if (opts.regex) {
    let re: RegExp
    try { re = new RegExp(pattern) } catch (e) { return { error: `invalid regex: ${(e as Error).message}` } }
    test = (s) => re.test(s)
  } else {
    test = (s) => s.includes(pattern)
  }
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) if (test(lines[i]!)) hits.push(i)
  const kept = hits.slice(0, max)
  return {
    matches: kept.map(i => ({ line: i + 1, text: lines[i]!, context: contextLines(lines, i, ctx) })),
    total: hits.length,
    truncated: hits.length > kept.length,
  }
}

/** Byte offsets of every non-overlapping occurrence, in order. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = []
  for (let i = 0; ;) { const idx = hay.indexOf(needle, i); if (idx === -1) break; out.push(idx); i = idx + needle.length }
  return out
}

/** Max candidate lines returned on an ambiguous match — enough to disambiguate, small enough to stay cheap. */
const MAX_CANDIDATES = 10
/**
 * Cap on each candidate's text. Without it a single pathological line (a minified blob, a wide
 * table row) would put the whole line in the response — reintroducing the oversized-result
 * failure that receipts exist to prevent.
 */
const MAX_CANDIDATE_CHARS = 200
/**
 * Clip a string to `MAX_CANDIDATE_CHARS`, appending an ellipsis when it overflows. Exported so
 * other body-free-response builders (e.g. `divergenceReport` in `server/lib/agent/receipt.ts`)
 * reuse the same cap instead of inventing a second one.
 */
export const clip = (s: string) => (s.length > MAX_CANDIDATE_CHARS ? s.slice(0, MAX_CANDIDATE_CHARS) + '…' : s)

/**
 * The distinct lines an offset list falls on, capped. Several occurrences on one line
 * collapse to a single candidate: the agent needs *where to look*, not a hit count per line.
 */
function candidateLines(content: string, offsets: number[]): { line: number, text: string }[] {
  const lines = content.split('\n')
  // Prefix scan once (offset → line) rather than slicing per occurrence.
  const starts: number[] = []
  for (let i = 0, at = 0; i < lines.length; i++) { starts.push(at); at += lines[i]!.length + 1 }
  const seen = new Set<number>()
  const out: { line: number, text: string }[] = []
  for (const off of offsets) {
    let lo = 0, hi = starts.length - 1, ln = 0
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid]! <= off) { ln = mid; lo = mid + 1 } else hi = mid - 1 }
    if (seen.has(ln)) continue
    seen.add(ln)
    out.push({ line: ln + 1, text: clip(lines[ln]!) })
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}

/**
 * Exact find/replace with a uniqueness guard (mirrors Claude Code's Edit tool).
 *
 * Failures are typed (`error` is a stable code, `message` is the human hint) so an agent can
 * branch on the outcome instead of pattern-matching prose — and `candidates` gives it the line
 * numbers it needs to widen `old_string` and retry in a single step.
 */
export function applyReplace(
  content: string, oldStr: string, newStr: string, replaceAll?: boolean,
): { content: string, replacements: number } | ReplaceFailure {
  if (oldStr === '') {
    return { error: 'empty_old_string', message: 'old_string must not be empty', matches: 0 }
  }
  const offsets = occurrences(content, oldStr)
  const count = offsets.length
  if (count === 0) {
    return { error: 'no_match', message: 'old_string not found in document', matches: 0 }
  }
  if (count > 1 && !replaceAll) {
    return {
      error: 'ambiguous_match',
      message: `old_string is not unique (${count} matches) — add surrounding context or pass replace_all`,
      matches: count,
      candidates: candidateLines(content, offsets),
    }
  }
  if (replaceAll) return { content: content.split(oldStr).join(newStr), replacements: count } // split/join → no regex/$ specials
  const idx = offsets[0]!
  return { content: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length), replacements: 1 }
}

/** Structure-aware append/replace by heading. */
export function applyEditSection(
  content: string, args: { mode: 'append' | 'replace'; text: string; heading?: string },
): { content: string } | { error: string } {
  if (args.heading === undefined) {
    if (args.mode === 'replace') return { error: 'replace mode requires a heading; use update_document to replace whole content' }
    return { content: content.replace(/\n*$/, '') + '\n\n' + args.text + '\n' } // append to end of doc
  }
  const sec = findSection(content, args.heading)
  if ('error' in sec) return sec
  const lines = content.split('\n')
  const body = args.text.split('\n')
  if (args.mode === 'replace') {
    // keep the heading line (index sec.startLine-1); replace the body lines startLine..endLine
    const before = lines.slice(0, sec.startLine)   // through the heading line
    const after = lines.slice(sec.endLine)          // from the next heading on
    return { content: [...before, ...body, ...after].join('\n') }
  }
  // append: insert at the end of the section, before the next heading
  const before = lines.slice(0, sec.endLine)
  const after = lines.slice(sec.endLine)
  return { content: [...before, ...body, ...after].join('\n') }
}
