// Cycle 86 (ruling R2): spot root-absolute asset refs in an entry page that will 404 under /artifact/<slug>/.
// Only refs whose path matches a file actually in the bundle count — `/missing.js` and external URLs are not flagged.
const ATTR_RE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

export function rootAbsoluteRefs(html: string, paths: Iterable<string>): string[] {
  const known = new Set(paths)
  const out = new Set<string>()
  for (const m of html.matchAll(ATTR_RE)) {
    const v = (m[1] ?? m[2] ?? '').trim()
    if (!v.startsWith('/') || v.startsWith('//')) continue
    const path = v.slice(1).split(/[?#]/)[0]!
    if (path && known.has(path)) out.add(v)
  }
  return [...out]
}
