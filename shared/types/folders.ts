/**
 * 14 distinct hues (Tailwind 500s) that read on the dark theme. This is the SAME list
 * projects use — a folder under /projects/<slug> inherits the project's colour, so the
 * two must be drawn from one vocabulary or the inherited value could be unrepresentable
 * in the folder picker. `app/utils/project-color.ts` re-exports this; do not fork it.
 */
export const FOLDER_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
] as const

export type FolderColor = typeof FOLDER_PALETTE[number]

/** Where a rendered folder colour came from — drives the picker's "inheriting…" hint. */
export type FolderColorSource = 'own' | 'inherited' | 'project'

export interface FolderDTO {
  id: string
  path: string
  color: string | null
}
