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

// setFrontmatterKey's single-LINE replacement (below) requires the new value's own serialization
// to fit on that one line — `stringify()` at the top level defaults collections to BLOCK style
// (`stringify(['app'])` -> `"- app\n"`, `stringify({a:1})` -> `"a: 1\n"`), which would corrupt the
// line. `collectionStyle: 'flow'` forces `[app]` / `{a: 1}` instead; harmless for scalars.
const SINGLE_LINE_STRINGIFY_OPTS = { ...STRINGIFY_OPTS, collectionStyle: 'flow' } as const

export function splitFrontmatter(md: string): { data: Record<string, unknown>, body: string, error?: string } {
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrites one frontmatter key, keeping every OTHER line byte-stable — including a trailing
 * `  # comment` (any amount of padding) and flow-collection spacing like `{ project: mymind }`.
 *
 * The naive approach — parse the whole frontmatter block, `.set()` the key, re-stringify the
 * whole document — reformats every line, not just the target one: yaml's stringifier collapses
 * padding before same-line comments and drops the padding inside flow collections
 * (`{ project: mymind }` -> `{project: mymind}`). Real job files use both (spec §3).
 *
 * So: when `key` already exists as a TOP-LEVEL `key:` line (column 0, not indented) — the only
 * shape job/skill frontmatter ever uses — only that one line is touched, via a targeted regex:
 * find the line, split "everything after the colon" into the value token and an optional
 * trailing `<whitespace>#comment` (a `#` only starts a YAML comment when preceded by whitespace),
 * keep the leading whitespace after the colon AND the trailing comment exactly as they were, and
 * substitute only the value token with the new value's own scalar serialization. (This is a
 * targeted regex, not a YAML parser: a `#` inside a quoted value that happens to be
 * whitespace-preceded, e.g. `"a # b"`, would be mis-split — not a shape any job/skill file here
 * uses.)
 *
 * Only when the key is ABSENT does this fall back to the yaml Document API (parse the block,
 * `.set()`, re-stringify) to insert it — which CAN reformat other lines, but there is no existing
 * line to preserve in that case.
 */
export function setFrontmatterKey(md: string, key: string, value: unknown): string {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return joinFrontmatter({ [key]: value }, md)
  const fmText = match[1] ?? ''
  const body = match[2] ?? ''

  const lines = fmText.split('\n')
  const lineRe = new RegExp(`^${escapeRegExp(key)}:(.*)$`)
  const idx = lines.findIndex(l => lineRe.test(l))

  if (idx !== -1) {
    const rest = lineRe.exec(lines[idx]!)![1] ?? ''
    let splitAt = rest.length
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '#' && /\s/.test(rest[i - 1]!)) {
        // Found the comment's '#'; back up over the run of whitespace immediately before it too,
        // so that padding becomes part of the preserved suffix, not part of the discarded value.
        splitAt = i
        while (splitAt > 0 && /\s/.test(rest[splitAt - 1]!)) splitAt--
        break
      }
    }
    const valueRegion = rest.slice(0, splitAt)
    const suffix = rest.slice(splitAt) // '' or the exact "<ws>#comment..." tail, untouched
    const leadingWs = /^\s*/.exec(valueRegion)![0]
    const serialized = stringify(value, SINGLE_LINE_STRINGIFY_OPTS).replace(/\n+$/, '')
    lines[idx] = `${key}:${leadingWs}${serialized}${suffix}`
    return `---\n${lines.join('\n')}\n---\n${body}`
  }

  const doc = parseDocument(fmText)
  doc.set(key, value)
  const fm = doc.toString(STRINGIFY_OPTS).replace(/\n+$/, '')
  return `---\n${fm}\n---\n${body}`
}
