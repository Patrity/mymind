/**
 * Confidence gate for the one-time applicability backfill.
 *
 * `project` is the pre-existing behaviour, so a wrong 'project' costs nothing new while a wrong
 * 'global' leaks a project-bound fact into every other project's context. The gate is therefore
 * deliberately asymmetric in its consequences, and anything malformed lands in review rather
 * than defaulting to the permissive answer.
 */
export type ApplicabilityDecision = 'global' | 'project' | 'review'

export function decideApplicability(
  noul: number,
  opts: { high?: number, low?: number } = {}
): ApplicabilityDecision {
  const high = opts.high ?? 0.9
  const low = opts.low ?? 0.1
  if (!Number.isFinite(noul) || noul < 0 || noul > 1) return 'review'
  if (noul >= high) return 'global'
  if (noul <= low) return 'project'
  return 'review'
}

/**
 * RULING 18 (task-9 fix round 1): should a `review` verdict from `decideApplicability` file
 * a `review_queue` row for a human?
 *
 * No — not right now. Over the live store (1,599 memories) the classifier's raw `noul` is
 * compressed in the middle — p25 0.63, median 0.75, p75 0.84 on a 0-1 scale — so only 7.8%
 * of scores fell outside the 0.9/0.1 gate at all. Queueing the other 92.2% put 1,475
 * low-value `applicability` rows into `review_queue`, burying the surface's other kinds (4
 * memory-contradict, 17 triage, 10 enrichment) under noise none of Tony's review time should
 * go to. A `review` verdict now leaves the memory at its pre-existing `applicability =
 * 'project'` default — a no-op, not a regression — and `global` promotion is expected to
 * come from the resident-promotion / retrieval-count path instead: a memory that's actually
 * reused across projects is a measured signal, unlike one model's opinion on a distribution
 * too flat to gate confidently.
 *
 * Kept as its own function (rather than inlined at the call site) so this policy has an
 * independent unit test and so resurrecting it later — if the classifier or its calibration
 * improves — is a one-line change here, not a rewrite of the backfill script.
 */
export function shouldEnqueueReview(_decision: ApplicabilityDecision): boolean {
  return false
}
