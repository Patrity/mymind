/** Root path prefix under which project documents are stored. */
export const PROJECTS_ROOT = '/projects'

/**
 * Returns the project-slug segment iff the path is UNDER /projects/<seg>/
 * (trailing slash boundary required — the segment must be non-empty).
 * Returns null for paths that are exactly `/projects/<seg>` with no trailing
 * slash, paths that don't start with `/projects/`, or paths with an empty
 * segment (`/projects//...`). Pure.
 */
export function projectFromPath(path: string): string | null {
  const m = /^\/projects\/([^/]+)\//.exec(path)
  return m ? m[1]! : null
}

/**
 * If `path` starts with `/projects/<oldSlug>/` (slash-boundary required),
 * replaces that prefix with `/projects/<newSlug>/` and returns the result.
 * Returns `path` unchanged for all other inputs (different project, no
 * trailing slash, non-project paths). Pure — mirrors the SQL
 * `regexp_replace(path, '^/projects/<old>/', '/projects/<new>/')`.
 * Slugs are `[a-z0-9-]+` and therefore regex-safe.
 */
export function rewriteProjectPathPrefix(path: string, oldSlug: string, newSlug: string): string {
  const prefix = `/projects/${oldSlug}/`
  if (!path.startsWith(prefix)) return path
  return `/projects/${newSlug}/` + path.slice(prefix.length)
}
