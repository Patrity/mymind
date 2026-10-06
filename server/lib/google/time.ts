// server/lib/google/time.ts
// Renders an instant in Tony's agent time zone (getDefaultTimezone(), never server-local — prod
// is UTC) as `ISO-with-offset (human)`, e.g. `2026-10-05T11:00:00-05:00 (Mon, Oct 5, 11:00 AM CDT)`,
// and parses tool time inputs: an ISO string with an offset is taken as-is; a naive one
// (`2026-10-08T14:00`, or a bare date `2026-10-08`) is wall-clock time in the agent zone
// (jobs/schedule.ts's resolveAtInstant — DST gaps shift forward, overlaps take the earlier).
import { resolveAtInstant } from '../agent/jobs/schedule'

export function isoInZone(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset'
  }).formatToParts(d).map(p => [p.type, p.value]))
  // longOffset is 'GMT-05:00', or bare 'GMT' for a zero offset.
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

/** Human-only rendering, e.g. `Thu, Oct 8, 2:00 PM CDT`. */
export function humanInZone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(d)
}

export function formatInZone(d: Date, timeZone: string): string {
  return `${isoInZone(d, timeZone)} (${humanInZone(d, timeZone)})`
}

/** The calendar date (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function dateInZone(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDateOnly(s: string): boolean {
  return DATE_ONLY_RE.test(s)
}

/** Adds `n` days to a YYYY-MM-DD date (pure calendar arithmetic, no zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export const UNRECOGNIZED_TIME = 'unrecognized time — use ISO like 2026-10-08T14:00'

// The ONLY accepted shapes (cycle 79 review I2). Anything else must be refused, never handed to
// Date.parse: that reads a non-ISO string ("2026-10-08 14:00", "Oct 8, 2026 2:00 PM") in the
// SERVER's zone — UTC on prod — silently shifting Tony's times by his UTC offset.
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/
const ISO_NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/

/** True when y-m-d h:mi:s names a real wall-clock reading (no Feb 30, no 25:00). */
function validParts(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s
}

/**
 * Parses a tool's time input to an instant. Accepts exactly three shapes (a single space may
 * stand in for the `T`):
 *  - ISO with an offset or `Z` → that instant;
 *  - naive ISO `YYYY-MM-DDTHH:mm[:ss]` → wall-clock time in `timeZone` (resolveAtInstant: DST gaps
 *    shift forward, overlaps take the earlier instant);
 *  - a bare `YYYY-MM-DD` → that date's midnight in `timeZone`.
 * Anything else → null (callers report UNRECOGNIZED_TIME). Never depends on the server's own zone.
 */
export function parseAgentTime(s: string, timeZone: string): Date | null {
  const trimmed = s.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:)/, '$1T$2')
  if (DATE_ONLY_RE.test(trimmed)) {
    const [y, mo, d] = trimmed.split('-').map(Number) as [number, number, number]
    if (!validParts(y, mo, d)) return null
    return resolveAtInstant(`${trimmed}T00:00`, timeZone)
  }
  if (ISO_WITH_OFFSET_RE.test(trimmed)) {
    const t = Date.parse(trimmed)
    return Number.isNaN(t) ? null : new Date(t)
  }
  const m = ISO_NAIVE_RE.exec(trimmed)
  if (!m) return null
  if (!validParts(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'))) return null
  const d = resolveAtInstant(trimmed, timeZone)
  return d && !Number.isNaN(d.getTime()) ? d : null
}
