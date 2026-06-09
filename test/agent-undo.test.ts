// test/agent-undo.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerUndo, runUndo, hasUndo } from '../server/lib/agent/undo'

describe('undo store', () => {
  it('registers, runs once, then forgets the token', async () => {
    const fn = vi.fn(async () => {})
    const token = registerUndo(fn)
    expect(hasUndo(token)).toBe(true)
    expect(await runUndo(token)).toBe(true)
    expect(fn).toHaveBeenCalledOnce()
    expect(hasUndo(token)).toBe(false)
    expect(await runUndo(token)).toBe(false) // already consumed
  })

  it('returns false for an unknown token', async () => {
    expect(await runUndo('nope')).toBe(false)
  })
})
