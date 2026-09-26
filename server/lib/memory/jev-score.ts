/**
 * Jev as a SECOND opinion on an unreviewed memory.
 *
 * Enrichment already attaches its own `confidence` when it writes a memory. That number is
 * the writer grading its own work. This is an independent read of the same text, so the two
 * can disagree — which is the whole point of showing them side by side.
 *
 * ## What this is calibrated on, and what that permits
 *
 * 28 hand labels (16 keep / 8 stale / 4 noise) scored against Jev's answers. Measured AUC
 * with bootstrap CIs:
 *
 *   transient      → noise   AUC 0.81  [0.62, 0.96]   the only SIGNIFICANT signal
 *   rederivable    → noise   AUC 0.62  [0.19, 0.89]   directionally right, not significant
 *   names_specific → noise   AUC 0.39                 inverted (specific ⇒ less noise)
 *   states_reason  → noise   AUC 0.48                 nothing
 *   value (score)  → noise   AUC 0.27                 ANTI-correlated — actively misleading
 *
 * The lesson in that table is that the OBSERVABLE questions carry the signal and the TASTE
 * question ("how valuable is this?") does not — it asks Jev to guess Tony's judgement rather
 * than read the text. So the taste question is not asked here at all.
 *
 * What this permits: ORDERING a review queue, which only needs to beat random, and 0.81
 * clears that. What it does NOT permit: a drop threshold. With 4 noise examples every cutoff
 * priced out at or below the 43% base rate — it would discard more keepers than junk. So
 * nothing here deletes anything; it sorts, and a human still decides.
 *
 * ## Why the raw answers are stored
 *
 * The expensive half is the API call; the weighting below is a pure function over its
 * output. Storing `answers` means a better weighting — once there are more labels — is a
 * recompute, not 2,600 more API calls.
 */

/** One Noul answer: a probability in [0,1] that the statement is true of the memory. */
export interface JevAnswers {
  /** "describes a point-in-time snapshot" — high means transient. The load-bearing signal. */
  transient: number
  /** "could be re-derived in under five minutes by reading the code" — high means cheap. */
  rederivable: number
  /** "names at least one specific identifier a person could look up" — high means concrete. */
  names_specific: number
  /** "explains a cause, a constraint or a rationale" — high means it carries a WHY. */
  states_reason: number
}

/**
 * The questions, verbatim. Kept identical to the wording used for the 2026-09-22 labelled
 * sample — changing a question invalidates the calibration above, so they are pinned here
 * rather than written inline at the call site.
 */
export const JEV_QUESTIONS = {
  transient: {
    type: 'noul',
    instructions: 'This describes a point-in-time snapshot: a current status, an active branch, a task in progress, or what someone was doing at the time'
  },
  rederivable: {
    type: 'noul',
    instructions: 'An engineer unfamiliar with this could re-derive this fact in under five minutes by reading the code or running a single command'
  },
  names_specific: {
    type: 'noul',
    instructions: 'This names at least one specific identifier a person could look up: a file path, a command, a config key, an endpoint, an error message, or a concrete number'
  },
  states_reason: {
    type: 'noul',
    instructions: 'This explains a cause, a constraint or a rationale, rather than only stating what is the case'
  }
} as const

/**
 * Weights, oriented so every term reads as "evidence this is worth keeping".
 *
 * `transient` dominates because it is the only one whose confidence interval excludes 0.5.
 * The other three are deliberately small: they are directionally sensible and individually
 * unproven, so they may nudge an ordering but must never drive it. If more labels later show
 * one of them carries real signal, this block is the only thing that changes.
 */
const W = {
  notTransient: 0.60,
  notRederivable: 0.15,
  namesSpecific: 0.15,
  statesReason: 0.10
} as const

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Collapse the answers into one 0-1 score, oriented the SAME WAY as `memories.confidence`:
 * **higher means more likely worth keeping**. That orientation is what lets the UI show it
 * beside confidence without a reader having to remember which way each one points.
 *
 * Returns null when a required answer is missing rather than silently scoring a partial
 * response — an absent signal is not the same as a zero, and a memory with no score should
 * sort as unknown, not as junk.
 */
export function jevKeepScore(answers: Partial<JevAnswers> | null | undefined): number | null {
  if (!answers) return null
  const { transient, rederivable, names_specific, states_reason } = answers
  if ([transient, rederivable, names_specific, states_reason].some(v => typeof v !== 'number' || Number.isNaN(v))) {
    return null
  }
  const score =
    W.notTransient * (1 - clamp01(transient!)) +
    W.notRederivable * (1 - clamp01(rederivable!)) +
    W.namesSpecific * clamp01(names_specific!) +
    W.statesReason * clamp01(states_reason!)
  return clamp01(score)
}

/**
 * Queue order: least likely to be worth keeping FIRST, so the junk is the first thing on
 * screen and clearing it is a short burst rather than a scroll.
 *
 * Unscored memories (null) sort AFTER every scored one. They are unknown, not bad, and
 * putting them at the top would bury the thing this ordering exists to surface. Ties — and
 * the unscored block — fall back to newest-first, which is the order the queue had before.
 */
export function compareByJev<T extends { jevScore: number | null, createdAt: Date }>(a: T, b: T): number {
  const aHas = a.jevScore !== null
  const bHas = b.jevScore !== null
  if (aHas !== bHas) return aHas ? -1 : 1
  if (aHas && bHas && a.jevScore !== b.jevScore) return a.jevScore! - b.jevScore!
  return b.createdAt.getTime() - a.createdAt.getTime()
}
