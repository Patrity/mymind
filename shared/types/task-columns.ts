export type TaskColumnKind = 'open' | 'started' | 'done' | 'blocked'

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
