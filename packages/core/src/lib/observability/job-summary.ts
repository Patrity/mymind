/**
 * True when a cron job's result indicates it actually did something this tick:
 * any numeric counter > 0 EXCEPT `remaining` (a backlog gauge, not work performed).
 * Nested objects and non-numeric fields are ignored.
 *
 * Pure; no DB imports so it stays unit-testable. Used by `recordJobSummary` to
 * suppress all-zero no-op summaries that would otherwise flood the activity feed
 * with misleading "embedded:0 / candidates:0" rows that read as constant churn.
 */
export function jobDidWork(result: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(result)) {
    if (key === 'remaining') continue
    if (typeof value === 'number' && value > 0) return true
  }
  return false
}
