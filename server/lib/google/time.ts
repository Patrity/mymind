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

/**
 * Parses a tool's time input to an instant. Offset-bearing ISO → as given; naive datetime →
 * wall-clock in `timeZone`; a bare date → that date's midnight in `timeZone`. null when the
 * string isn't a recognisable date.
 */
export function parseAgentTime(s: string, timeZone: string): Date | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  const d = resolveAtInstant(isDateOnly(trimmed) ? `${trimmed}T00:00` : trimmed, timeZone)
  return d && !Number.isNaN(d.getTime()) ? d : null
}
