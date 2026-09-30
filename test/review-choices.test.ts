// test/review-choices.test.ts — the shared review-choices registry (cycle 76, Task 9).
import { describe, it, expect } from 'vitest'
import { reviewChoices, CONFLICT_TOAST } from '../shared/review/choices'

const ids = (kind: string) => reviewChoices({ kind }).map(c => c.id)
const labels = (kind: string) => reviewChoices({ kind }).map(c => c.label)

describe('reviewChoices', () => {
  it('memory-supersede: the four resolutions, labelled as /review labels them', () => {
    expect(ids('memory-supersede')).toEqual(['keep-both', 'archive-old', 'archive-new', 'archive-both'])
    expect(labels('memory-supersede')).toEqual(['Keep both', 'Archive old (accept)', 'Archive new', 'Archive both'])
  })

  it('memory-contradict: the same four; "Archive old" without "(accept)"', () => {
    expect(ids('memory-contradict')).toEqual(['keep-both', 'archive-old', 'archive-new', 'archive-both'])
    expect(labels('memory-contradict')).toEqual(['Keep both', 'Archive old', 'Archive new', 'Archive both'])
  })

  it('archive-both is the destructive-toned choice', () => {
    expect(reviewChoices({ kind: 'memory-supersede' }).find(c => c.id === 'archive-both')!.tone).toBe('error')
  })

  it('memory-unreviewed: Mark reviewed / Discard (the page\'s words)', () => {
    expect(reviewChoices({ kind: 'memory-unreviewed' }).map(c => [c.id, c.label])).toEqual([['approve', 'Mark reviewed'], ['reject', 'Discard']])
  })

  it.each(['self-improvement', 'agent-action', 'triage', 'enrichment', 'anything-else'])('%s: Approve / Reject', (kind) => {
    expect(reviewChoices({ kind }).map(c => [c.id, c.label])).toEqual([['approve', 'Approve'], ['reject', 'Reject']])
  })

  it('every choice carries a description (the tool shows it to Bridget)', () => {
    for (const kind of ['memory-supersede', 'memory-unreviewed', 'triage']) {
      for (const c of reviewChoices({ kind })) expect(c.description.length).toBeGreaterThan(10)
    }
  })

  it('conflict toasts keep the page wording', () => {
    expect(CONFLICT_TOAST).toEqual({
      'keep-both': { title: 'Both memories kept', description: 'Nothing archived — the conflict is marked resolved.', color: 'neutral' },
      'archive-old': { title: 'Old memory archived', description: 'The new memory supersedes it.', color: 'success' },
      'archive-new': { title: 'New memory archived', description: 'The existing memory stands.', color: 'warning' },
      'archive-both': { title: 'Both memories archived', description: 'Neither is kept.', color: 'warning' }
    })
  })
})
