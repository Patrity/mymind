// Runtime source of truth for a column's `kind` — mirrors TASK_COLUMN_COLORS below. Every kind
// maps 1:1 with a TaskStatus value (server/lib/tasks/status-kind.ts), which throws on anything
// outside this list, and every live task read derives its status by calling into that map — so
// this closed vocabulary is enforced twice: a DB CHECK constraint on task_columns.kind (see the
// migration that added it) and z.enum(TASK_COLUMN_KINDS) at the column API routes.
export const TASK_COLUMN_KINDS = ['open', 'started', 'done', 'blocked'] as const
export type TaskColumnKind = typeof TASK_COLUMN_KINDS[number]

/** Semantic aliases only — matches UBadge's `color` prop. Never a hex or a palette name. */
export const TASK_COLUMN_COLORS = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] as const
export type TaskColumnColor = typeof TASK_COLUMN_COLORS[number]

export interface TaskColumnDTO {
  id: string
  name: string
  kind: TaskColumnKind
  color: TaskColumnColor
  position: number
  isDefault: boolean
}
