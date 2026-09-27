import { describe, it, expect, vi } from 'vitest'
import { framesOnOpen } from './reconnect'

describe('framesOnOpen', () => {
  it('re-sends load + attach for the thread on screen (a reconnect restores the view)', () => {
    const shouldAttach = vi.fn(() => true)
    const frames = framesOnOpen({ presetId: 'p1', modelDefId: 'm1', conversationId: 'c1', shouldAttach })
    expect(frames).toEqual([
      { type: 'preset', presetId: 'p1' },
      { type: 'model', modelDefId: 'm1' },
      { type: 'load', conversationId: 'c1' },
      { type: 'attach' }
    ])
    expect(shouldAttach).toHaveBeenCalledWith('c1')
  })

  it('sends neither load nor attach when no thread is viewed', () => {
    expect(framesOnOpen({ presetId: '', modelDefId: null, conversationId: null, shouldAttach: () => true }))
      .toEqual([{ type: 'preset', presetId: '' }])
  })

  it('loads but does not re-attach when the attach is already recorded for this thread', () => {
    expect(framesOnOpen({ presetId: '', modelDefId: null, conversationId: 'c1', shouldAttach: () => false }))
      .toEqual([{ type: 'preset', presetId: '' }, { type: 'load', conversationId: 'c1' }])
  })
})
