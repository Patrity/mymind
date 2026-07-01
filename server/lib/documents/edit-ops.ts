// Pure string transforms over a document's markdown `content`. No DB, no I/O.
// Line numbers are 1-indexed throughout.

export interface Heading { level: number; text: string; line: number }
export interface Section { startLine: number; endLine: number; level: number }
export interface ReadResult { text: string; startLine: number; endLine: number }
export interface GrepMatch { line: number; text: string; context: { line: number; text: string }[] }
export interface GrepResult { matches: GrepMatch[]; total: number; truncated: boolean }

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

function countOccurrences(hay: string, needle: string): number {
  let n = 0, i = 0
  for (;;) { const idx = hay.indexOf(needle, i); if (idx === -1) break; n++; i = idx + needle.length }
  return n
}

/** Exact find/replace with a uniqueness guard (mirrors Claude Code's Edit tool). */
export function applyReplace(
  content: string, oldStr: string, newStr: string, replaceAll?: boolean,
): { content: string } | { error: string } {
  if (oldStr === '') return { error: 'old_string must not be empty' }
  const count = countOccurrences(content, oldStr)
  if (count === 0) return { error: 'old_string not found in document' }
  if (count > 1 && !replaceAll) {
    return { error: `old_string is not unique (${count} matches) — add surrounding context or pass replace_all` }
  }
  if (replaceAll) return { content: content.split(oldStr).join(newStr) } // split/join → no regex/$ specials
  const idx = content.indexOf(oldStr)
  return { content: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length) }
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
