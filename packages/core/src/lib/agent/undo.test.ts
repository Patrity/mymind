import { describe, it, expect } from 'vitest'
import { registerUndo, runUndo, hasUndo } from './undo'

describe('runUndo', () => {
  it('normalises a void-returning closure to ok:true — the ~18 untouched closures', async () => {
    let ran = false
    const token = registerUndo(async () => { ran = true })
    expect(await runUndo(token)).toEqual({ ok: true })
    expect(ran).toBe(true)
  })

  it('passes a refusal through with its reason', async () => {
    const token = registerUndo(async () => ({ ok: false, reason: 'document changed' }))
    expect(await runUndo(token)).toEqual({ ok: false, reason: 'document changed' })
  })

  it('KEEPS the token when the closure refuses, so the caller can retry', async () => {
    const token = registerUndo(async () => ({ ok: false, reason: 'document changed' }))
    await runUndo(token)
    expect(hasUndo(token)).toBe(true)
  })

  it('consumes the token on success', async () => {
    const token = registerUndo(async () => {})
    await runUndo(token)
    expect(hasUndo(token)).toBe(false)
  })

  it('reports an unknown token without throwing', async () => {
    expect(await runUndo('nope')).toEqual({ ok: false, reason: 'undo expired or already used' })
  })
})
