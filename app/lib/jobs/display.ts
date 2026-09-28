/**
 * Pure display helpers for the /jobs pages (cycle 74): outcome → badge colour, a run's outcome
 * from its status, times in the job's own timezone, and the Run-now toast text.
 */

export type BadgeColor = 'success' | 'neutral' | 'error' | 'warning' | 'info'

/** Job/run outcome → badge colour: spoke success, silent neutral, failed error, skipped warning. */
export function outcomeColor(outcome: string | null | undefined): BadgeColor {
  switch (outcome) {
    case 'spoke': return 'success'
    case 'silent': return 'neutral'
    case 'failed': return 'error'
    case 'skipped': return 'warning'
    case 'queued':
    case 'running': return 'info'
    default: return 'neutral'
  }
}

export interface JobRunRow {
  id: string
  status: string
  suppressed: boolean
  createdAt: string
  durationMs: number | null
  conversationId: string | null
  assistantMessageId: string | null
}

/**
 * A run's outcome from its agent_runs status (mirrors server jobOutcomeOf): a finished run spoke
 * or stayed silent (NO_REPLY → suppressed); failed/aborted/interrupted all read as failed; a run
 * still in the queue shows its live status.
 */
export function runOutcome(run: Pick<JobRunRow, 'status' | 'suppressed'>): 'spoke' | 'silent' | 'failed' | 'queued' | 'running' {
  if (run.status === 'done') return run.suppressed ? 'silent' : 'spoke'
  if (run.status === 'queued' || run.status === 'running') return run.status
  return 'failed'
}

/** The thread link for a run: only a run that spoke left a message worth opening. */
export function runThreadLink(run: JobRunRow): string | null {
  if (runOutcome(run) !== 'spoke' || !run.conversationId) return null
  return `/agent?c=${encodeURIComponent(run.conversationId)}`
}

/** Absolute time in the job's timezone, e.g. "Mon, Sep 28, 7:30 AM EDT". An unknown or missing
 *  timezone falls back to the browser's. */
export function formatInZone(iso: string, timeZone: string | null | undefined): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }
  const d = new Date(iso)
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timeZone ?? undefined }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(d)
  }
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY]
]

/** "in 5 minutes" / "3 hours ago", relative to `now`. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  let value = (new Date(iso).getTime() - now.getTime()) / 1000
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
  for (const [unit, size] of RELATIVE_STEPS) {
    // Compare the ROUNDED value, or 59.6 minutes reads "in 60 minutes" instead of "in 1 hour".
    if (Math.abs(Math.round(value)) < size) return rtf.format(Math.round(value), unit)
    value /= size
  }
  return rtf.format(Math.round(value), 'year')
}

/**
 * For something that has already happened (a run, the last run). The pages refresh `now` only
 * every 30 s, so a run created since reads as slightly in the future; anything under a minute
 * either side is "just now".
 */
export function formatAgo(iso: string, now: Date = new Date()): string {
  if (Math.abs(new Date(iso).getTime() - now.getTime()) < 60_000) return 'just now'
  return formatRelative(iso, now)
}

/** "850 ms", "12 s", "2 m 5 s"; null (still running) → "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} m ${s % 60} s`
}

export type RunNowResult = { runId: string } | { skipped: 'overlap' | 'disabled' | 'invalid' }

/** The toast for POST /api/jobs/:slug/run. A skip is reported plainly, not as an error. */
export function runNowToast(res: RunNowResult): { color: BadgeColor, title: string, description: string } {
  if ('runId' in res) return { color: 'success', title: 'Run started', description: 'The run shows below as soon as it is queued.' }
  const why = {
    overlap: 'a run of this job is already in progress',
    disabled: 'the job is disabled — enable it first',
    invalid: 'the job does not parse — fix it first'
  }[res.skipped]
  return { color: 'warning', title: `skipped: ${res.skipped}`, description: why }
}
