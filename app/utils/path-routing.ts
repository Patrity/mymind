// Client-safe copy of the pure prefix-normalization helper from
// `server/lib/projects/path-routing.ts`. Kept in sync manually — do NOT import
// the server module from a client component (it would pull server code into
// the client bundle). This file only carries the piece the reassignment UI
// needs (`normalizePrefix`); the rest of that module's helpers stay server-only.

/** Trim + strip trailing slashes. Root '/' is preserved. Pure. */
export function normalizePrefix(path: string): string {
  const t = (path ?? '').trim()
  if (!t) return ''
  const stripped = t.replace(/\/+$/, '')
  return stripped || '/'
}
