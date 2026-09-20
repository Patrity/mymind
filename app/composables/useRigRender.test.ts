import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRigRender } from './useRigRender'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useRigRender clock', () => {
  it('counts up in 250ms steps while running', () => {
    const { elapsedMs, startClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(1000)
    expect(elapsedMs.value).toBe(1000)
  })

  it('reports queued only after 4s — the rig serves one request at a time', () => {
    const { queued, startClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(4000)
    expect(queued.value).toBe(false)
    vi.advanceTimersByTime(250)
    expect(queued.value).toBe(true)
  })

  it('stops counting after stopClock', () => {
    const { elapsedMs, startClock, stopClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(500)
    stopClock()
    vi.advanceTimersByTime(5000)
    expect(elapsedMs.value).toBe(500)
  })

  it('restarts from zero — a second render must not inherit the first one s clock', () => {
    const { elapsedMs, startClock, stopClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(1000)
    stopClock()
    startClock()
    expect(elapsedMs.value).toBe(0)
  })
})
