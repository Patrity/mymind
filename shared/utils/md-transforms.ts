/**
 * Pure markdown text transforms.
 * All operate on a Selection = { text: string, from: number, to: number }
 * and return a new Selection (new text + new cursor/selection offsets).
 *
 * "text" is the FULL document string.
 * "from" / "to" are absolute character offsets into that string.
 */

export interface Selection {
  text: string
  from: number
  to: number
}

/** Replace the range [from, to) in text with insert, return updated Selection. */
function replace(s: Selection, insert: string, newFrom?: number, newTo?: number): Selection {
  const text = s.text.slice(0, s.from) + insert + s.text.slice(s.to)
  const f = newFrom ?? s.from + insert.length
  const t = newTo ?? f
  return { text, from: f, to: t }
}

/**
 * wrap — surround selection with marker (e.g. `**`) on both sides.
 * If selection is empty, insert marker+marker and place cursor between them.
 */
export function wrap(s: Selection, marker: string): Selection {
  const selected = s.text.slice(s.from, s.to)
  const insert = marker + selected + marker
  // cursor: if had selection, select the inner content; if empty, cursor between markers
  const newFrom = s.from + marker.length
  const newTo = s.from + marker.length + selected.length
  return replace(s, insert, newFrom, newTo)
}

/**
 * toggleLinePrefix — add or remove a prefix (e.g. `- `, `1. `, `> `, `- [ ] `)
 * on every line that overlaps the selection.
 * If ALL lines already start with the prefix, remove it; otherwise add it.
 */
export function toggleLinePrefix(s: Selection, prefix: string): Selection {
  const full = s.text
  // find start of first line and end of last line
  let lineStart = s.from
  while (lineStart > 0 && full[lineStart - 1] !== '\n') lineStart--
  let lineEnd = s.to
  while (lineEnd < full.length && full[lineEnd] !== '\n') lineEnd++

  const region = full.slice(lineStart, lineEnd)
  const lines = region.split('\n')

  const allHave = lines.every(l => l.startsWith(prefix))

  const transformed = allHave
    ? lines.map(l => l.slice(prefix.length))
    : lines.map(l => prefix + l)

  const newRegion = transformed.join('\n')
  const delta = newRegion.length - region.length

  const text = full.slice(0, lineStart) + newRegion + full.slice(lineEnd)
  const rawFrom = Math.max(lineStart, s.from + (allHave ? -prefix.length : prefix.length))
  const rawTo = s.to + delta

  const from = Math.max(0, Math.min(rawFrom, rawTo))
  const to = Math.max(0, Math.max(rawFrom, rawTo))

  return { text, from, to }
}

/**
 * setHeading — set/replace leading `#`*level on the line containing the cursor.
 * level 0 removes heading entirely.
 */
export function setHeading(s: Selection, level: number): Selection {
  const full = s.text
  let lineStart = s.from
  while (lineStart > 0 && full[lineStart - 1] !== '\n') lineStart--
  let lineEnd = s.from
  while (lineEnd < full.length && full[lineEnd] !== '\n') lineEnd++

  const line = full.slice(lineStart, lineEnd)

  // Strip any existing heading prefix
  const stripped = line.replace(/^#+\s?/, '')
  const newPrefix = level > 0 ? '#'.repeat(level) + ' ' : ''
  const newLine = newPrefix + stripped

  const text = full.slice(0, lineStart) + newLine + full.slice(lineEnd)
  // Place cursor at end of heading prefix
  const cursorPos = lineStart + newPrefix.length + stripped.length
  return { text, from: cursorPos, to: cursorPos }
}

/**
 * insertAt — replace selection with snippet, cursor placed after snippet.
 */
export function insertAt(s: Selection, snippet: string): Selection {
  return replace(s, snippet, s.from + snippet.length, s.from + snippet.length)
}

/**
 * makeLink — wraps selected text as `[selected](url)` with cursor in the url slot.
 * If selection is empty, inserts `[](url)` with cursor on the empty label.
 */
export function makeLink(s: Selection): Selection {
  const selected = s.text.slice(s.from, s.to)
  const insert = `[${selected}](url)`
  // Place cursor to select the "url" placeholder
  const urlStart = s.from + 1 + selected.length + 2 // after `[selected](`
  const urlEnd = urlStart + 3 // length of "url"
  return replace(s, insert, urlStart, urlEnd)
}
