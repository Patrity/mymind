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
