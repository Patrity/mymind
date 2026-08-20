// PURE. The hinge of the compatibility seam: every pre-existing caller speaks TaskStatus,
// every column speaks TaskColumnKind. No I/O so it is testable without a database.
import type { TaskStatus } from '../../../shared/types/tasks'
import type { TaskColumnKind } from '../../../shared/types/task-columns'

const STATUS_TO_KIND: Record<TaskStatus, TaskColumnKind> = {
  todo: 'open', in_progress: 'started', completed: 'done', blocked: 'blocked'
}
const KIND_TO_STATUS: Record<TaskColumnKind, TaskStatus> = {
  open: 'todo', started: 'in_progress', done: 'completed', blocked: 'blocked'
}

export function kindForStatus(status: TaskStatus): TaskColumnKind {
  const k = STATUS_TO_KIND[status]
  // Throw rather than defaulting: a silent fallback would file tasks into the wrong column
  // indefinitely, and the caller (an MCP tool) can surface a real error to the agent.
  if (!k) throw new Error(`unknown task status: ${status}`)
  return k
}

export function statusForKind(kind: TaskColumnKind): TaskStatus {
  const s = KIND_TO_STATUS[kind]
  if (!s) throw new Error(`unknown column kind: ${kind}`)
  return s
}
