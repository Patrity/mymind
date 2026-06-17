// 14 distinct hues (Tailwind 500s) that read on the dark theme.
export const PROJECT_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
] as const

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  return h
}

/** Stable per-project hex: the override if set, else a palette colour derived from the slug. Pure. */
export function projectColor(slug: string, override?: string | null): string {
  if (override) return override
  return PROJECT_PALETTE[hash(slug) % PROJECT_PALETTE.length]!
}
