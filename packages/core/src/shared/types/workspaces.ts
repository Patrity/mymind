// Cycle 82 Task 3: what the Files / Shells UI reads (GET /api/workspaces/**).

export interface WorkspaceDTO {
  id: string
  kind: 'home' | 'workstream'
  workstreamId: string | null
  state: 'stopped' | 'running'
  /** Persistent taint: network (and secrets) off until Tony re-enables it. */
  tainted: boolean
  taintedAt: string | null
  bytesUsed: number
  inodesUsed: number
  lastUsedAt: string
  deletedAt: string | null
}

export interface WorkspaceTreeEntry {
  path: string
  type: 'file' | 'dir' | 'link'
  bytes: number | null
  mtime?: number
  target?: string
  /** A dependency/cache dir (node_modules, .git, …) listed but not entered. */
  skipped?: boolean
}

export interface WorkspaceTree { entries: WorkspaceTreeEntry[]; count: number; truncated: boolean }

export interface WorkspaceFileView {
  path: string
  binary: boolean
  /** The file's full size. */
  bytes: number
  lines?: number
  /** More than 2000 lines / 1 MB: only the start is shown. */
  truncated?: boolean
  content?: string
}

export interface WorkspaceShellDTO {
  id: string
  command: string
  state: 'running' | 'exited' | 'killed' | 'lost'
  exitCode: number | null
  reason: string | null
  startedAt: string
  endedAt: string | null
}

export interface WorkspaceShellTail {
  shellId: string
  state: WorkspaceShellDTO['state']
  exitCode: number | null
  reason: string | null
  output: string
  outputBytes: number
  truncated: boolean
}

/** Cycle 82 final review I6: the worker's sandbox preflight result, carried on its heartbeat (the
 *  web shows "Sandbox unavailable: <reason>"; CD turns it into a deploy warning). */
export type SandboxHealth = { ok: true; checkedAt: string } | { ok: false; reason: string; checkedAt: string }
