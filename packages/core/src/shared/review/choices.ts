// shared/review/choices.ts
//
// The ONE registry of what a /review item can be decided as (cycle 76, spec §7a). The /review page
// renders its buttons and menus from it, and Bridget's list_reviews / decide_review tools list and
// validate against it, so the page and the tools can't offer different outcomes for one item.

export interface ReviewChoice { id: string; label: string; description: string; tone?: 'primary' | 'neutral' | 'error' }

/** The four ways a memory conflict can end — mirrors ConflictResolution
 *  (server/lib/review/conflict-resolution.ts), which the server validates against. */
export type ConflictChoiceId = 'keep-both' | 'archive-old' | 'archive-new' | 'archive-both'

export const MEMORY_CONFLICT_KINDS: ReadonlySet<string> = new Set(['memory-supersede', 'memory-contradict'])

/** The toast the /review page shows after each conflict resolution. */
export const CONFLICT_TOAST: Record<ConflictChoiceId, { title: string, description: string, color: 'success' | 'neutral' | 'warning' }> = {
  'keep-both': { title: 'Both memories kept', description: 'Nothing archived — the conflict is marked resolved.', color: 'neutral' },
  'archive-old': { title: 'Old memory archived', description: 'The new memory supersedes it.', color: 'success' },
  'archive-new': { title: 'New memory archived', description: 'The existing memory stands.', color: 'warning' },
  'archive-both': { title: 'Both memories archived', description: 'Neither is kept.', color: 'warning' }
}

function conflictChoices(kind: string): ReviewChoice[] {
  // Only the supersede case says "(accept)": accepting a supersede IS archiving the old one.
  const isSupersede = kind === 'memory-supersede'
  return [
    { id: 'keep-both', label: 'Keep both', description: 'Both are right (often: different projects). Archive nothing; the conflict is marked resolved.', tone: 'neutral' },
    { id: 'archive-old', label: isSupersede ? 'Archive old (accept)' : 'Archive old', description: 'The new memory supersedes the existing one. Archive the existing memory.' },
    { id: 'archive-new', label: 'Archive new', description: 'The new memory is the worse restatement. Archive it; the existing memory stands.' },
    { id: 'archive-both', label: 'Archive both', description: 'Both are stale or wrong. Archive the pair.', tone: 'error' }
  ]
}

export function reviewChoices(item: { kind: string }): ReviewChoice[] {
  if (MEMORY_CONFLICT_KINDS.has(item.kind)) return conflictChoices(item.kind)
  if (item.kind === 'memory-unreviewed') {
    return [
      { id: 'approve', label: 'Mark reviewed', description: 'Keep the memory: mark it reviewed so it is used as a reviewed fact.', tone: 'primary' },
      { id: 'reject', label: 'Discard', description: 'Forget the memory: archive it (not deleted; undoable).', tone: 'neutral' }
    ]
  }
  return [
    { id: 'approve', label: 'Approve', description: 'Apply the proposal.', tone: 'primary' },
    { id: 'reject', label: 'Reject', description: 'Discard the proposal; nothing is applied.', tone: 'neutral' }
  ]
}
