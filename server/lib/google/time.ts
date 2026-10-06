// server/lib/google/time.ts
// Renders an instant in Tony's agent time zone (getDefaultTimezone(), never server-local — prod
// is UTC) as `ISO-with-offset (human)`, e.g. `2026-10-05T11:00:00-05:00 (Mon, Oct 5, 11:00 AM CDT)`.

function isoInZone(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset'
  }).formatToParts(d).map(p => [p.type, p.value]))
  // longOffset is 'GMT-05:00', or bare 'GMT' for a zero offset.
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

export function formatInZone(d: Date, timeZone: string): string {
  const human = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(d)
  return `${isoInZone(d, timeZone)} (${human})`
}
