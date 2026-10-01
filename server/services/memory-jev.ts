// The queue scorer (the `score-memories` task): every run scores a batch of live memories so the
// review queue can put the likely junk first and /memories can show both scores.
//
// Deliberately narrow: this ONLY reads memories and writes the jev_* and audit_* columns, through
// the one shared scoring path (server/services/memory-scoring.ts). It never archives, never marks
// anything reviewed, and never touches `confidence`. The Jev calibration supports an ORDERING,
// not a decision — see server/lib/memory/jev-score.ts.

import { jevConfig } from '../lib/ai/jev'
import { scoreMemories, selectUnscored, type ScoreDeps } from './memory-scoring'

export interface JevScoreRunResult {
  considered: number
  scored: number
  failed: number
  /** The audit runs on the same rows (one scoring path); counted separately. */
  audited?: number
  auditFailed?: number
  skipped?: 'not-configured'
}

/**
 * Score up to `limit` live memories missing a Jev score or a current audit.
 *
 * Spec D2 (cycle 77): every live memory gets both scores, REVIEWED ones included — /memories
 * sorts and filters by them, not just the review queue. Unreviewed rows still go first (they are
 * what the queue orders), then oldest. Already-scored parts are skipped and a part that failed 3
 * times is left alone, so repeated runs walk forward through the backlog instead of redoing it.
 *
 * `onlyIds` / `deps` are test seams (shared dev DB, no real Jev or model calls in tests).
 */
export async function runJevScoring(
  opts: { limit?: number, onlyIds?: string[], deps?: ScoreDeps } = {}
): Promise<JevScoreRunResult> {
  const limit = opts.limit ?? 50
  // Assigned in Settings → AI → Assignments, like every other model. Unassigned is a normal
  // state, not an error: Jev is an optional second opinion and the queue renders an unscored
  // memory as "unknown".
  const cfg = opts.deps?.cfg !== undefined ? opts.deps.cfg : await jevConfig()
  if (!cfg) return { considered: 0, scored: 0, failed: 0, skipped: 'not-configured' }

  const ids = await selectUnscored(limit, { onlyIds: opts.onlyIds })
  if (!ids.length) return { considered: 0, scored: 0, failed: 0, audited: 0, auditFailed: 0 }

  const results = await scoreMemories(ids, { ...opts.deps, cfg })
  const count = (pred: (r: (typeof results)[number]) => boolean) => results.filter(pred).length
  return {
    considered: ids.length,
    scored: count(r => r.jev === 'scored'),
    failed: count(r => r.jev === 'failed'),
    audited: count(r => r.audit === 'scored'),
    auditFailed: count(r => r.audit === 'failed')
  }
}
