/**
 * Pure scheduling helpers over a validated JobSpec. Croner does the timezone/DST-aware cron
 * math; `every`/`at` are plain arithmetic (or Intl-driven wall-clock resolution for `at`);
 * `event` jobs never have a next run.
 */
import { Cron } from 'croner'
import type { JobSpec } from './parse'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ---------------------------------------------------------------------------------------------
// `every n(m|h)` — one shared parser so validation (parse.ts) and scheduling/describing (here)
// can never drift apart on what counts as a valid interval or how many ms it is.
// ---------------------------------------------------------------------------------------------

export interface EveryDuration { n: number; unit: 'm' | 'h'; ms: number }

export function parseEveryExpr(expr: string): EveryDuration | null {
  const m = /^(\d+)(m|h)$/.exec(expr)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'm') as 'm' | 'h'
  const ms = unit === 'h' ? n * 60 * 60_000 : n * 60_000
  return { n, unit, ms }
}

// ---------------------------------------------------------------------------------------------
// Timezone-aware `at` resolution. An offset-less ISO datetime (no trailing Z/±HH:MM) is wall-
// clock time in the job's `timezone`, not the server process's timezone — resolved purely via
// Intl (never relies on `process.env.TZ` / the Date object's local-time methods).
// ---------------------------------------------------------------------------------------------

const OFFSET_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/

function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUTC - utcMs) / 60_000)
}

function wallClockMatches(utcMs: number, timeZone: string, y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return get('year') === y && get('month') === mo && get('day') === d && get('hour') === h && get('minute') === mi && get('second') === s
}

/** Binary-searches for the exact instant the UTC offset flips from the "before" to the "after"
 *  regime within [lowMs, highMs] (lowMs must sample the old offset, highMs the new one). */
function findTransitionInstant(lowMs: number, highMs: number, timeZone: string): number {
  let lo = lowMs
  let hi = highMs
  const targetOffset = offsetMinutesAt(hi, timeZone)
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2)
    if (offsetMinutesAt(mid, timeZone) === targetOffset) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Resolves an `at` trigger's ISO datetime string to a concrete instant. A string with an
 * explicit offset (trailing `Z` or `±HH:MM`) is parsed as-is. An offset-less string is treated
 * as wall-clock time in `timeZone`:
 *  - in a DST gap (the wall-clock time never occurs), shifts forward to the first valid instant
 *    (the transition moment itself);
 *  - in a DST overlap (the wall-clock time occurs twice), takes the earlier of the two instants.
 * Returns null when `expr` isn't a recognizable date.
 */
export function resolveAtInstant(expr: string, timeZone: string): Date | null {
  if (OFFSET_SUFFIX_RE.test(expr)) {
    const t = Date.parse(expr)
    return Number.isNaN(t) ? null : new Date(t)
  }

  const m = NAIVE_DATETIME_RE.exec(expr)
  if (!m) {
    const t = Date.parse(expr)
    return Number.isNaN(t) ? null : new Date(t)
  }

  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  const s = Number(m[6] ?? '0')
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, s)

  // Stage 1: rough offset guess treating the naive value as if it were already UTC, to land in
  // the right ballpark regardless of how far the zone's offset is from UTC.
  const roughOffset = offsetMinutesAt(naiveUTC, timeZone)
  const roughUTC = naiveUTC - roughOffset * 60_000

  // Stage 2: sample the offset a few hours either side of that rough estimate — wide enough to
  // straddle any real-world DST transition (all are <= 2h) — to detect gaps/overlaps.
  const WINDOW_MS = 3 * 60 * 60_000
  const beforeMs = roughUTC - WINDOW_MS
  const afterMs = roughUTC + WINDOW_MS
  const offsetBefore = offsetMinutesAt(beforeMs, timeZone)
  const offsetAfter = offsetMinutesAt(afterMs, timeZone)
  const candidateBefore = naiveUTC - offsetBefore * 60_000
  const candidateAfter = naiveUTC - offsetAfter * 60_000
  const matchesBefore = wallClockMatches(candidateBefore, timeZone, y, mo, d, h, mi, s)
  const matchesAfter = wallClockMatches(candidateAfter, timeZone, y, mo, d, h, mi, s)

  if (matchesBefore && matchesAfter) return new Date(Math.min(candidateBefore, candidateAfter)) // overlap: earlier instant
  if (matchesBefore) return new Date(candidateBefore)
  if (matchesAfter) return new Date(candidateAfter)
  if (offsetBefore === offsetAfter) return new Date(candidateBefore) // no transition nearby; trust the guess

  // Gap: the wall-clock time never occurs. Shift forward to the first valid instant.
  return new Date(findTransitionInstant(beforeMs, afterMs, timeZone))
}

// ---------------------------------------------------------------------------------------------
// Cron density check — used by parse.ts's validation, kept here since it needs a live `Cron`.
// ---------------------------------------------------------------------------------------------

const CRON_CHECK_REFERENCE_MS = Date.UTC(2026, 0, 5, 0, 0, 0) // 2026-01-05T00:00:00Z, a Monday
const CRON_CHECK_WINDOW_MS = 8 * 24 * 60 * 60_000 // 8 days — covers every weekday at least once
const CRON_CHECK_MAX_RUNS = 5_000

/**
 * Minimum gap (ms) between consecutive occurrences of `cron` within a fixed 8-day window
 * starting from a fixed reference instant (a Monday) — deterministic regardless of wall-clock
 * "now", and covers every weekday. Returns null when fewer than 2 occurrences fall in the
 * window (nothing to compare — not a density violation).
 *
 * `earlyExitBelowMs` (Task 2 review, perf): once a gap strictly below this threshold is found,
 * the scan stops immediately rather than walking the rest of the 8-day window — for a valid
 * dense-looking-but-fine pattern the full scan cost ~400ms; the caller (parse.ts) only ever asks
 * "is the minimum gap below MIN_INTERVAL_MS?", so the exact global minimum is unneeded once one
 * violation is found. Omitting it (or passing nothing) keeps the old full-scan behaviour.
 */
export function minCronGapMs(cron: Cron, earlyExitBelowMs?: number): number | null {
  const windowEnd = CRON_CHECK_REFERENCE_MS + CRON_CHECK_WINDOW_MS
  let prev: Date | null = null
  let current: Date = new Date(CRON_CHECK_REFERENCE_MS)
  let min = Infinity
  for (let i = 0; i < CRON_CHECK_MAX_RUNS; i++) {
    const next = cron.nextRun(current)
    if (!next || next.getTime() > windowEnd) break
    if (prev) {
      const gap = next.getTime() - prev.getTime()
      min = Math.min(min, gap)
      if (earlyExitBelowMs !== undefined && gap < earlyExitBelowMs) break
    }
    prev = next
    current = next
  }
  return min === Infinity ? null : min
}

// ---------------------------------------------------------------------------------------------

export function nextRunAt(spec: JobSpec, from: Date): Date | null {
  switch (spec.trigger.kind) {
    case 'cron': {
      const cron = new Cron(spec.trigger.expr, { timezone: spec.timezone, paused: true })
      return cron.nextRun(from)
    }
    case 'every': {
      const every = parseEveryExpr(spec.trigger.expr)
      if (!every) return null
      return new Date(from.getTime() + every.ms)
    }
    case 'at': {
      const resolved = resolveAtInstant(spec.trigger.expr, spec.timezone)
      if (!resolved) return null
      return resolved.getTime() > from.getTime() ? resolved : null
    }
    case 'event':
      return null
  }
}

/** Candidates examined per requested fire time before nextFireTimes gives up (an `every 5m` job
 *  whose active_hours never match would otherwise loop forever). */
export const FIRE_TIMES_CANDIDATES_PER_RESULT = 2000

/**
 * The next `n` times the job will actually fire — only instants inside its active_hours, since
 * the tick skips the rest. `anchor` is the job's stored next_run_at: an `every` job fires on its
 * own cadence from there, not from `from` (the request time), so when the anchor is still ahead
 * the preview starts at it. Cron and at ignore the anchor (they are wall-clock anchored already).
 * Stops after n × FIRE_TIMES_CANDIDATES_PER_RESULT candidates, so it may return fewer than n.
 */
export function nextFireTimes(spec: JobSpec, n: number, from: Date = new Date(), opts: { anchor?: Date | null } = {}): Date[] {
  if (n <= 0) return []
  const cap = n * FIRE_TIMES_CANDIDATES_PER_RESULT
  const out: Date[] = []
  const keep = (d: Date) => {
    if (inActiveHours(spec, d)) out.push(d)
  }
  switch (spec.trigger.kind) {
    case 'cron': {
      const cron = new Cron(spec.trigger.expr, { timezone: spec.timezone, paused: true })
      let cur = from
      for (let i = 0; i < cap && out.length < n; i++) {
        const next = cron.nextRun(cur)
        if (!next) break
        keep(next)
        cur = next
      }
      return out
    }
    case 'every': {
      const every = parseEveryExpr(spec.trigger.expr)
      if (!every) return []
      const anchor = opts.anchor?.getTime()
      const first = anchor !== undefined && anchor > from.getTime() ? anchor : from.getTime() + every.ms
      for (let i = 0; i < cap && out.length < n; i++) keep(new Date(first + i * every.ms))
      return out
    }
    case 'at': {
      const next = nextRunAt(spec, from)
      if (next) keep(next)
      return out
    }
    case 'event':
      return []
  }
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return `cron ${expr}`
  const minute = parts[0] ?? ''
  const hour = parts[1] ?? ''
  const dom = parts[2] ?? ''
  const month = parts[3] ?? ''
  const dow = parts[4] ?? ''
  if (dom !== '*' || month !== '*') return `cron ${expr}`
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return `cron ${expr}`
  const time = `${Number(hour)}:${minute.padStart(2, '0')}`
  if (dow === '*') return `daily at ${time}`
  if (dow === '1-5') return `weekdays at ${time}`
  if (/^[0-6]$/.test(dow)) return `${DAY_NAMES[Number(dow)] ?? ''}s at ${time}`
  return `cron ${expr}`
}

function describeEvery(expr: string): string {
  const every = parseEveryExpr(expr)
  if (!every) return `every ${expr}`
  const unit = every.unit === 'h' ? 'hour' : 'minute'
  return `every ${every.n} ${unit}${every.n === 1 ? '' : 's'}`
}

function describeAt(expr: string, timezone: string): string {
  const resolved = resolveAtInstant(expr, timezone)
  if (!resolved) return `at ${expr}`
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(resolved)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `once on ${get('month')} ${get('day')}, ${get('hour')}:${get('minute')}`
}

function describeEvent(name: string): string {
  if (name === 'cc.session_end') return 'when a Claude Code session ends'
  if (name === 'task.due') return 'when a task is due'
  return `event ${name}`
}

export function describeTrigger(spec: JobSpec): string {
  switch (spec.trigger.kind) {
    case 'cron': return describeCron(spec.trigger.expr)
    case 'every': return describeEvery(spec.trigger.expr)
    case 'at': return describeAt(spec.trigger.expr, spec.timezone)
    case 'event': return describeEvent(spec.trigger.expr)
  }
}

/**
 * True when `at` (in the job's timezone) falls within `spec.activeHours`. The window is
 * start-inclusive, end-exclusive (`[start, end)`), and wraps past midnight when `end < start`.
 * Returns true when the job has no active_hours restriction.
 */
// One formatter per timezone: nextFireTimes can test thousands of candidates, and building an
// Intl.DateTimeFormat per call dominated that (≈350 ms for 10k candidates).
const hourMinuteFormatters = new Map<string, Intl.DateTimeFormat>()
function hourMinuteFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = hourMinuteFormatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
    hourMinuteFormatters.set(timeZone, f)
  }
  return f
}

export function inActiveHours(spec: JobSpec, at: Date): boolean {
  if (!spec.activeHours) return true
  const { start, end } = spec.activeHours
  const parts = hourMinuteFormatter(spec.timezone).formatToParts(at)
  const hh = parts.find(p => p.type === 'hour')?.value ?? '00'
  const mm = parts.find(p => p.type === 'minute')?.value ?? '00'
  const current = `${hh}:${mm}`
  if (start <= end) return current >= start && current < end
  return current >= start || current < end
}
