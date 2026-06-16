/**
 * Normalize a git remote URL to a canonical match key `host/owner/repo`
 * (lowercased, no scheme/credentials/port/.git). Returns null when there is no
 * parseable host+path. Pure.
 */
export function normalizeGitRemote(remote: string | null | undefined): string | null {
  if (!remote) return null
  let s = remote.trim()
  if (!s) return null
  let host: string, path: string
  if (/:\/\//.test(s)) {
    // scheme URL: https:// ssh:// git://
    s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]+@/, '') // strip scheme + credentials
    const slash = s.indexOf('/')
    if (slash < 0) return null
    host = s.slice(0, slash); path = s.slice(slash + 1)
  } else {
    const scp = s.match(/^[^@]+@([^:]+):(.+)$/) // git@host:owner/repo(.git)
    if (scp) { host = scp[1]!; path = scp[2]! }
    else {
      const slash = s.indexOf('/')
      if (slash < 0) return null
      host = s.slice(0, slash); path = s.slice(slash + 1)
    }
  }
  host = host.split(':')[0]! // strip port
  path = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (!host || !path) return null
  return `${host}/${path}`.toLowerCase()
}

/** Repo name = last path segment of a git_remote_key. Pure. */
export function repoNameFromKey(key: string): string {
  const seg = key.split('/').filter(Boolean)
  return seg[seg.length - 1] ?? key
}

/** First free slug in base, base-2, base-3, … given the taken set. Pure. */
export function nextUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
