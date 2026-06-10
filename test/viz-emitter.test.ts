import { describe, it, expect, vi } from 'vitest'
import { createEmitter } from '../app/lib/viz/emitter'

describe('createEmitter', () => {
  it('delivers events to subscribers', () => {
    const em = createEmitter<{ type: string }>()
    const cb = vi.fn()
    em.on(cb)
    em.emit({ type: 'bargein' })
    expect(cb).toHaveBeenCalledWith({ type: 'bargein' })
  })

  it('delivers to multiple subscribers', () => {
    const em = createEmitter<number>()
    const a = vi.fn()
    const b = vi.fn()
    em.on(a)
    em.on(b)
    em.emit(42)
    expect(a).toHaveBeenCalledWith(42)
    expect(b).toHaveBeenCalledWith(42)
  })

  it('unsubscribe stops delivery', () => {
    const em = createEmitter<number>()
    const cb = vi.fn()
    const off = em.on(cb)
    off()
    em.emit(1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('a subscriber unsubscribing during emit does not break other subscribers', () => {
    const em = createEmitter<number>()
    const calls: string[] = []
    const offA = em.on(() => { calls.push('a'); offA() })
    em.on(() => calls.push('b'))
    em.emit(1)
    expect(calls).toEqual(['a', 'b'])
  })
})
