// Cycle 82 Task 3: the UI path rule and download limits (a leaf module — the worker's payload checks import it without
// loading the sandbox). Checked in the web route, the worker and again inside the container
// (view.ts resolves with realpath there and refuses what leaves /workspace).
const PATH_MAX = 4096

/** Raw bytes per download chunk: base64 + a header line stays under the manager's 1 MiB output cap. */
export const CHUNK_BYTES = 720 * 1024
/** Larger files are refused with 413. */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

/** null when `p` is an acceptable UI path (relative, no `..`, no NUL); else why not. */
export function workspacePathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return 'a path is required'
  if (p.length > PATH_MAX) return 'the path is too long'
  if (p.includes('\0')) return 'the path contains a NUL byte'
  if (p.startsWith('/') || p.startsWith('\\')) return 'the path must be relative to the workspace (no leading /)'
  if (p.split(/[/\\]/).includes('..')) return 'the path must not contain ..'
  return null
}

