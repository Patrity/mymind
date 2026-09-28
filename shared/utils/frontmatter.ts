/**
 * Pure YAML-frontmatter helpers shared between server (jobs/skills parsing) and app (editor
 * autosave / explicit-save flows). No I/O, no DB — just string <-> {data, body} transforms.
 *
 * Frontmatter block shape:
 *   ---
 *   key: value
 *   ---
 *   body text
 */
import { parse, parseDocument, stringify } from 'yaml'

// Non-greedy match on the YAML block: the first `\n---` after the opening fence closes it,
// which is what every real frontmatter document means (a bare `---` line inside YAML content
// is not valid block-mapping syntax anyway).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

// yaml's default flow-collection stringify pads brackets (`[app]` -> `[ app ]`). Turning that
// off keeps setFrontmatterKey byte-stable on every line it didn't touch.
const STRINGIFY_OPTS = { flowCollectionPadding: false } as const

export function splitFrontmatter(md: string): { data: Record<string, unknown>; body: string; error?: string } {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return { data: {}, body: md, error: 'missing frontmatter block' }
  const fmText = match[1] ?? ''
  const body = match[2] ?? ''
  try {
    const parsed: unknown = parse(fmText)
    if (parsed === null || parsed === undefined) return { data: {}, body }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, body, error: 'frontmatter must be a mapping' }
    }
    return { data: parsed as Record<string, unknown>, body }
  } catch (e) {
    return { data: {}, body, error: e instanceof Error ? e.message : String(e) }
  }
}

export function joinFrontmatter(data: Record<string, unknown>, body: string): string {
  const fm = stringify(data, STRINGIFY_OPTS).replace(/\n+$/, '')
  return `---\n${fm}\n---\n${body}`
}

/** Rewrites one frontmatter key, keeping every other line byte-stable (comments included). */
export function setFrontmatterKey(md: string, key: string, value: unknown): string {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return joinFrontmatter({ [key]: value }, md)
  const fmText = match[1] ?? ''
  const body = match[2] ?? ''
  const doc = parseDocument(fmText)
  doc.set(key, value)
  const fm = doc.toString(STRINGIFY_OPTS).replace(/\n+$/, '')
  return `---\n${fm}\n---\n${body}`
}
