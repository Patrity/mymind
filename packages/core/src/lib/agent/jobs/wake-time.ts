// server/lib/agent/jobs/wake-time.ts
// Pure parser for schedule_wake's `when` (Task 8). Three forms:
//   - ISO datetime, with or without an offset — offset-less is wall-clock time in `timezone`,
//     exactly like an `at` trigger's own rule (schedule.ts's resolveAtInstant), so this reuses
//     that helper rather than reimplementing DST/timezone math.
//   - relative: `in <n>m|h|d`
//   - `today HH:MM` / `tomorrow HH:MM`, also wall-clock in `timezone`
// No DB, no I/O — `now` is injectable for tests. Past times are always rejected.
import { resolveAtInstant } from './schedule'

export type WakeWhenResult = { ok: true; at: Date } | { ok: false; error: string }

const RELATIVE_RE = /^in\s+(\d+)\s*(m|h|d)$/i
const DAY_HHMM_RE = /^(today|tomorrow)\s+([01]\d|2[0-3]):([0-5]\d)$/i

const UNIT_MS: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }

/** Y/M/D of `at` as observed in `timeZone` — calendar parts only, no time-of-day. */
function ymdIn(at: Date, timeZone: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return { y: get('year'), mo: get('month'), d: get('day') }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function resolveWakeWhen(raw: string, opts: { timezone: string; now?: Date }): WakeWhenResult {
  const expr = raw.trim()
  const now = opts.now ?? new Date()

  const rel = RELATIVE_RE.exec(expr)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]!.toLowerCase()
    const at = new Date(now.getTime() + n * UNIT_MS[unit]!)
    if (at.getTime() <= now.getTime()) return { ok: false, error: `"${raw}" is not in the future` }
    return { ok: true, at }
  }

  const day = DAY_HHMM_RE.exec(expr)
  if (day) {
    const which = day[1]!.toLowerCase()
    const hh = day[2]!
    const mi = day[3]!
    const base = ymdIn(now, opts.timezone)
    // Calendar-only shift: add a day to the Y/M/D triple (not to `now`'s real instant) — using
    // Date.UTC purely as a normalizer for month/year rollover, then reading the components back
    // out. This never touches the real timezone offset; resolveAtInstant does that below.
    const shifted = which === 'tomorrow'
      ? new Date(Date.UTC(base.y, base.mo - 1, base.d + 1))
      : new Date(Date.UTC(base.y, base.mo - 1, base.d))
    const naive = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${hh}:${mi}:00`
    const at = resolveAtInstant(naive, opts.timezone)
    if (!at) return { ok: false, error: `"${raw}" is not a valid time` }
    if (at.getTime() <= now.getTime()) return { ok: false, error: `"${raw}" is not in the future` }
    return { ok: true, at }
  }

  const at = resolveAtInstant(expr, opts.timezone)
  if (!at) return { ok: false, error: `"${raw}" is not a recognizable date/time` }
  if (at.getTime() <= now.getTime()) return { ok: false, error: `"${raw}" is not in the future` }
  return { ok: true, at }
}
