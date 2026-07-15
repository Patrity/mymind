/**
 * Pure path-based routing helpers for sessions with no git remote. No imports,
 * no I/O — all decision logic that findOrCreateProject / the re-resolve backfill
 * share lives here so it can be unit-tested (mirrors ./git-remote.ts).
 */

/** Trim + strip trailing slashes. Root '/' is preserved. Pure. */
export function normalizePrefix(path: string): string {
  const t = (path ?? '').trim()
  if (!t) return ''
  const stripped = t.replace(/\/+$/, '')
  return stripped || '/'
}

/** Last non-empty path segment ('' when none). Pure. */
export function basenameOf(path: string): string {
  const seg = normalizePrefix(path).split('/').filter(Boolean)
  return seg[seg.length - 1] ?? ''
}

/** True when `cwd` equals `prefix` or is a descendant directory of it. Pure. */
export function isUnderPrefix(cwd: string, prefix: string): boolean {
  const c = normalizePrefix(cwd)
  const p = normalizePrefix(prefix)
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(p === '/' ? '/' : p + '/')
}

export interface PrefixCandidate { id: string, slug: string, prefixes: string[] }

/** Candidate whose registered prefix is the LONGEST ancestor-or-equal of cwd. Pure. */
export function longestPrefixMatch(cwd: string, candidates: PrefixCandidate[]): PrefixCandidate | null {
  let best: PrefixCandidate | null = null
  let bestLen = -1
  for (const cand of candidates) {
    for (const raw of cand.prefixes ?? []) {
      const p = normalizePrefix(raw)
      if (p && isUnderPrefix(cwd, p) && p.length > bestLen) { best = cand; bestLen = p.length }
    }
  }
  return best
}

// Stoplist — never auto-create a project from these bare/scratch cwds.
const HOME_ROOT_RE = [/^\/(?:Users|home)\/[^/]+$/i, /^\/mnt\/[a-z]\/Users\/[^/]+$/i]
const TEMP_RE = /^\/(?:private\/)?(?:tmp|var\/tmp)(?:\/|$)/i
const GENERIC_LEAVES = new Set([
  'documents', 'github', 'downloads', 'desktop', 'src', 'projects', 'code', 'repos', 'dev', 'tmp', 'temp'
])

/** Whether a cwd is a "real" project folder we may auto-create a project from. Pure. */
export function isAutoCreatable(cwd: string | null | undefined): boolean {
  if (!cwd) return false
  const p = normalizePrefix(cwd)
  if (!p || p === '/') return false
  if (HOME_ROOT_RE.some(re => re.test(p))) return false
  if (TEMP_RE.test(p)) return false
  if (GENERIC_LEAVES.has(basenameOf(p).toLowerCase())) return false
  return true
}
