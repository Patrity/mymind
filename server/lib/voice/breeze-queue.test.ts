import { describe, it, expect } from 'vitest'
import { createBreezeQueue } from './breeze-queue'

const tick = () => new Promise(r => setTimeout(r, 0))

describe('createBreezeQueue', () => {
  it('grants the first acquire immediately', async () => {
    const q = createBreezeQueue()
    const release = await q.acquire('studio')
    expect(typeof release).toBe('function')
    release()
  })

  it('serialises: a second acquire waits until the first releases', async () => {
    const q = createBreezeQueue()
    const order: string[] = []
    const r1 = await q.acquire('studio')
    order.push('first-held')
    let r2!: () => void
    const second = q.acquire('studio').then(r => { order.push('second-granted'); r2 = r })
    await tick()
    expect(order).toEqual(['first-held'])   // still blocked
    r1()
    await second
    expect(order).toEqual(['first-held', 'second-granted'])
    r2()
  })

  // The whole point of the priority: auditioning a voice in the studio must never
  // stall a live conversation behind it.
  it('grants agent before studio regardless of arrival order', async () => {
    const q = createBreezeQueue()
    const granted: string[] = []
    const r1 = await q.acquire('agent')            // holds the slot
    const s = q.acquire('studio').then(r => { granted.push('studio'); r() })
    await tick()
    const a = q.acquire('agent').then(r => { granted.push('agent'); r() })
    await tick()
    r1()
    await Promise.all([s, a])
    expect(granted).toEqual(['agent', 'studio'])
  })

  it('keeps FIFO order within the same priority', async () => {
    const q = createBreezeQueue()
    const granted: number[] = []
    const r1 = await q.acquire('studio')
    const waiters = [1, 2, 3].map(n => q.acquire('studio').then(r => { granted.push(n); r() }))
    await tick()
    r1()
    await Promise.all(waiters)
    expect(granted).toEqual([1, 2, 3])
  })

  it('reports depth of waiters', async () => {
    const q = createBreezeQueue()
    const r1 = await q.acquire('studio')
    expect(q.depth).toBe(0)
    const w = q.acquire('studio')
    await tick()
    expect(q.depth).toBe(1)
    r1()
    ;(await w)()
    expect(q.depth).toBe(0)
  })

  it('a waiter aborted before being granted rejects and does not consume the slot', async () => {
    const q = createBreezeQueue()
    const ac = new AbortController()
    const r1 = await q.acquire('studio')
    const rejected = q.acquire('studio', ac.signal)
    await tick()
    ac.abort()
    await expect(rejected).rejects.toThrow()
    const after = q.acquire('studio')
    r1()
    const r = await after            // must be grantable, i.e. the aborted waiter was removed
    expect(typeof r).toBe('function')
    r()
  })

  it('releasing twice does not hand the slot out twice', async () => {
    const q = createBreezeQueue()
    const r1 = await q.acquire('studio')
    const granted: number[] = []
    const w1 = q.acquire('studio').then(r => { granted.push(1); return r })
    const w2 = q.acquire('studio').then(r => { granted.push(2); return r })
    await tick()
    r1(); r1()                       // double release
    await tick()
    expect(granted).toEqual([1])     // w2 still waiting
    ;(await w1)()
    ;(await w2)()
  })
})
