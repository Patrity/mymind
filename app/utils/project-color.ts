// 14 distinct hues (Tailwind 500s) that read on the dark theme. Opt-in palette for the picker.
export const PROJECT_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
] as const

// Neutral grey default — used until the user picks a palette colour. Reads on the dark theme.
export const NEUTRAL_COLOR = '#9ca3af'

/** The override if set, else the neutral grey default. Pure. `_slug` kept for caller compatibility. */
export function projectColor(_slug: string, override?: string | null): string {
  return override || NEUTRAL_COLOR
}
