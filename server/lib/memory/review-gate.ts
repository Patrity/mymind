// The post-scoring review gate (2026-10-02, after the cycle 77 backfill analysis).
//
// Enrichment memories are now auto-reviewed on insert (the extraction-confidence threshold is
// gone — on prod it correlated r=0.13 / 0.08 with the audit and Jev). Once a new memory is scored,
// it goes back to /review ONLY when BOTH scorers flag it as stale. Tony's labels on the
// disagreement cells: a lone audit flag was wrong 12/15, a lone Jev flag wrong 14/15 — a single
// flag is noise, the conjunction is the signal (the 259 both-flag rows read as genuinely stale).
//
// Pure: the caller loads the row and writes the outcome (server/services/memory-scoring.ts).

import { AUDIT_PROMPT_VERSION } from './extract-v3'

/** Jev's `transient` answer at or above this flags the memory (its only validated question). */
export const GATE_JEV_TRANSIENT = 0.6
/** Audit verdicts that flag the memory. `belongs_in_doc` is not staleness, so it never holds. */
export const GATE_AUDIT_FLAGS: readonly string[] = ['transient', 'redundant', 'wrong_scope']

export interface GateRow {
  jevScoredAt: Date | null
  jevAnswers: unknown
  jevFailures: number
  auditPromptVersion: string | null
  auditVerdict: string | null
  auditFailures: number
}

export interface GateOpts {
  jevConfigured: boolean
  maxFailures: number
}

/**
 * `hold` = both scorers flag it → back to /review. `pass` = it stays reviewed; decided as soon as
 * EITHER settled part does not flag (the other can no longer make it a hold), or a part is
 * permanently missing (Jev off / failure cap). `wait` = a part is still pending and could flag.
 */
export type GateDecision = 'hold' | 'pass' | 'wait'

export function jevTransient(answers: unknown): number | null {
  const t = (answers as Record<string, unknown> | null)?.transient
  return typeof t === 'number' && !Number.isNaN(t) ? t : null
}

export function reviewGateDecision(row: GateRow, opts: GateOpts): GateDecision {
  const jevDone = row.jevScoredAt != null
  const auditDone = row.auditPromptVersion === AUDIT_PROMPT_VERSION
  const jevGone = !opts.jevConfigured || (!jevDone && row.jevFailures >= opts.maxFailures)
  const auditGone = !auditDone && row.auditFailures >= opts.maxFailures

  const t = jevDone ? jevTransient(row.jevAnswers) : null
  const jevFlag = t != null && t >= GATE_JEV_TRANSIENT
  const auditFlag = auditDone && row.auditVerdict != null && GATE_AUDIT_FLAGS.includes(row.auditVerdict)

  // A part that can never flag decides it: no conjunction possible.
  if (jevGone || auditGone) return 'pass'
  if ((jevDone && !jevFlag) || (auditDone && !auditFlag)) return 'pass'
  if (jevFlag && auditFlag) return 'hold'
  return 'wait'
}
