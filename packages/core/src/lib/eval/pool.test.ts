import { describe, it, expect } from 'vitest'
import { createEvalPool, evalShareOf, EvalSlotAbortedError } from './pool'

describe('evalShareOf', () => {
  it('floor(maxInFlight / 2), at least 1; unset → half the default pool', () => {
    expect(evalShareOf(8)).toBe(4)
    expect(evalShareOf(5)).toBe(2)
    expect(evalShareOf(2)).toBe(1)
    expect(evalShareOf(1)).toBe(1)
    expect(evalShareOf(undefined)).toBe(3) // DEFAULT_MAX_IN_FLIGHT 6
    expect(evalShareOf(0)).toBe(3)
  })
})

describe('createEvalPool', () => {
  it('never lets more than `cap` holders of one key in; a release lets the next waiter in (FIFO)', async () => {
    const pool = createEvalPool()
    const r1 = await pool.acquire('m', 2)
    const r2 = await pool.acquire('m', 2)
    expect(pool.inUse('m')).toBe(2)
    const order: string[] = []
    const w3 = pool.acquire('m', 2).then((r) => { order.push('3'); return r })
    const w4 = pool.acquire('m', 2).then((r) => { order.push('4'); return r })
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual([])
    r1()
    const r3 = await w3
    expect(order).toEqual(['3'])
    expect(pool.inUse('m')).toBe(2)
    r1() // idempotent: a second call frees nothing
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual(['3'])
    r2()
    const r4 = await w4
    expect(order).toEqual(['3', '4'])
    r3(); r4()
    expect(pool.inUse('m')).toBe(0)
  })

  it('keys are independent', async () => {
    const pool = createEvalPool()
    await pool.acquire('a', 1)
    const b = await pool.acquire('b', 1)
    expect(pool.inUse('b')).toBe(1)
    b()
  })

  it('an aborted waiter rejects and does not take a slot', async () => {
    const pool = createEvalPool()
    const r1 = await pool.acquire('m', 1)
    const ac = new AbortController()
    const waiting = pool.acquire('m', 1, ac.signal)
    ac.abort()
    await expect(waiting).rejects.toBeInstanceOf(EvalSlotAbortedError)
    r1()
    expect(pool.inUse('m')).toBe(0)
    const r2 = await pool.acquire('m', 1)
    expect(pool.inUse('m')).toBe(1)
    r2()
    await expect(pool.acquire('m', 1, AbortSignal.abort())).rejects.toBeInstanceOf(EvalSlotAbortedError)
  })
})
