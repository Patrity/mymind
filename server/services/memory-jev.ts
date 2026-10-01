// The queue scorer (the `score-memories` task): every run scores a batch of unreviewed memories so the
// review queue can put the likely junk first and /memories can show both scores.
//
// Deliberately narrow: this ONLY reads memories and writes the jev_* and audit_* columns, through
// the one shared scoring path (server/services/memory-scoring.ts). It never archives, never marks
// anything reviewed, and never touches `confidence`. The Jev calibration supports an ORDERING,
// not a decision — see server/lib/memory/jev-score.ts.

import { resolveJevCfg, scoreMemories, selectUnscored, type ScoreDeps } from './memory-scoring'

/** Rows this new are scored by the cron whatever their review state (final review M1). */
export const RECENT_MEMORY_DAYS = 7

export interface JevScoreRunResult {
  considered: number
  scored: number
  /** Jev CONTENT failures (counted against the row). */
  failed: number
  /** The audit runs on the same rows (one scoring path); counted separately. */
  audited?: number
  auditFailed?: number
  /** A transport failure (Jev or the bulk chain unreachable) stopped the batch early. */
  stoppedEarly?: boolean
  /** Jev is unassigned: only the audit ran. */
  jev?: 'not-configured'
}

/**
 * Score up to `limit` live memories missing a Jev score or a current audit that are UNREVIEWED or
 * were created in the last RECENT_MEMORY_DAYS days.
 *
 * Unreviewed: this cron exists to order the review queue. Recent: most new memories auto-review,
 * and their scoring is a fire-and-forget right after creation — when that hits an outage, the cron
 * retries them (otherwise, once the backfill is `done`, nothing would). The full-population walk
 * (spec D2, older reviewed rows included) runs ONLY through the switch-gated backfill, so that
 * spend starts when Tony turns it on. Already-scored parts are skipped and a part with 3 content failures is left
 * alone, so repeated runs walk forward through the backlog instead of redoing it.
 *
 * Jev unassigned (Settings → AI → Assignments) is a normal state: the audit still runs and a
 * missing Jev score doesn't keep a row selected.
 *
 * `onlyIds` / `deps` are test seams (shared dev DB, no real Jev or model calls in tests).
 */
export async function runJevScoring(
  opts: { limit?: number, onlyIds?: string[], deps?: ScoreDeps } = {}
): Promise<JevScoreRunResult> {
  const limit = opts.limit ?? 50
  const cfg = await resolveJevCfg(opts.deps)
  const now = opts.deps?.now ?? new Date()
  const ids = await selectUnscored(limit, {
    onlyIds: opts.onlyIds,
    unreviewedOnly: true,
    orCreatedSince: new Date(now.getTime() - RECENT_MEMORY_DAYS * 86_400_000),
    jevConfigured: cfg !== null
  })

  const results = await scoreMemories(ids, { ...opts.deps, cfg })
  const count = (pred: (r: (typeof results)[number]) => boolean) => results.filter(pred).length
  return {
    considered: ids.length,
    scored: count(r => r.jev === 'scored'),
    failed: count(r => r.jev === 'failed'),
    audited: count(r => r.audit === 'scored'),
    auditFailed: count(r => r.audit === 'failed'),
    stoppedEarly: results.some(r => r.jev === 'unavailable' || r.audit === 'unavailable'),
    ...(cfg ? {} : { jev: 'not-configured' as const })
  }
}
