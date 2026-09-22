import { describe, it, expect } from 'vitest'
import { siblingTarget, precedingUserMessage, restorableLeafId } from './branching'
import { toUIMessages, type ResumeMessage } from './to-ui-messages'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

// A three-way branch as the SERVER hands it over: siblingIds in creation order, 1-based index,
// and the invariant msgToDTO guarantees — siblingIds[index - 1] === id.
const SIBS = ['aaa', 'bbb', 'ccc']

describe('siblingTarget — which branch ‹ / › switches to', () => {
  // These are the assertions that catch an off-by-one. Each names the EXACT id expected, so
  // shifting the pick one slot either way changes a value rather than merely a count:
  // `(index) + dir` re-selects the branch already on screen going back, and runs off the end
  // going forward; `(index - 2) + dir` does the mirror image.
  it('‹ from 2/3 goes to the FIRST sibling, not to itself', () => {
    expect(siblingTarget(SIBS, 2, -1)).toBe('aaa')
  })

  it('› from 2/3 goes to the THIRD sibling, not off the end', () => {
    expect(siblingTarget(SIBS, 2, 1)).toBe('ccc')
  })

  it('› from 1/3 goes to the SECOND sibling — the one after the one on screen', () => {
    expect(siblingTarget(SIBS, 1, 1)).toBe('bbb')
  })

  it('‹ from 3/3 goes to the SECOND sibling', () => {
    expect(siblingTarget(SIBS, 3, -1)).toBe('bbb')
  })

  it('honours the server invariant: the pick is never the message on screen', () => {
    // siblingIds[index - 1] is the current message. Whatever the direction, the target must
    // differ from it — an off-by-one in either direction breaks exactly this.
    for (const index of [1, 2, 3]) {
      for (const dir of [-1, 1] as const) {
        const target = siblingTarget(SIBS, index, dir)
        if (target !== undefined) expect(target).not.toBe(SIBS[index - 1])
      }
    }
  })

  it('every in-range step lands on the immediate neighbour', () => {
    expect([1, 2, 3].map(i => siblingTarget(SIBS, i, -1))).toEqual([undefined, 'aaa', 'bbb'])
    expect([1, 2, 3].map(i => siblingTarget(SIBS, i, 1))).toEqual(['bbb', 'ccc', undefined])
  })

  it('does not wrap at either end — the arrows are disabled there', () => {
    expect(siblingTarget(SIBS, 1, -1)).toBeUndefined()
    expect(siblingTarget(SIBS, 3, 1)).toBeUndefined()
  })

  it('a lone trunk message (no siblingIds, no index) has no neighbour either way', () => {
    expect(siblingTarget(undefined, undefined, -1)).toBeUndefined()
    expect(siblingTarget(undefined, undefined, 1)).toBeUndefined()
    expect(siblingTarget(['only'], 1, 1)).toBeUndefined()
    expect(siblingTarget(['only'], 1, -1)).toBeUndefined()
  })

  it('is fed by what toUIMessages actually produces, not a hand-built shape', () => {
    // Guards the seam as well as the arithmetic: if the transform ever drops branch/siblingIds
    // again (the Ruling 15 bug), this stops finding a target.
    const rows: ResumeMessage[] = [
      { id: 'bbb', role: 'user', content: 'take two', branch: { index: 2, total: 3 }, siblingIds: SIBS }
    ]
    const [m] = toUIMessages(rows)
    expect(siblingTarget(m!.metadata?.siblingIds, m!.metadata?.branch?.index, -1)).toBe('aaa')
    expect(siblingTarget(m!.metadata?.siblingIds, m!.metadata?.branch?.index, 1)).toBe('ccc')
  })
})

const ui = (id: string, role: 'user' | 'assistant', extra?: AgentUIMessage['metadata']): AgentUIMessage => ({
  id, role, parts: [{ type: 'text', text: id, state: 'done' }], ...(extra ? { metadata: extra } : {})
})

describe('precedingUserMessage — what regenerate re-sends', () => {
  const path = [ui('u1', 'user'), ui('a1', 'assistant'), ui('u2', 'user'), ui('a2', 'assistant')]

  it('picks the question directly above the reply, not the first one on the path', () => {
    expect(precedingUserMessage(path, 'a2')?.id).toBe('u2')
    expect(precedingUserMessage(path, 'a1')?.id).toBe('u1')
  })

  it('skips assistant messages on the way back', () => {
    const withTools = [ui('u1', 'user'), ui('a0', 'assistant'), ui('a1', 'assistant')]
    expect(precedingUserMessage(withTools, 'a1')?.id).toBe('u1')
  })

  it('is null for a message that is not on the active path', () => {
    expect(precedingUserMessage(path, 'nope')).toBeNull()
  })

  it('is null when nothing above it is a user message', () => {
    expect(precedingUserMessage(path, 'u1')).toBeNull()
  })
})

describe('restorableLeafId — the id a stranded branch move can be put back to', () => {
  const persisted = (id: string, role: 'user' | 'assistant' = 'assistant') =>
    ui(id, role, { branch: { index: 1, total: 1 }, siblingIds: [id] })

  it('is the tail of the active path when the tail is a persisted row', () => {
    expect(restorableLeafId([persisted('r1', 'user'), persisted('r2')])).toBe('r2')
  })

  it('refuses a tail that is still the live stream — its id is a stream uuid, not a row id', () => {
    // The page skips the post-turn re-read when the tail carries a client-only marker, so this
    // is reachable: PATCHing that id 404s, and falling back to r1 would point the leaf one turn
    // too far back and truncate the thread.
    expect(restorableLeafId([persisted('r1', 'user'), ui('stream-uuid', 'assistant')])).toBeUndefined()
  })

  it('refuses a tail whose siblingIds do not contain its own id', () => {
    // Not a shape the server produces (msgToDTO falls back to [r.id]), so it means the metadata
    // came from somewhere else and cannot be trusted to name a row.
    expect(restorableLeafId([ui('x', 'assistant', { siblingIds: ['y', 'z'] })])).toBeUndefined()
  })

  it('is undefined for an empty transcript', () => {
    expect(restorableLeafId([])).toBeUndefined()
  })
})
