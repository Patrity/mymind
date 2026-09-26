// The four ways a memory conflict can end.
//
// The review surface used to offer two — "keep both" and "accept (archive old)" — which
// silently assumed the NEW memory is always the better one. It often isn't: enrichment can
// produce a worse restatement of a fact you already had, or both sides can be stale. Those
// cases had no button, so the only way to express them was to keep both and clean up later.

/** What to do with the pair. `new` and `old` are the two memories in the conflict. */
export type ConflictResolution =
  /** Both are right (often: different projects). Archive nothing, resolve the relation. */
  | 'keep-both'
  /** The new one supersedes the old. Archive old, point it at new. (The old `approve`.) */
  | 'archive-old'
  /** The new one is the worse restatement. Archive it; the existing memory stands. */
  | 'archive-new'
  /** Both are stale or wrong. Archive the pair. */
  | 'archive-both'

export const CONFLICT_RESOLUTIONS: readonly ConflictResolution[] =
  ['keep-both', 'archive-old', 'archive-new', 'archive-both'] as const

export function isConflictResolution(v: unknown): v is ConflictResolution {
  return typeof v === 'string' && (CONFLICT_RESOLUTIONS as readonly string[]).includes(v)
}

/**
 * Which memory ids to archive for a resolution, and which id (if any) supersedes them.
 *
 * Pure so the mapping is testable without a database — the archiving itself is three lines
 * of drizzle, but getting WHICH rows to archive wrong is silent and destructive, so the
 * decision is separated from the write.
 *
 * `supersededBy` is only set when one memory genuinely replaces another. Archiving both
 * leaves it null: neither survives, so neither can be the successor, and pointing a dead row
 * at another dead row would make the supersede chain lie.
 */
export function archivalPlan(
  resolution: ConflictResolution,
  ids: { newId: string, existingId: string }
): { archive: string[], supersededBy: string | null } {
  switch (resolution) {
    case 'keep-both': return { archive: [], supersededBy: null }
    case 'archive-old': return { archive: [ids.existingId], supersededBy: ids.newId }
    case 'archive-new': return { archive: [ids.newId], supersededBy: ids.existingId }
    case 'archive-both': return { archive: [ids.existingId, ids.newId], supersededBy: null }
  }
}

/** The queue row's terminal status. Only "keep both" is a rejection of the proposal. */
export function queueStatusFor(resolution: ConflictResolution): 'approved' | 'rejected' {
  return resolution === 'keep-both' ? 'rejected' : 'approved'
}
