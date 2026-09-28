// server/lib/channels/backoff.ts
// Retry schedule for outbound channel sends (imessage/email). 30s, 2m, 10m, then 1h x3, then give up.

export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000] as const
export const MAX_ATTEMPTS = BACKOFF_MS.length

/**
 * Delay before the next send attempt, given the number of attempts already made.
 *
 * Contract (ruling 2 — the `channel_outbound` ledger's `attempts` column counts sends made, not
 * retries remaining): after the n-th failed send, the caller checks `n >= MAX_ATTEMPTS` first —
 * if true, the row goes `failed`; otherwise it calls `nextAttemptDelayMs(n - 1)` to get the delay
 * before attempt n+1. This function itself just indexes `BACKOFF_MS` by `attemptsSoFar` and
 * returns `null` once `attemptsSoFar` reaches `MAX_ATTEMPTS` — the `n - 1` offset and the
 * `>= MAX_ATTEMPTS` guard are the caller's (Task 6's) responsibility, not this function's.
 */
export function nextAttemptDelayMs(attemptsSoFar: number): number | null {
  return attemptsSoFar < MAX_ATTEMPTS ? BACKOFF_MS[attemptsSoFar]! : null
}
