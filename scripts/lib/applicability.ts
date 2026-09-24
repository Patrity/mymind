/**
 * Confidence gate for the one-time applicability backfill.
 *
 * `project` is the pre-existing behaviour, so a wrong 'project' costs nothing new while a wrong
 * 'global' leaks a project-bound fact into every other project's context. The gate is therefore
 * deliberately asymmetric in its consequences, and anything malformed lands in review rather
 * than defaulting to the permissive answer.
 */
export function decideApplicability(
  noul: number,
  opts: { high?: number, low?: number } = {}
): 'global' | 'project' | 'review' {
  const high = opts.high ?? 0.9
  const low = opts.low ?? 0.1
  if (!Number.isFinite(noul) || noul < 0 || noul > 1) return 'review'
  if (noul >= high) return 'global'
  if (noul <= low) return 'project'
  return 'review'
}
